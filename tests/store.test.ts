import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NonRetryableError,
  RetryableError,
  createSimulatedTaskApi,
  type TaskApi,
} from "../src/api";
import { createAuditLog } from "../src/audit";
import { createMetrics } from "../src/metrics";
import { createTaskStore, taskReducer } from "../src/store";
import { type Task, type TaskId, toTaskId } from "../src/types";
import { makeTask } from "./helpers";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (e: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Call {
  op: "add" | "update" | "delete";
  id: string;
  expected: number;
  d: Deferred;
}

/** API where the test decides when, and how, each request finishes. */
function recordingApi(): { api: TaskApi; calls: Call[]; at: (i: number) => Call } {
  const calls: Call[] = [];
  const record = (op: Call["op"], id: string, expected: number): Promise<void> => {
    const d = deferred();
    calls.push({ op, id, expected, d });
    return d.promise;
  };
  const api: TaskApi = {
    addTask: (task) => record("add", task.id, task.version),
    updateTask: (id, _patch, expected) => record("update", id, expected),
    deleteTask: (id, expected) => record("delete", id, expected),
  };
  const at = (i: number): Call => {
    const call = calls[i];
    if (!call) throw new Error(`no call #${i}`);
    return call;
  };
  return { api, calls, at };
}

const instantApi: TaskApi = {
  addTask: () => Promise.resolve(),
  updateTask: () => Promise.resolve(),
  deleteTask: () => Promise.resolve(),
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const A = toTaskId("a");
const B = toTaskId("b");
const title = (tasks: readonly Task[], id: TaskId): string | undefined =>
  tasks.find((t) => t.id === id)?.title;
const T1 = new Date("2024-05-01T10:00:00.000Z");
const T2 = new Date("2024-05-01T11:00:00.000Z");

describe("taskReducer", () => {
  const base = [makeTask("a", { version: 1 }), makeTask("b")];

  it("adds, ignoring an id that already exists", () => {
    expect(taskReducer(base, { type: "add", task: makeTask("c") })).toHaveLength(3);
    expect(taskReducer(base, { type: "add", task: makeTask("a") })).toBe(base);
  });

  it("updates only the target, bumping version and stamping updatedAt", () => {
    const out = taskReducer(base, { type: "update", id: A, patch: { title: "new" }, at: T1 });
    expect(out[0]).toMatchObject({ title: "new", version: 2 });
    expect(out[0]?.updatedAt).toBe(T1);
    expect(out[1]).toBe(base[1]);
  });

  it("toggles completion on and off, bumping the version each time", () => {
    const done = taskReducer(base, { type: "toggle", id: A, completed: true, at: T1 });
    expect(done[0]?.completedAt).toBe(T1);
    expect(done[0]?.version).toBe(2);
    const undone = taskReducer(done, { type: "toggle", id: A, completed: false, at: T2 });
    expect(undone[0]?.completedAt).toBeNull();
    expect(undone[0]?.version).toBe(3);
  });

  it("deletes without mutating the input", () => {
    const frozen = Object.freeze([...base]);
    expect(taskReducer(frozen, { type: "delete", id: A })).toHaveLength(1);
    expect(frozen).toHaveLength(2);
  });

  it("sync replaces an existing task in place, or appends a new one", () => {
    const server = makeTask("a", { title: "server", version: 9 });
    const replaced = taskReducer(base, { type: "sync", task: server });
    expect(replaced[0]).toBe(server);
    expect(replaced).toHaveLength(2);
    expect(taskReducer(base, { type: "sync", task: makeTask("z") })).toHaveLength(3);
  });

  it("throws on an unknown action type", () => {
    // @ts-expect-error not a valid TaskAction
    expect(() => taskReducer(base, { type: "explode" })).toThrow("Unexpected value");
  });
});

describe("optimistic updates and rollback", () => {
  it("applies an add before the API answers, tracks it as pending, then confirms", async () => {
    const { api, at } = recordingApi();
    const store = createTaskStore(api);
    const p = store.addTask(makeTask("a"));
    expect(store.getState().tasks).toHaveLength(1);
    expect(store.getState().pending).toEqual({ a: 1 });
    await tick();
    at(0).d.resolve();
    await p;
    expect(store.getState().pending).toEqual({});
    expect(store.getState().error).toBeNull();
    expect(store.getState().tasks).toHaveLength(1);
  });

  it("rolls back a failed add and surfaces the error", async () => {
    const { api, at } = recordingApi();
    const store = createTaskStore(api);
    const p = store.addTask(makeTask("a"));
    await tick();
    at(0).d.reject(new RetryableError("network", "offline"));
    await p;
    expect(store.getState().tasks).toHaveLength(0);
    expect(store.getState().error).toBe("Could not add task: offline");
    expect(store.getState().pending).toEqual({});
  });

  it("rolls back a failed update to the previous title", async () => {
    const { api, at } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a", { title: "old" })] });
    const p = store.updateTask(A, { title: "new" });
    expect(title(store.getState().tasks, A)).toBe("new");
    await tick();
    at(0).d.reject(new Error("nope"));
    await p;
    expect(title(store.getState().tasks, A)).toBe("old");
  });

  it("rolls back a failed delete, restoring the task", async () => {
    const { api, at } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a"), makeTask("b")] });
    const p = store.deleteTask(A);
    expect(store.getState().tasks.map((t) => t.id)).toEqual(["b"]);
    await tick();
    at(0).d.reject(new Error("nope"));
    await p;
    expect(store.getState().tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("toggles with the injected clock and rolls back on failure", async () => {
    const { api, at } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a")], now: () => T1 });
    const p = store.toggleComplete(A);
    expect(store.getState().tasks[0]?.completedAt).toBe(T1);
    expect(store.getState().tasks[0]?.version).toBe(1);
    await tick();
    at(0).d.reject(new Error("nope"));
    await p;
    expect(store.getState().tasks[0]?.completedAt).toBeNull();
    expect(store.getState().tasks[0]?.version).toBe(0);
  });

  it("tracks pending separately per task and counts several for one task", async () => {
    const { api } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a"), makeTask("b")] });
    void store.updateTask(A, { title: "1" });
    void store.updateTask(A, { title: "2" });
    void store.updateTask(B, { title: "x" });
    expect(store.getState().pending).toEqual({ a: 2, b: 1 });
  });

  it("skips the API entirely for unknown ids and duplicate adds", async () => {
    const { api, calls } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a")] });
    await store.updateTask(toTaskId("zzz"), { title: "x" });
    await store.toggleComplete(toTaskId("zzz"));
    await store.deleteTask(toTaskId("zzz"));
    await store.addTask(makeTask("a"));
    await tick();
    expect(calls).toHaveLength(0);
  });

  it("clearError resets the error", async () => {
    const { api, at } = recordingApi();
    const store = createTaskStore(api);
    const p = store.addTask(makeTask("a"));
    await tick();
    at(0).d.reject(new Error("x"));
    await p;
    expect(store.getState().error).not.toBeNull();
    store.clearError();
    expect(store.getState().error).toBeNull();
  });
});

describe("per-task operation sequencing (ST5)", () => {
  it("sends a second edit to the same task only after the first has finished", async () => {
    const { api, calls, at } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a")] });
    const p1 = store.updateTask(A, { title: "first" });
    const p2 = store.updateTask(A, { title: "second" });
    await tick();
    expect(calls).toHaveLength(1); // the second is queued behind the first
    expect(title(store.getState().tasks, A)).toBe("second"); // but the UI is already optimistic
    at(0).d.resolve();
    await tick();
    expect(calls).toHaveLength(2);
    at(1).d.resolve();
    await Promise.all([p1, p2]);
  });

  it("sends calls for different tasks in parallel", async () => {
    const { api, calls } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a"), makeTask("b")] });
    void store.updateTask(A, { title: "x" });
    void store.updateTask(B, { title: "y" });
    await tick();
    expect(calls.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("carries the version it believes the server holds, advancing after each success", async () => {
    const { api, calls, at } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a", { version: 4 })] });
    const p1 = store.updateTask(A, { title: "1" });
    const p2 = store.updateTask(A, { title: "2" });
    await tick();
    at(0).d.resolve();
    await tick();
    at(1).d.resolve();
    await Promise.all([p1, p2]);
    expect(calls.map((c) => c.expected)).toEqual([4, 5]);
  });

  it("keeps the later edit when the earlier one fails (the queue keeps moving)", async () => {
    const { api, at } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a", { title: "orig" })] });
    const p1 = store.updateTask(A, { title: "first" });
    const p2 = store.updateTask(A, { title: "second" });
    await tick();
    at(0).d.reject(new Error("first failed"));
    await tick();
    at(1).d.resolve();
    await Promise.all([p1, p2]);
    expect(title(store.getState().tasks, A)).toBe("second");
    expect(store.getState().error).toBe("Could not update task: first failed");
    expect(store.getState().pending).toEqual({});
  });

  it("falls back to the older success when the newer edit fails", async () => {
    const { api, at } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a", { title: "orig" })] });
    const p1 = store.updateTask(A, { title: "first" });
    const p2 = store.updateTask(A, { title: "second" });
    await tick();
    at(0).d.resolve();
    await tick();
    at(1).d.reject(new Error("fail"));
    await Promise.all([p1, p2]);
    expect(title(store.getState().tasks, A)).toBe("first");
  });

  it("applies overlapping edits to different fields independently", async () => {
    const { api, at } = recordingApi();
    const store = createTaskStore(api, {
      initialTasks: [makeTask("a", { title: "orig", priority: "low" })],
    });
    const p1 = store.updateTask(A, { title: "T" });
    const p2 = store.updateTask(A, { priority: "high" });
    await tick();
    at(0).d.reject(new Error("fail"));
    await tick();
    at(1).d.resolve();
    await Promise.all([p1, p2]);
    expect(store.getState().tasks[0]).toMatchObject({ title: "orig", priority: "high" });
  });

  it("a hung request for one task never blocks another task", async () => {
    const { api, calls, at } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a"), makeTask("b")] });
    void store.updateTask(A, { title: "hangs" });
    const done = store.updateTask(B, { title: "fine" });
    await tick();
    at(1).d.resolve();
    await done;
    expect(calls).toHaveLength(2);
    expect(title(store.getState().tasks, B)).toBe("fine");
    expect(store.getState().pending).toEqual({ a: 1 });
  });
});

describe("regression ST5: the server ends up in the same state as the UI", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies same-task edits on the server in issue order even when the first is slower", async () => {
    const server = createSimulatedTaskApi({
      initialTasks: [makeTask("a", { title: "orig" })],
      delayMs: () => 100,
    });
    // Make the FIRST request slower than the second by wrapping the server.
    let call = 0;
    const api: TaskApi = {
      addTask: (t) => server.addTask(t),
      deleteTask: (id, v) => server.deleteTask(id, v),
      updateTask: (id, patch, v) => {
        call++;
        return call === 1
          ? new Promise((resolve, reject) => {
              setTimeout(() => server.updateTask(id, patch, v).then(resolve, reject), 300);
            })
          : server.updateTask(id, patch, v);
      },
    };
    const store = createTaskStore(api, { initialTasks: [makeTask("a", { title: "orig" })] });
    const p1 = store.updateTask(A, { title: "first" });
    const p2 = store.updateTask(A, { title: "second" });
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([p1, p2]);
    expect(title(store.getState().tasks, A)).toBe("second");
    expect(server.snapshot()[0]?.title).toBe("second");
    expect(server.snapshot()[0]?.version).toBe(2);
    expect(store.getState().tasks[0]?.version).toBe(2);
  });
});

describe("conflicts", () => {
  it("refuses a stale edit, keeps both sides and never overwrites the server copy", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 5,
      initialTasks: [makeTask("a", { title: "orig" })],
    });
    const metrics = createMetrics();
    const store = createTaskStore(server, {
      initialTasks: [makeTask("a", { title: "orig" })],
      metrics,
    });
    server.externalUpdate(A, { title: "theirs" }); // another client edits first
    await store.updateTask(A, { title: "mine" });
    const state = store.getState();
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0]).toMatchObject({
      taskId: "a",
      intent: "update",
      local: { title: "mine" },
      server: { title: "theirs", version: 1 },
    });
    expect(title(state.tasks, A)).toBe("theirs"); // the refused edit is not shown as applied
    expect(server.snapshot()[0]?.title).toBe("theirs");
    expect(state.error).toContain("changed elsewhere");
    expect(metrics.snapshot().conflicts).toBe(1);
    expect(metrics.snapshot().mutationFailures).toBe(0);
  });

  it("skips queued edits to a conflicted task until the conflict is resolved", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 5,
      initialTasks: [makeTask("a", { title: "orig" })],
    });
    const store = createTaskStore(server, { initialTasks: [makeTask("a", { title: "orig" })] });
    server.externalUpdate(A, { title: "theirs" });
    const p1 = store.updateTask(A, { title: "mine" });
    const p2 = store.updateTask(A, { priority: "high" });
    await Promise.all([p1, p2]);
    expect(server.snapshot()[0]).toMatchObject({ title: "theirs", priority: "medium" });
    expect(store.getState().tasks[0]).toMatchObject({ title: "theirs", priority: "medium" });
    expect(store.getState().conflicts).toHaveLength(1);
  });

  it("'keep mine' replays the refused edit on top of the server copy", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 5,
      initialTasks: [makeTask("a", { title: "orig" })],
    });
    const store = createTaskStore(server, { initialTasks: [makeTask("a", { title: "orig" })] });
    server.externalUpdate(A, { title: "theirs" });
    await store.updateTask(A, { title: "mine" });
    await store.resolveConflict(A, "local");
    expect(store.getState().conflicts).toEqual([]);
    expect(server.snapshot()[0]?.title).toBe("mine");
    expect(server.snapshot()[0]?.version).toBe(2);
    expect(title(store.getState().tasks, A)).toBe("mine");
  });

  it("'keep theirs' just clears the conflict", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 5,
      initialTasks: [makeTask("a", { title: "orig" })],
    });
    const store = createTaskStore(server, { initialTasks: [makeTask("a", { title: "orig" })] });
    server.externalUpdate(A, { title: "theirs" });
    await store.updateTask(A, { title: "mine" });
    await store.resolveConflict(A, "server");
    expect(store.getState().conflicts).toEqual([]);
    expect(server.snapshot()[0]?.title).toBe("theirs");
    expect(title(store.getState().tasks, A)).toBe("theirs");
  });

  it("allows edits again once the conflict is resolved", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 5,
      initialTasks: [makeTask("a", { title: "orig" })],
    });
    const store = createTaskStore(server, { initialTasks: [makeTask("a", { title: "orig" })] });
    server.externalUpdate(A, { title: "theirs" });
    await store.updateTask(A, { title: "mine" });
    await store.resolveConflict(A, "server");
    await store.updateTask(A, { priority: "high" });
    expect(server.snapshot()[0]?.priority).toBe("high");
  });

  it("surfaces a stale DELETE as a conflict and keeps the task", async () => {
    const server = createSimulatedTaskApi({ delayMs: 5, initialTasks: [makeTask("a")] });
    const store = createTaskStore(server, { initialTasks: [makeTask("a")] });
    server.externalUpdate(A, { title: "edited elsewhere" });
    await store.deleteTask(A);
    expect(store.getState().conflicts[0]?.intent).toBe("delete");
    expect(title(store.getState().tasks, A)).toBe("edited elsewhere");
    await store.resolveConflict(A, "local");
    expect(server.snapshot()).toEqual([]);
    expect(store.getState().tasks).toEqual([]);
  });

  it("a stale toggle conflicts too and 'keep mine' re-completes the task", async () => {
    const server = createSimulatedTaskApi({ delayMs: 5, initialTasks: [makeTask("a")] });
    const store = createTaskStore(server, {
      initialTasks: [makeTask("a")],
      now: () => T1,
    });
    server.externalUpdate(A, { title: "edited" });
    await store.toggleComplete(A);
    expect(store.getState().conflicts).toHaveLength(1);
    expect(store.getState().tasks[0]?.completedAt).toBeNull();
    await store.resolveConflict(A, "local");
    expect(server.snapshot()[0]?.completedAt?.toISOString()).toBe(T1.toISOString());
  });

  it("resolving an unknown conflict is a harmless no-op", async () => {
    const store = createTaskStore(instantApi);
    await expect(store.resolveConflict(A, "local")).resolves.toBeUndefined();
  });

  it("does not apply an earlier accepted edit twice when a later edit conflicts", async () => {
    // Y's request is slow and heads the queue, so X's accepted edit cannot fold yet.
    vi.useFakeTimers();
    try {
      const server = createSimulatedTaskApi({
        initialTasks: [makeTask("x"), makeTask("y")],
        delayMs: (_op, id) => (id === "y" ? 500 : 5),
      });
      const store = createTaskStore(server, { initialTasks: [makeTask("x"), makeTask("y")] });
      const X = toTaskId("x");
      const pY = store.updateTask(toTaskId("y"), { title: "slow" });
      const p1 = store.updateTask(X, { title: "x1" }); // accepted, waiting to fold behind Y
      await vi.advanceTimersByTimeAsync(50);
      server.externalUpdate(X, { title: "x-external" }); // now X's next edit is stale
      const p2 = store.updateTask(X, { title: "x2" });
      await vi.advanceTimersByTimeAsync(1500);
      await Promise.all([pY, p1, p2]);
      const serverX = server.snapshot().find((t) => t.id === "x");
      expect(store.getState().tasks.find((t) => t.id === "x")?.version).toBe(serverX?.version);
      expect(store.getState().conflicts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("subscribers (instructor bug 3 and ST11/ST17)", () => {
  it("notifies once for the optimistic change and once when it settles", async () => {
    const { api, at } = recordingApi();
    const store = createTaskStore(api);
    const listener = vi.fn();
    store.subscribe(listener);
    const p = store.addTask(makeTask("a"));
    expect(listener).toHaveBeenCalledTimes(1);
    await tick();
    at(0).d.resolve();
    await p;
    expect(listener).toHaveBeenCalledTimes(2); // pending cleared
  });

  it("notifies once for a rollback (tasks, pending and error change together)", async () => {
    const { api, at } = recordingApi();
    const store = createTaskStore(api);
    const p = store.addTask(makeTask("a"));
    const listener = vi.fn();
    store.subscribe(listener);
    await tick();
    at(0).d.reject(new Error("x"));
    await p;
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("never calls a listener after it unsubscribes", async () => {
    const store = createTaskStore(instantApi);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    await store.addTask(makeTask("a"));
    const before = listener.mock.calls.length;
    off();
    await store.addTask(makeTask("b"));
    expect(listener).toHaveBeenCalledTimes(before);
  });

  it("delivers every state to every listener exactly once, even when one updates the store", async () => {
    const store = createTaskStore(instantApi, {
      initialTasks: [makeTask("a", { title: "orig" })],
    });
    const seenA: string[] = [];
    const seenB: string[] = [];
    let triggered = false;
    store.subscribe((s) => {
      seenA.push(title(s.tasks, A) ?? "");
      if (!triggered) {
        triggered = true;
        void store.updateTask(A, { title: "from A" });
      }
    });
    store.subscribe((s) => seenB.push(title(s.tasks, A) ?? ""));
    await store.updateTask(A, { title: "one" });
    await tick();
    const distinct = (xs: string[]): string[] => xs.filter((x, i) => xs[i - 1] !== x);
    expect(distinct(seenA)).toEqual(["one", "from A"]);
    expect(distinct(seenB)).toEqual(["one", "from A"]); // never ["from A", "from A"]
  });

  it("never hands the same state object to one listener twice", async () => {
    const store = createTaskStore(instantApi, { initialTasks: [makeTask("a")] });
    const received: unknown[] = [];
    let triggered = false;
    store.subscribe(() => {
      if (!triggered) {
        triggered = true;
        void store.updateTask(A, { title: "nested" });
      }
    });
    store.subscribe((s) => received.push(s));
    await store.updateTask(A, { title: "outer" });
    await tick();
    expect(new Set(received).size).toBe(received.length);
  });

  it("a throwing listener cannot stop the API call or strand the mutation (ST11)", async () => {
    const api = {
      ...instantApi,
      updateTask: vi.fn(() => Promise.resolve()),
    };
    const errors: unknown[] = [];
    const store = createTaskStore(api, {
      initialTasks: [makeTask("a")],
      onListenerError: (e) => errors.push(e),
    });
    store.subscribe(() => {
      throw new Error("listener bug");
    });
    await store.updateTask(A, { title: "x" });
    expect(api.updateTask).toHaveBeenCalledTimes(1);
    expect(store.getState().pending).toEqual({});
    expect(title(store.getState().tasks, A)).toBe("x");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("subscribing the same function twice gives two independent subscriptions (ST17)", async () => {
    const store = createTaskStore(instantApi, { initialTasks: [makeTask("a")] });
    const listener = vi.fn();
    const off1 = store.subscribe(listener);
    store.subscribe(listener);
    off1();
    await store.updateTask(A, { title: "x" });
    expect(listener).toHaveBeenCalled();
  });
});

describe("validation at the store boundary", () => {
  const unknownValue = <T>(json: string): T => JSON.parse(json);

  it("rejects an update with an unknown key without calling the API", async () => {
    const { api, calls } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a", { title: "orig" })] });
    await store.updateTask(A, unknownValue('{"tittle":"typo"}'));
    await tick();
    expect(calls).toHaveLength(0);
    expect(store.getState().error).toContain("Invalid update");
    expect(store.getState().error).toContain("unknown key");
    expect(title(store.getState().tasks, A)).toBe("orig");
  });

  it("cannot be used to overwrite system-owned fields at runtime", async () => {
    const { api, calls } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a")] });
    await store.updateTask(A, unknownValue('{"id":"hijacked","version":99}'));
    await tick();
    expect(calls).toHaveLength(0);
    expect(store.getState().tasks[0]?.id).toBe("a");
    expect(store.getState().tasks[0]?.version).toBe(0);
  });

  it("rejects a due date before creation", async () => {
    const { api, calls } = recordingApi();
    const store = createTaskStore(api, {
      initialTasks: [makeTask("a", { createdAt: new Date("2024-03-01T00:00:00Z") })],
    });
    await store.updateTask(A, { dueAt: new Date("2024-02-01T00:00:00Z") });
    await tick();
    expect(calls).toHaveLength(0);
    expect(store.getState().error).toContain("dueAt");
  });

  it("rejects an invalid new task", async () => {
    const { api, calls } = recordingApi();
    const store = createTaskStore(api);
    await store.addTask(unknownValue('{"id":"x","title":""}'));
    await tick();
    expect(calls).toHaveLength(0);
    expect(store.getState().error).toContain("Invalid task");
    expect(store.getState().tasks).toEqual([]);
  });
});

describe("audit, metrics, retry and timeout", () => {
  it("records add, edit, complete and delete events", async () => {
    const audit = createAuditLog(() => T1);
    const store = createTaskStore(instantApi, { audit, now: () => T1 });
    await store.addTask(makeTask("a", { title: "Plan" }));
    await store.updateTask(A, { title: "Plan v2" });
    await store.toggleComplete(A);
    await store.deleteTask(A);
    expect(audit.list().map((e) => e.type)).toEqual(["add", "edit", "complete", "delete"]);
    expect(audit.list().every((e) => e.taskId === "a")).toBe(true);
  });

  it("records a rollback event and counts the failure", async () => {
    const audit = createAuditLog(() => T1);
    const metrics = createMetrics();
    const api: TaskApi = {
      ...instantApi,
      updateTask: () => Promise.reject(new RetryableError("network", "down")),
    };
    const store = createTaskStore(api, { audit, metrics, initialTasks: [makeTask("a")] });
    await store.updateTask(A, { title: "x" });
    expect(audit.list().map((e) => e.type)).toEqual(["edit", "rollback"]);
    expect(metrics.snapshot().mutationFailures).toBe(1);
    expect(metrics.snapshot().attempts).toBe(1);
  });

  it("keeps hostile titles out of the audit trail", async () => {
    const audit = createAuditLog(() => T1);
    const store = createTaskStore(instantApi, { audit });
    await store.addTask(makeTask("a", { title: "<script>alert(1)</script>" }));
    expect(audit.list()[0]?.summary).not.toMatch(/[<>]/);
  });

  it("retries a retryable failure and records each retry", async () => {
    const audit = createAuditLog(() => T1);
    let calls = 0;
    const api: TaskApi = {
      ...instantApi,
      updateTask: () =>
        ++calls < 3 ? Promise.reject(new RetryableError("network", "blip")) : Promise.resolve(),
    };
    const store = createTaskStore(api, {
      audit,
      initialTasks: [makeTask("a")],
      retry: { maxAttempts: 3, baseDelayMs: 1, rng: () => 0 },
    });
    await store.updateTask(A, { title: "x" });
    expect(calls).toBe(3);
    expect(audit.list().filter((e) => e.type === "retry")).toHaveLength(2);
    expect(store.getState().error).toBeNull();
  });

  it("does not retry a permanent failure", async () => {
    let calls = 0;
    const api: TaskApi = {
      ...instantApi,
      updateTask: () => {
        calls++;
        return Promise.reject(new NonRetryableError("bad"));
      },
    };
    const store = createTaskStore(api, {
      initialTasks: [makeTask("a")],
      retry: { maxAttempts: 3, baseDelayMs: 1 },
    });
    await store.updateTask(A, { title: "x" });
    expect(calls).toBe(1);
  });

  it("times out a hung request, rolls back and leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const api: TaskApi = { ...instantApi, updateTask: () => new Promise(() => undefined) };
      const store = createTaskStore(api, {
        initialTasks: [makeTask("a", { title: "orig" })],
        mutationTimeoutMs: 1000,
      });
      const p = store.updateTask(A, { title: "x" });
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(title(store.getState().tasks, A)).toBe("orig");
      expect(store.getState().error).toContain("timed out");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives an API that throws synchronously", async () => {
    const api: TaskApi = {
      ...instantApi,
      updateTask: () => {
        throw new Error("sync api bug");
      },
    };
    const store = createTaskStore(api, { initialTasks: [makeTask("a", { title: "orig" })] });
    await store.updateTask(A, { title: "x" });
    expect(title(store.getState().tasks, A)).toBe("orig");
    expect(store.getState().error).toContain("sync api bug");
    expect(store.getState().pending).toEqual({});
  });
});

describe("hydrate", () => {
  it("adds server tasks that the store has not seen", () => {
    const store = createTaskStore(instantApi);
    store.hydrate([makeTask("a"), makeTask("b")]);
    expect(store.getState().tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("lets a newer server copy win and ignores a stale snapshot", () => {
    const store = createTaskStore(instantApi, {
      initialTasks: [makeTask("a", { title: "current", updatedAt: T2, version: 5 })],
    });
    store.hydrate([makeTask("a", { title: "stale", updatedAt: T1, version: 2 })]);
    expect(title(store.getState().tasks, A)).toBe("current");
    store.hydrate([
      makeTask("a", { title: "newer", updatedAt: new Date("2024-06-01"), version: 6 }),
    ]);
    expect(title(store.getState().tasks, A)).toBe("newer");
  });

  it("keeps optimistic pending edits on top of a snapshot", async () => {
    const { api } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a", { title: "orig" })] });
    void store.updateTask(A, { title: "mine" });
    store.hydrate([makeTask("a", { title: "server", updatedAt: T2, version: 3 })]);
    expect(title(store.getState().tasks, A)).toBe("mine");
  });

  it("drops tasks missing from a COMPLETE snapshot but keeps unconfirmed adds", () => {
    const { api } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a"), makeTask("b")] });
    void store.addTask(makeTask("c"));
    store.hydrate([makeTask("a")], { removeMissing: true });
    expect(store.getState().tasks.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("keeps tasks missing from a partial snapshot by default", () => {
    const store = createTaskStore(instantApi, { initialTasks: [makeTask("a"), makeTask("b")] });
    store.hydrate([makeTask("a")]);
    expect(store.getState().tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("does not notify when the snapshot changes nothing", () => {
    const task = makeTask("a");
    const store = createTaskStore(instantApi, { initialTasks: [task] });
    const listener = vi.fn();
    store.subscribe(listener);
    store.hydrate([task]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not apply an accepted-but-unfolded edit a second time after a snapshot", async () => {
    // Y heads the queue and stays pending, so X's accepted edit cannot fold on its own.
    const { api, at } = recordingApi();
    const Y = toTaskId("y");
    const store = createTaskStore(api, {
      initialTasks: [makeTask("x"), makeTask("y")],
      now: () => T1,
    });
    void store.updateTask(Y, { title: "slow" });
    const px = store.updateTask(toTaskId("x"), { title: "x1" });
    await tick();
    at(1).d.resolve(); // X accepted
    await px;
    store.hydrate([makeTask("x", { title: "x1", version: 1, updatedAt: T2 })]);
    at(0).d.resolve(); // Y finally accepted, queue drains
    await tick();
    const x = store.getState().tasks.find((t) => t.id === "x");
    expect(x?.version).toBe(1); // not 2
    expect(x?.title).toBe("x1");
  });

  it("uses the snapshot version as the expected version for the next edit", async () => {
    const { api, calls } = recordingApi();
    const store = createTaskStore(api, { initialTasks: [makeTask("a", { version: 1 })] });
    store.hydrate([makeTask("a", { version: 7, updatedAt: T2 })]);
    void store.updateTask(A, { title: "x" });
    await tick();
    expect(calls[0]?.expected).toBe(7);
  });
});
