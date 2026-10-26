import { describe, expect, it, vi } from "vitest";
import { RetryableError, type TaskApi } from "../src/api";
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

/** API whose every call returns the next queued deferred, so tests control the order. */
function controlledApi(queue: Deferred[]): TaskApi & { calls: number } {
  const api = {
    calls: 0,
    addTask: () => next(),
    updateTask: () => next(),
    deleteTask: () => next(),
  };
  function next(): Promise<void> {
    api.calls++;
    const d = queue.shift();
    return d ? d.promise : Promise.resolve();
  }
  return api;
}

const A = toTaskId("a");
const titleOf = (s: { tasks: readonly Task[] }, id: TaskId): string | undefined =>
  s.tasks.find((t) => t.id === id)?.title;

describe("taskReducer", () => {
  const base = [makeTask("a"), makeTask("b")];

  it("adds, ignoring an id that already exists", () => {
    expect(taskReducer(base, { type: "add", task: makeTask("c") })).toHaveLength(3);
    expect(taskReducer(base, { type: "add", task: makeTask("a") })).toBe(base);
  });

  it("updates only the targeted task and keeps other identities", () => {
    const out = taskReducer(base, { type: "update", id: A, changes: { title: "new" } });
    expect(out[0]?.title).toBe("new");
    expect(out[1]).toBe(base[1]);
  });

  it("toggles completion on and off", () => {
    const now = new Date("2024-05-01");
    const done = taskReducer(base, { type: "toggle", id: A, completed: true, now });
    expect(done[0]?.completedAt).toBe(now);
    const undone = taskReducer(done, { type: "toggle", id: A, completed: false, now });
    expect(undone[0]?.completedAt).toBeNull();
  });

  it("deletes and never mutates the input", () => {
    const frozen = Object.freeze([...base]);
    expect(taskReducer(frozen, { type: "delete", id: A })).toHaveLength(1);
    expect(frozen).toHaveLength(2);
  });

  it("throws on an unknown action type", () => {
    // @ts-expect-error not a valid TaskAction
    expect(() => taskReducer(base, { type: "explode" })).toThrow("Unexpected value");
  });
});

