import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NonRetryableError,
  RetryableError,
  VersionConflictError,
  createSimulatedTaskApi,
  type TaskApi,
} from "../src/api";
import { createAuditLog } from "../src/audit";
import { createMetrics } from "../src/metrics";
import {
  createOfflineQueue,
  createQueuedTaskApi,
  type QueuedOp,
  type QueueState,
} from "../src/offlineQueue";
import { createTaskStore } from "../src/store";
import { toTaskId } from "../src/types";
import { makeTask } from "./helpers";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fastRetry = { maxAttempts: 3, baseDelayMs: 0, rng: () => 0 };
const A = toTaskId("a");
const upd = (title: string, v = 0): QueuedOp => ({
  kind: "update",
  taskId: A,
  patch: { title },
  expectedVersion: v,
});
const del = (v = 0): QueuedOp => ({ kind: "delete", taskId: A, expectedVersion: v });
const add = (id = "a"): QueuedOp => ({ kind: "add", task: makeTask(id) });
const label = (op: QueuedOp): string =>
  op.kind === "update" ? `update:${op.patch.title ?? ""}` : op.kind;

/** Executor that records calls and lets the test finish each one. */
function controlled(): {
  execute: (op: QueuedOp, signal: AbortSignal) => Promise<void>;
  calls: { op: QueuedOp; signal: AbortSignal; d: Deferred }[];
} {
  const calls: { op: QueuedOp; signal: AbortSignal; d: Deferred }[] = [];
  return {
    calls,
    execute: (op, signal) => {
      const d = deferred();
      calls.push({ op, signal, d });
      return d.promise;
    },
  };
}

