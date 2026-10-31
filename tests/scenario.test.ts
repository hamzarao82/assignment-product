/**
 * The three-minute demo, as an executable script. Each test is one beat of the story and
 * wires several real modules together (no mocks of our own code), so a green run proves
 * the pieces fit, not just that each works alone. Read top to bottom with:
 *   npx vitest run tests/scenario.test.ts --reporter=verbose
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSimulatedTaskApi, fetchTasks } from "../src/api";
import { createAuditLog } from "../src/audit";
import { createTaskListCache } from "../src/cache";
import { createDiagnosticSnapshot, formatDiagnostics } from "../src/diagnostics";
import { applyImport, exportTasks, previewImport } from "../src/importExport";
import { createMetrics } from "../src/metrics";
import { createQueuedTaskApi } from "../src/offlineQueue";
import { renderTaskApp, renderTaskList } from "../src/render";
import { createLatestLoader, withRetry } from "../src/retry";
import { sleep } from "../src/timing";
import { createTaskStore } from "../src/store";
import { type Task, type TaskListState, toTaskId } from "../src/types";
import { makeTask } from "./helpers";

const NOW = new Date("2024-03-10T00:00:00Z"); // after the sample "Write the report" due date
const ctx = { now: NOW };
const instant = { minDelayMs: 0, maxDelayMs: 0 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function collect(): { states: TaskListState[]; push: (s: TaskListState) => void } {
  const states: TaskListState[] = [];
  return { states, push: (s) => states.push(s) };
}

const last = <T>(xs: readonly T[]): T => {
  const x = xs.at(-1);
  if (x === undefined) throw new Error("nothing recorded");
  return x;
};

describe("Demo beat 1: loading, then data", () => {
  it("shows a loading indicator, then every task with priority and status", async () => {
    const { states, push } = collect();
    const loader = createLatestLoader(
      (signal) => fetchTasks({ minDelayMs: 100, maxDelayMs: 100, signal }),
      push,
    );
    const p = loader.load();
    expect(renderTaskList(last(states), ctx)).toContain("Loading tasks…");
    await vi.advanceTimersByTimeAsync(100);
    await p;
    const html = renderTaskList(last(states), ctx);
    expect(html).toContain("Write the report");
    expect(html).toContain("task--high");
    expect(html).toContain("Buy groceries");
    expect(html).toContain("task--done");
    expect(html).toContain("2 tasks, 1 completed, 1 overdue");
  });
});

describe("Demo beat 2: empty", () => {
  it("tells the user clearly there are no tasks instead of showing a blank screen", async () => {
    const { states, push } = collect();
    const loader = createLatestLoader(
      (signal) => fetchTasks({ ...instant, outcome: "empty", signal }),
      push,
    );
    const p = loader.load();
    await vi.runAllTimersAsync();
    await p;
    const html = renderTaskApp({ state: last(states), ctx });
    expect(html).toContain("No tasks yet");
    expect(html).toContain("Add your first task");
    expect(html).not.toContain('<ul class="task-list">');
  });
});

describe("Demo beat 3: failure, then retry", () => {
  it("shows a real error with a Retry button after retries are exhausted, then recovers", async () => {
    const metrics = createMetrics();
    let outcome: "error" | "data" = "error";
    const { states, push } = collect();
    const loader = createLatestLoader(
      (signal) =>
        withRetry((s) => fetchTasks({ ...instant, outcome, signal: s }), {
          baseDelayMs: 10,
          rng: () => 0,
          signal,
          metrics,
        }),
      push,
    );
    const first = loader.load();
    await vi.runAllTimersAsync();
    await first;
    const failed = renderTaskApp({ state: last(states), ctx });
    expect(last(states).status).toBe("error");
    expect(failed).toContain('data-action="retry"');
    expect(failed).toContain("try again");
    expect(metrics.snapshot().attempts).toBe(3);
    expect(metrics.snapshot().retries).toBe(2);

    outcome = "data"; // the network is back; the user presses Retry
    const second = loader.load();
    await vi.runAllTimersAsync();
    await second;
    expect(last(states).status).toBe("success");
  });
});

describe("Demo beat 4: race safety", () => {
  it("never lets a slow, older response overwrite the newer screen", async () => {
    const { states, push } = collect();
    let call = 0;
    const loader = createLatestLoader(async () => {
      call++;
      if (call === 1) {
        await sleep(1000); // ignores the abort signal on purpose
        return [makeTask("old-response")];
      }
      await sleep(50);
      return [makeTask("new-response")];
    }, push);
    void loader.load(); // slow, soon stale
    void loader.load(); // newer
    await vi.advanceTimersByTimeAsync(50);
    expect(renderTaskList(last(states), ctx)).toContain("Task new-response");
    await vi.advanceTimersByTimeAsync(2000); // the stale answer finally arrives
    const html = renderTaskList(last(states), ctx);
    expect(html).toContain("Task new-response");
    expect(html).not.toContain("old-response");
  });
});

describe("Demo beat 5: optimistic update and rollback", () => {
  it("updates instantly, then rolls back and announces the failure when the server says no", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 20,
      initialTasks: [makeTask("a", { title: "Original" })],
    });
    const failing = {
      ...server,
      updateTask: () => Promise.reject(new Error("server unavailable")),
    };
    const audit = createAuditLog(() => NOW);
    const store = createTaskStore(failing, {
      initialTasks: [makeTask("a", { title: "Original" })],
      audit,
    });
    const edit = store.updateTask(toTaskId("a"), { title: "Edited" });
    const optimistic = renderTaskApp({
      state: { status: "success", data: store.getState().tasks },
      ctx: { now: NOW, pending: store.getState().pending },
    });
    expect(optimistic).toContain("Edited");
    expect(optimistic).toContain("Saving…");
    await vi.advanceTimersByTimeAsync(50);
    await edit;
    const after = store.getState();
    const html = renderTaskApp({
      state: { status: "success", data: after.tasks },
      ctx: { now: NOW, pending: after.pending },
      error: after.error,
    });
    expect(html).toContain("Original");
    expect(html).not.toContain("Saving…");
    expect(html).toContain("server unavailable");
    expect(audit.list().map((e) => e.type)).toEqual(["edit", "rollback"]);
  });
});

describe("Demo beat 6: stale cache", () => {
  it("serves the stale list at once and refreshes it in the background", async () => {
    let clock = 0;
    const cache = createTaskListCache({ ttlMs: 100, staleMs: 10_000, now: () => clock });
    let version = 1;
    const fetcher = vi.fn(() => Promise.resolve([makeTask(`list-v${version}`)]));
    expect((await cache.get("tasks", fetcher))[0]?.id).toBe("list-v1");
    version = 2;
    clock = 500; // past the TTL but inside the stale window
    const stale = await cache.get("tasks", fetcher);
    expect(stale[0]?.id).toBe("list-v1"); // instant, stale
    expect(fetcher).toHaveBeenCalledTimes(2); // refresh already running
    await vi.advanceTimersByTimeAsync(0);
    clock = 520;
    expect((await cache.get("tasks", fetcher))[0]?.id).toBe("list-v2"); // now fresh
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("Demo beat 7: import dry run", () => {
  it("previews what would change, changes nothing until confirmed, then applies", async () => {
    const existing: Task[] = [makeTask("a", { title: "Mine", updatedAt: new Date("2024-02-01") })];
    const file = exportTasks(
      [
        makeTask("a", { title: "Newer elsewhere", updatedAt: new Date("2024-03-01"), version: 2 }),
        makeTask("b", { title: "Brand new" }),
      ],
      () => NOW,
    );
    const preview = previewImport(existing, file);
    if (!preview.ok) throw new Error("preview failed");
    expect(preview.value.summary).toEqual({
      accepted: 2,
      rejected: 0,
      created: 1,
      updated: 1,
      unchanged: 0,
    });
    expect(existing[0]?.title).toBe("Mine"); // the dry run changed nothing

    const audit = createAuditLog(() => NOW);
    expect(applyImport(existing, preview.value, { confirmed: false }, audit).applied).toBe(false);
    const applied = applyImport(existing, preview.value, { confirmed: true }, audit);
    expect(applied.applied).toBe(true);
    expect(applied.tasks.map((t) => t.title)).toEqual(["Newer elsewhere", "Brand new"]);
    expect(audit.list().map((e) => e.type)).toEqual(["import"]);

    const store = createTaskStore(createSimulatedTaskApi({ delayMs: 1 }), {
      initialTasks: existing,
    });
    store.hydrate(applied.tasks);
    expect(store.getState().tasks).toHaveLength(2);
  });
});

describe("Demo beat 8: offline queue", () => {
  it("keeps the optimistic view offline, then replays in order when the connection returns", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 5,
      initialTasks: [makeTask("a", { title: "Orig" })],
    });
    const { api, queue } = createQueuedTaskApi(server, { online: false });
    const store = createTaskStore(api, {
      initialTasks: [makeTask("a", { title: "Orig" })],
      mutationTimeoutMs: Number.POSITIVE_INFINITY,
    });
    const edit = store.updateTask(toTaskId("a"), { title: "Edited offline" });
    const add = store.addTask(makeTask("b", { title: "Added offline" }));
    await vi.advanceTimersByTimeAsync(1000);
    const offline = renderTaskApp({
      state: { status: "success", data: store.getState().tasks },
      ctx: { now: NOW, pending: store.getState().pending },
    });
    expect(offline).toContain("Edited offline");
    expect(offline).toContain("Saving…");
    expect(queue.getState()).toMatchObject({ depth: 2, status: "waiting" });
    expect(server.snapshot()[0]?.title).toBe("Orig");

    queue.setOnline(true);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([edit, add]);
    expect(server.snapshot().map((t) => t.title)).toEqual(["Edited offline", "Added offline"]);
    expect(store.getState().pending).toEqual({});
  });
});

describe("Demo beat 9: conflict state", () => {
  it("shows both versions side by side and lets the user keep theirs or mine", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 5,
      initialTasks: [makeTask("a", { title: "Orig" })],
    });
    const store = createTaskStore(server, { initialTasks: [makeTask("a", { title: "Orig" })] });
    server.externalUpdate(toTaskId("a"), { title: "Their edit" });
    const edit = store.updateTask(toTaskId("a"), { title: "My edit" });
    await vi.advanceTimersByTimeAsync(50);
    await edit;
    const state = store.getState();
    const html = renderTaskApp({
      state: { status: "success", data: state.tasks },
      ctx,
      error: state.error,
      conflicts: state.conflicts,
    });
    expect(html).toContain("My edit");
    expect(html).toContain("Their edit");
    expect(html).toContain("Keep mine");
    expect(html).toContain("Keep theirs");
    expect(server.snapshot()[0]?.title).toBe("Their edit"); // never silently overwritten

    const resolved = store.resolveConflict(toTaskId("a"), "local");
    await vi.advanceTimersByTimeAsync(50);
    await resolved;
    expect(server.snapshot()[0]?.title).toBe("My edit");
    expect(store.getState().conflicts).toEqual([]);
  });
});

describe("Demo finale: a diagnostic snapshot that is safe to share", () => {
  it("summarises the system without a single title, tag or error message", async () => {
    const metrics = createMetrics();
    const server = createSimulatedTaskApi({
      delayMs: 5,
      initialTasks: [makeTask("a", { title: "Confidential plan", tags: ["secret-tag"] })],
    });
    const { api, queue } = createQueuedTaskApi(server, { online: false });
    const store = createTaskStore(api, {
      initialTasks: [makeTask("a", { title: "Confidential plan", tags: ["secret-tag"] })],
      mutationTimeoutMs: Number.POSITIVE_INFINITY,
      metrics,
    });
    void store.updateTask(toTaskId("a"), { title: "Confidential edit" });
    await vi.advanceTimersByTimeAsync(10);
    const text = formatDiagnostics(
      createDiagnosticSnapshot(
        { store: store.getState(), queue: queue.getState(), metrics: metrics.snapshot() },
        () => NOW,
      ),
    );
    expect(text).toContain('"depth": 1');
    expect(text).toContain('"withPendingChanges": 1');
    for (const secret of ["Confidential", "secret-tag"]) expect(text).not.toContain(secret);
  });
});