describe("createTaskStore", () => {
  it("applies an add optimistically, before the API answers", async () => {
    const d = deferred();
    const store = createTaskStore(controlledApi([d]));
    const p = store.addTask(makeTask("a"));
    expect(store.getState().tasks).toHaveLength(1);
    d.resolve();
    await p;
    expect(store.getState().tasks).toHaveLength(1);
    expect(store.getState().error).toBeNull();
  });

  it("rolls back a failed add and surfaces the error", async () => {
    const d = deferred();
    const store = createTaskStore(controlledApi([d]));
    const p = store.addTask(makeTask("a"));
    expect(store.getState().tasks).toHaveLength(1);
    d.reject(new RetryableError("network", "offline"));
    await p;
    expect(store.getState().tasks).toHaveLength(0);
    expect(store.getState().error).toBe("Could not add task: offline");
  });

  it("rolls back a failed update to the previous title", async () => {
    const d = deferred();
    const store = createTaskStore(controlledApi([d]), {
      initialTasks: [makeTask("a", { title: "old" })],
    });
    const p = store.updateTask(A, { title: "new" });
    expect(titleOf(store.getState(), A)).toBe("new");
    d.reject(new Error("nope"));
    await p;
    expect(titleOf(store.getState(), A)).toBe("old");
  });

  it("rolls back a failed delete, restoring the task", async () => {
    const d = deferred();
    const store = createTaskStore(controlledApi([d]), {
      initialTasks: [makeTask("a"), makeTask("b")],
    });
    const p = store.deleteTask(A);
    expect(store.getState().tasks.map((t) => t.id)).toEqual(["b"]);
    d.reject(new Error("nope"));
    await p;
    expect(store.getState().tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("toggles complete using the injected clock and rolls back on failure", async () => {
    const now = new Date("2024-06-01T00:00:00Z");
    const d = deferred();
    const store = createTaskStore(controlledApi([d]), {
      initialTasks: [makeTask("a")],
      now: () => now,
    });
    const p = store.toggleComplete(A);
    expect(store.getState().tasks[0]?.completedAt).toBe(now);
    d.reject(new Error("nope"));
    await p;
    expect(store.getState().tasks[0]?.completedAt).toBeNull();
  });

  it("keeps a newer successful update when an older one rolls back afterwards", async () => {
    const first = deferred();
    const second = deferred();
    const store = createTaskStore(controlledApi([first, second]), {
      initialTasks: [makeTask("a", { title: "orig" })],
    });
    const p1 = store.updateTask(A, { title: "first" });
    const p2 = store.updateTask(A, { title: "second" });
    expect(titleOf(store.getState(), A)).toBe("second");

    second.resolve(); // newer one succeeds first
    await p2;
    first.reject(new Error("late failure")); // older rollback arrives afterwards
    await p1;

    expect(titleOf(store.getState(), A)).toBe("second");
    expect(store.getState().error).toBe("Could not update task: late failure");
  });

  it("falls back to the older successful update when the newer one fails", async () => {
    const first = deferred();
    const second = deferred();
    const store = createTaskStore(controlledApi([first, second]), {
      initialTasks: [makeTask("a", { title: "orig" })],
    });
    const p1 = store.updateTask(A, { title: "first" });
    const p2 = store.updateTask(A, { title: "second" });
    first.resolve();
    await p1;
    second.reject(new Error("fail"));
    await p2;
    expect(titleOf(store.getState(), A)).toBe("first");
  });

  it("applies overlapping changes to different fields independently", async () => {
    const first = deferred();
    const second = deferred();
    const store = createTaskStore(controlledApi([first, second]), {
      initialTasks: [makeTask("a", { title: "orig", priority: "low" })],
    });
    const p1 = store.updateTask(A, { title: "T" });
    const p2 = store.updateTask(A, { priority: "high" });
    first.reject(new Error("fail"));
    second.resolve();
    await Promise.all([p1, p2]);
    const task = store.getState().tasks[0];
    expect(task?.title).toBe("orig");
    expect(task?.priority).toBe("high");
  });

  it("notifies exactly once per state change", async () => {
    const d = deferred();
    const store = createTaskStore(controlledApi([d]));
    const listener = vi.fn();
    store.subscribe(listener);
    const p = store.addTask(makeTask("a"));
    expect(listener).toHaveBeenCalledTimes(1); // optimistic apply
    d.resolve();
    await p;
    expect(listener).toHaveBeenCalledTimes(1); // confirmation changes nothing visible
  });

  it("notifies once for a rollback (tasks and error change together)", async () => {
    const d = deferred();
    const store = createTaskStore(controlledApi([d]));
    const p = store.addTask(makeTask("a"));
    const listener = vi.fn();
    store.subscribe(listener);
    d.reject(new Error("x"));
    await p;
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("never calls a listener after it unsubscribes", async () => {
    const store = createTaskStore(controlledApi([]));
    const listener = vi.fn();
    const off = store.subscribe(listener);
    await store.addTask(makeTask("a"));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    await store.addTask(makeTask("b"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("skips the API entirely for unknown ids and duplicate adds", async () => {
    const api = controlledApi([]);
    const store = createTaskStore(api, { initialTasks: [makeTask("a")] });
    await store.updateTask(toTaskId("zzz"), { title: "x" });
    await store.toggleComplete(toTaskId("zzz"));
    await store.deleteTask(toTaskId("zzz"));
    await store.addTask(makeTask("a"));
    expect(api.calls).toBe(0);
  });

  it("clearError resets the error", async () => {
    const d = deferred();
    const store = createTaskStore(controlledApi([d]));
    const p = store.addTask(makeTask("a"));
    d.reject(new Error("x"));
    await p;
    expect(store.getState().error).not.toBeNull();
    store.clearError();
    expect(store.getState().error).toBeNull();
  });
});