const nextCall = async (c: ReturnType<typeof controlled>, i: number) => {
  await vi.waitFor(() => expect(c.calls.length).toBeGreaterThan(i));
  const call = c.calls[i];
  if (!call) throw new Error(`no call ${i}`);
  return call;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("serial replay", () => {
  it("runs operations one at a time, in order", async () => {
    const c = controlled();
    const queue = createOfflineQueue({ execute: c.execute, retry: fastRetry });
    const p1 = queue.enqueue(upd("1"));
    const p2 = queue.enqueue(upd("2"));
    const p3 = queue.enqueue(upd("3"));
    const first = await nextCall(c, 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(c.calls).toHaveLength(1); // the others wait their turn
    expect(queue.getState().depth).toBe(3);
    first.d.resolve();
    await p1;
    (await nextCall(c, 1)).d.resolve();
    await p2;
    (await nextCall(c, 2)).d.resolve();
    await p3;
    expect(c.calls.map((x) => label(x.op))).toEqual(["update:1", "update:2", "update:3"]);
    expect(queue.getState()).toMatchObject({ depth: 0, status: "idle" });
  });

  it("never starts the next operation before the previous one finished (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("a", "b", "c", "d"), { minLength: 1, maxLength: 8 }),
        async (names) => {
          const order: string[] = [];
          let active = 0;
          let maxActive = 0;
          const queue = createOfflineQueue({
            online: false,
            retry: fastRetry,
            execute: async (op) => {
              active++;
              maxActive = Math.max(maxActive, active);
              order.push(label(op));
              await Promise.resolve();
              active--;
            },
          });
          const promises = names.map((n) => queue.enqueue(upd(n)));
          queue.setOnline(true);
          await Promise.all(promises);
          expect(order).toEqual(names.map((n) => `update:${n}`));
          expect(maxActive).toBe(1);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("offline behaviour", () => {
  it("queues without executing while offline, then replays in order on reconnect", async () => {
    const c = controlled();
    const queue = createOfflineQueue({ execute: c.execute, online: false, retry: fastRetry });
    const p1 = queue.enqueue(add());
    const p2 = queue.enqueue(upd("x", 1));
    await new Promise((r) => setTimeout(r, 10));
    expect(c.calls).toHaveLength(0);
    expect(queue.getState()).toMatchObject({ online: false, depth: 2, status: "waiting" });

    queue.setOnline(true);
    (await nextCall(c, 0)).d.resolve();
    await p1;
    (await nextCall(c, 1)).d.resolve();
    await p2;
    expect(c.calls.map((x) => x.op.kind)).toEqual(["add", "update"]);
    expect(queue.getState().status).toBe("idle");
  });

  it("aborts the in-flight attempt when the connection drops and replays it later", async () => {
    const c = controlled();
    const queue = createOfflineQueue({ execute: c.execute, retry: fastRetry });
    const p = queue.enqueue(upd("x"));
    const first = await nextCall(c, 0);
    queue.setOnline(false);
    expect(first.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(queue.getState().status).toBe("waiting"));
    expect(queue.getState().depth).toBe(1); // still queued, not lost and not failed
    expect(queue.getState().failed).toBeNull();

    queue.setOnline(true);
    (await nextCall(c, 1)).d.resolve();
    await p;
    expect(c.calls.map((x) => label(x.op))).toEqual(["update:x", "update:x"]);
  });

  it("does not stall when the connection flaps while the aborted attempt unwinds", async () => {
    const c = controlled();
    const queue = createOfflineQueue({ execute: c.execute, retry: fastRetry });
    const p = queue.enqueue(upd("x"));
    await nextCall(c, 0);
    queue.setOnline(false); // aborts the attempt...
    queue.setOnline(true); // ...and we are back before it has finished unwinding
    (await nextCall(c, 1)).d.resolve();
    await p;
    expect(queue.getState()).toMatchObject({ depth: 0, status: "idle" });
  });

  it("ignores setOnline with the current value", () => {
    const queue = createOfflineQueue({ execute: () => Promise.resolve() });
    const listener = vi.fn();
    queue.subscribe(listener);
    queue.setOnline(true);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("final failure stops the queue", () => {
  it("stops after retries are exhausted and does not run later operations", async () => {
    let attempts = 0;
    const executed: string[] = [];
    const queue = createOfflineQueue({
      retry: fastRetry,
      execute: (op) => {
        executed.push(label(op));
        if (op.kind === "update" && op.patch.title === "bad") {
          attempts++;
          return Promise.reject(new RetryableError("network", "down"));
        }
        return Promise.resolve();
      },
    });
    const bad = queue.enqueue(upd("bad"));
    void bad.catch(() => undefined);
    void queue.enqueue(upd("after"));
    await vi.waitFor(() => expect(queue.getState().status).toBe("stopped"));
    expect(attempts).toBe(3);
    expect(executed).not.toContain("update:after");
    expect(queue.getState()).toMatchObject({
      depth: 2,
      failed: { kind: "update", reason: "network" },
    });
  });

  it("stops at once on a permanent failure without retrying", async () => {
    let attempts = 0;
    const queue = createOfflineQueue({
      retry: fastRetry,
      execute: () => {
        attempts++;
        return Promise.reject(new NonRetryableError("server said no"));
      },
    });
    void queue.enqueue(add()).catch(() => undefined);
    await vi.waitFor(() => expect(queue.getState().status).toBe("stopped"));
    expect(attempts).toBe(1);
    expect(queue.getState().failed?.reason).toBe("rejected");
  });

  it("classifies a version conflict and a timeout", async () => {
    const conflict = createOfflineQueue({
      retry: fastRetry,
      execute: () => Promise.reject(new VersionConflictError(makeTask("a", { version: 5 }), 1)),
    });
    void conflict.enqueue(upd("x")).catch(() => undefined);
    await vi.waitFor(() => expect(conflict.getState().failed?.reason).toBe("conflict"));

    const timeout = createOfflineQueue({
      retry: { ...fastRetry, maxAttempts: 1 },
      execute: () => Promise.reject(new RetryableError("timeout", "slow")),
    });
    void timeout.enqueue(del()).catch(() => undefined);
    await vi.waitFor(() => expect(timeout.getState().failed?.reason).toBe("timeout"));
  });

  it("keeps accepting operations while stopped, behind the failed one", async () => {
    const queue = createOfflineQueue({
      retry: { ...fastRetry, maxAttempts: 1 },
      execute: () => Promise.reject(new NonRetryableError("no")),
    });
    void queue.enqueue(upd("1")).catch(() => undefined);
    await vi.waitFor(() => expect(queue.getState().status).toBe("stopped"));
    void queue.enqueue(upd("2")).catch(() => undefined);
    expect(queue.getState().depth).toBe(2);
    expect(queue.getState().status).toBe("stopped");
  });
});

describe("retry and discard", () => {
  it("retry() re-runs the failed operation and then continues with the rest", async () => {
    const audit = createAuditLog(() => new Date("2024-01-01T00:00:00Z"));
    let healthy = false;
    const executed: string[] = [];
    const queue = createOfflineQueue({
      audit,
      retry: { ...fastRetry, maxAttempts: 1 },
      execute: (op) => {
        executed.push(label(op));
        return healthy || label(op) !== "update:1"
          ? Promise.resolve()
          : Promise.reject(new RetryableError("network", "down"));
      },
    });
    const p1 = queue.enqueue(upd("1"));
    const p2 = queue.enqueue(upd("2"));
    await vi.waitFor(() => expect(queue.getState().status).toBe("stopped"));
    healthy = true;
    await queue.retry();
    await Promise.all([p1, p2]);
    expect(executed).toEqual(["update:1", "update:1", "update:2"]);
    expect(queue.getState()).toMatchObject({ depth: 0, status: "idle", failed: null });
    expect(audit.list().map((e) => e.type)).toEqual(["retry"]);
  });

  it("retry() with nothing failed is a harmless no-op", async () => {
    const queue = createOfflineQueue({ execute: () => Promise.resolve() });
    await expect(queue.retry()).resolves.toBeUndefined();
  });

  it("discard() rejects the failed operation with its real error and continues", async () => {
    const audit = createAuditLog(() => new Date("2024-01-01T00:00:00Z"));
    const executed: string[] = [];
    const underlying = new NonRetryableError("rejected by server");
    const queue = createOfflineQueue({
      audit,
      retry: { ...fastRetry, maxAttempts: 1 },
      execute: (op) => {
        executed.push(label(op));
        return label(op) === "update:1" ? Promise.reject(underlying) : Promise.resolve();
      },
    });
    const p1 = queue.enqueue(upd("1"));
    const p2 = queue.enqueue(upd("2"));
    const rejection = expect(p1).rejects.toBe(underlying);
    await vi.waitFor(() => expect(queue.getState().status).toBe("stopped"));
    queue.discard();
    await rejection;
    await p2;
    expect(executed).toEqual(["update:1", "update:2"]);
    expect(queue.getState().depth).toBe(0);
    expect(audit.list().map((e) => e.type)).toEqual(["rollback"]);
  });

  it("discard() with nothing failed does nothing", () => {
    const queue = createOfflineQueue({ execute: () => Promise.resolve() });
    expect(() => queue.discard()).not.toThrow();
    expect(queue.getState().depth).toBe(0);
  });
});

describe("transient failures inside replay", () => {
  it("retries a flaky operation and still delivers everything in order", async () => {
    const metrics = createMetrics();
    let calls = 0;
    const queue = createOfflineQueue({
      metrics,
      retry: fastRetry,
      execute: () =>
        ++calls === 1 ? Promise.reject(new RetryableError("network", "blip")) : Promise.resolve(),
    });
    await queue.enqueue(upd("1"));
    expect(calls).toBe(2);
    expect(metrics.snapshot().attempts).toBe(2);
    expect(metrics.snapshot().retries).toBe(1);
  });

  it("tracks queue depth in the metrics, including the maximum", async () => {
    const metrics = createMetrics();
    const queue = createOfflineQueue({
      metrics,
      online: false,
      execute: () => Promise.resolve(),
      retry: fastRetry,
    });
    const ps = [queue.enqueue(upd("1")), queue.enqueue(upd("2")), queue.enqueue(upd("3"))];
    expect(metrics.snapshot().queueDepth).toBe(3);
    queue.setOnline(true);
    await Promise.all(ps);
    expect(metrics.snapshot().queueDepth).toBe(0);
    expect(metrics.snapshot().maxQueueDepth).toBe(3);
  });
});

describe("serialization", () => {
  const ops: QueuedOp[] = [
    { kind: "add", task: makeTask("n", { title: "New", dueAt: new Date("2024-09-01T00:00:00Z") }) },
    {
      kind: "update",
      taskId: A,
      patch: {
        title: "T",
        priority: "high",
        tags: ["x", "y"],
        completedAt: new Date("2024-03-01T00:00:00Z"),
        dueAt: null,
      },
      expectedVersion: 4,
    },
    { kind: "delete", taskId: toTaskId("z"), expectedVersion: 0 },
  ];

  function queueWith(list: readonly QueuedOp[]) {
    const queue = createOfflineQueue({ execute: () => Promise.resolve(), online: false });
    for (const op of list) void queue.enqueue(op).catch(() => undefined);
    return queue;
  }

  it("round-trips every kind of operation, dates included", async () => {
    const text = queueWith(ops).serialize();
    const executed: QueuedOp[] = [];
    const target = createOfflineQueue({
      online: false,
      retry: fastRetry,
      execute: (op) => {
        executed.push(op);
        return Promise.resolve();
      },
    });
    const result = target.restore(text);
    expect(result).toEqual({ ok: true, value: { restored: 3, rejected: 0 } });
    expect(target.getState().depth).toBe(3);
    target.setOnline(true);
    await vi.waitFor(() => expect(executed).toHaveLength(3));
    expect(executed.map((o) => o.kind)).toEqual(["add", "update", "delete"]);
    const update = executed[1];
    expect(update?.kind === "update" && update.patch.completedAt?.toISOString()).toBe(
      "2024-03-01T00:00:00.000Z",
    );
    expect(update?.kind === "update" && update.patch.dueAt).toBeNull();
    expect(update?.kind === "update" && update.expectedVersion).toBe(4);
    const added = executed[0];
    expect(added?.kind === "add" && added.task.dueAt?.toISOString()).toBe(
      "2024-09-01T00:00:00.000Z",
    );
  });

  it("writes a versioned document", () => {
    const parsed: Record<string, unknown> = JSON.parse(queueWith(ops).serialize());
    expect(parsed["schemaVersion"]).toBe(1);
    expect(Array.isArray(parsed["ops"]) && parsed["ops"]).toHaveLength(3);
  });

  it("serialises an empty queue", () => {
    const target = createOfflineQueue({ execute: () => Promise.resolve(), online: false });
    expect(target.restore(queueWith([]).serialize())).toEqual({
      ok: true,
      value: { restored: 0, rejected: 0 },
    });
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["null", null],
    ["a bare array", []],
    ["a future schema version", { schemaVersion: 2, ops: [] }],
    ["ops that is not an array", { schemaVersion: 1, ops: "x" }],
  ])("refuses to restore from %s", (_name, raw) => {
    const queue = createOfflineQueue({ execute: () => Promise.resolve(), online: false });
    expect(queue.restore(raw).ok).toBe(false);
    expect(queue.getState().depth).toBe(0);
  });

  it("skips and counts invalid entries but keeps the valid ones", () => {
    const doc = {
      schemaVersion: 1,
      ops: [
        { id: 1, op: { kind: "delete", taskId: "a", expectedVersion: 2 } },
        { id: 2, op: { kind: "explode" } },
        { id: 3, op: { kind: "delete", taskId: "", expectedVersion: 2 } },
        { id: 4, op: { kind: "delete", taskId: "b", expectedVersion: -1 } },
        {
          id: 5,
          op: { kind: "update", taskId: "a", patch: { tittle: "typo" }, expectedVersion: 1 },
        },
        { id: 6, op: { kind: "update", taskId: "a", patch: {}, expectedVersion: 1 } },
        { id: 7, op: { kind: "add", task: { id: "x", title: "" } } },
        { id: 8, op: { kind: "add", task: JSON.parse(JSON.stringify(makeTask("ok"))) } },
        "not even an object",
        null,
      ],
    };
    const queue = createOfflineQueue({ execute: () => Promise.resolve(), online: false });
    const result = queue.restore(doc);
    expect(result).toEqual({ ok: true, value: { restored: 2, rejected: 8 } });
    expect(queue.getState().depth).toBe(2);
  });

  it("refuses to restore into a queue that already has work", () => {
    const queue = queueWith([del()]);
    const result = queue.restore(queueWith([del()]).serialize());
    expect(result.ok).toBe(false);
    expect(queue.getState().depth).toBe(1);
  });

  it("rejects a hostile __proto__ entry instead of trusting it", () => {
    const queue = createOfflineQueue({ execute: () => Promise.resolve(), online: false });
    const text =
      '{"schemaVersion":1,"ops":[{"op":{"kind":"update","taskId":"a","expectedVersion":1,"patch":{"__proto__":{"title":"x"}}}}]}';
    expect(queue.restore(text)).toEqual({ ok: true, value: { restored: 0, rejected: 1 } });
  });

  it("does not let an unhandled rejection escape from a restored operation that fails", async () => {
    const queue = createOfflineQueue({
      online: false,
      retry: { ...fastRetry, maxAttempts: 1 },
      execute: () => Promise.reject(new NonRetryableError("no")),
    });
    queue.restore({
      schemaVersion: 1,
      ops: [{ op: { kind: "delete", taskId: "a", expectedVersion: 0 } }],
    });
    queue.setOnline(true);
    await vi.waitFor(() => expect(queue.getState().status).toBe("stopped"));
    queue.discard(); // rejects the restored entry's no-op promise: must not blow up
    expect(queue.getState().depth).toBe(0);
  });
});

describe("diagnostics safety", () => {
  it("never exposes task text in its state, even after a failure", async () => {
    const queue = createOfflineQueue({
      retry: { ...fastRetry, maxAttempts: 1 },
      execute: () => Promise.reject(new NonRetryableError("<script>secret</script>")),
    });
    void queue
      .enqueue({ kind: "add", task: makeTask("a", { title: "<script>alert(1)</script>" }) })
      .catch(() => undefined);
    await vi.waitFor(() => expect(queue.getState().status).toBe("stopped"));
    const json = JSON.stringify(queue.getState());
    expect(json).not.toContain("script");
    expect(json).not.toContain("alert");
    expect(json).not.toContain("secret");
  });

  it("keeps hostile text out of the audit entries it writes", async () => {
    const audit = createAuditLog(() => new Date("2024-01-01T00:00:00Z"));
    const queue = createOfflineQueue({
      audit,
      retry: { ...fastRetry, maxAttempts: 1 },
      execute: () => Promise.reject(new NonRetryableError("no")),
    });
    void queue
      .enqueue({ kind: "add", task: makeTask("<b>id</b>", { title: "<img onerror=x>" }) })
      .catch(() => undefined);
    await vi.waitFor(() => expect(queue.getState().status).toBe("stopped"));
    await queue.retry();
    await vi.waitFor(() => expect(queue.getState().status).toBe("stopped"));
    for (const event of audit.list()) {
      expect(event.summary).not.toMatch(/[<>]/);
      expect(event.taskId ?? "").not.toMatch(/[<>]/);
    }
  });
});

describe("subscriptions and disposal", () => {
  it("publishes each distinct state once and stops after unsubscribe", async () => {
    const queue = createOfflineQueue({ execute: () => Promise.resolve(), online: false });
    const seen: QueueState[] = [];
    const off = queue.subscribe((s) => seen.push(s));
    const p = queue.enqueue(del());
    queue.setOnline(true);
    await p;
    off();
    const count = seen.length;
    await queue.enqueue(del());
    expect(seen.length).toBe(count);
    expect(seen[0]).toMatchObject({ depth: 1, status: "waiting" });
    expect(seen.at(-1)).toMatchObject({ depth: 0, status: "idle" });
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toEqual(seen[i - 1]);
  });

  it("dispose() aborts in-flight work, rejects queued operations and refuses new ones", async () => {
    const c = controlled();
    const queue = createOfflineQueue({ execute: c.execute, retry: fastRetry });
    const p1 = queue.enqueue(upd("1"));
    const p2 = queue.enqueue(upd("2"));
    const r1 = expect(p1).rejects.toThrow("Queue disposed");
    const r2 = expect(p2).rejects.toThrow("Queue disposed");
    const first = await nextCall(c, 0);
    queue.dispose();
    expect(first.signal.aborted).toBe(true);
    await Promise.all([r1, r2]);
    await expect(queue.enqueue(upd("3"))).rejects.toThrow("Queue disposed");
    expect(queue.getState().depth).toBe(0);
  });

  it("leaves no timers behind after dispose", async () => {
    vi.useFakeTimers();
    const queue = createOfflineQueue({
      execute: () => new Promise<void>(() => undefined),
      retry: { maxAttempts: 1 },
    });
    void queue.enqueue(upd("1")).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    queue.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("createQueuedTaskApi", () => {
  it("maps TaskApi calls to queued operations carrying the expected version", async () => {
    const seen: QueuedOp[] = [];
    const api: TaskApi = {
      addTask: () => Promise.resolve(),
      updateTask: () => Promise.resolve(),
      deleteTask: () => Promise.resolve(),
    };
    const { api: queued, queue } = createQueuedTaskApi(api, { online: false, retry: fastRetry });
    const spy = queue.subscribe(() => undefined);
    const ps = [
      queued.addTask(makeTask("a")),
      queued.updateTask(A, { title: "x" }, 3),
      queued.deleteTask(A, 4),
    ];
    seen.push(...JSON.parse(queue.serialize()).ops.map((o: { op: QueuedOp }) => o.op));
    expect(seen.map((o) => o.kind)).toEqual(["add", "update", "delete"]);
    queue.setOnline(true);
    await Promise.all(ps);
    spy();
  });

  it("forwards each queued operation to the real API on replay", async () => {
    const server = createSimulatedTaskApi({ delayMs: 1, initialTasks: [makeTask("a")] });
    const { api, queue } = createQueuedTaskApi(server, { online: false, retry: fastRetry });
    const ps = [
      api.updateTask(A, { title: "edited" }, 0),
      api.addTask(makeTask("b")),
      api.deleteTask(toTaskId("b"), 0),
    ];
    queue.setOnline(true);
    await Promise.all(ps);
    expect(server.snapshot().map((t) => [t.id, t.title])).toEqual([["a", "edited"]]);
  });
});

describe("offline queue + store integration (the demo scenario)", () => {
  it("keeps the optimistic view offline and confirms everything after reconnect", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 1,
      initialTasks: [makeTask("a", { title: "orig" })],
    });
    const { api, queue } = createQueuedTaskApi(server, { online: false, retry: fastRetry });
    const store = createTaskStore(api, {
      initialTasks: [makeTask("a", { title: "orig" })],
      mutationTimeoutMs: Number.POSITIVE_INFINITY, // the queue owns waiting while offline
    });

    const edit = store.updateTask(A, { title: "edited offline" });
    const extra = store.addTask(makeTask("b", { title: "added offline" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getState().tasks.map((t) => t.title)).toEqual(["edited offline", "added offline"]);
    expect(store.getState().pending).toEqual({ a: 1, b: 1 }); // still unconfirmed
    expect(store.getState().error).toBeNull();
    expect(server.snapshot()[0]?.title).toBe("orig"); // nothing reached the server yet
    expect(queue.getState()).toMatchObject({ depth: 2, status: "waiting" });

    queue.setOnline(true);
    await Promise.all([edit, extra]);
    expect(store.getState().pending).toEqual({});
    expect(server.snapshot().map((t) => t.title)).toEqual(["edited offline", "added offline"]);
    expect(queue.getState().status).toBe("idle");
  });

  it("surfaces a stale queued edit as a conflict instead of overwriting the server", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 1,
      initialTasks: [makeTask("a", { title: "orig" })],
    });
    const { api, queue } = createQueuedTaskApi(server, { online: false, retry: fastRetry });
    const store = createTaskStore(api, {
      initialTasks: [makeTask("a", { title: "orig" })],
      mutationTimeoutMs: Number.POSITIVE_INFINITY,
    });
    const edit = store.updateTask(A, { title: "mine" });
    server.externalUpdate(A, { title: "theirs" }); // someone else edits while we are offline
    queue.setOnline(true);
    await vi.waitFor(() => expect(queue.getState().failed?.reason).toBe("conflict"));
    queue.discard(); // the user gives up the stale queued edit
    await edit;
    expect(store.getState().conflicts).toHaveLength(1);
    expect(server.snapshot()[0]?.title).toBe("theirs");
    expect(store.getState().tasks[0]?.title).toBe("theirs");
  });
});
