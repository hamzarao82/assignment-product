/**
 * Spec section 3: "No function may mutate a Task, input array, or state snapshot."
 *
 * Object.freeze alone cannot catch a function that calls date.setTime(), because a
 * Date keeps its value in an internal slot. So the fixtures use GuardedDate, whose every
 * setter throws, and every array, task and tag list is frozen. A function that mutates
 * any input fails the test by throwing (ES modules are strict mode), and the JSON of the
 * inputs is compared before and after as a second line of defence.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { describeConflict, summarizeTask } from "../src/conflict";
import { createDiagnosticSnapshot } from "../src/diagnostics";
import { tasksEqual } from "../src/equality";
import { filterTasks, groupBy, groupTasksByPriority, sortTasks, sortTasksBy } from "../src/filters";
import { applyImport, exportTasks, previewImport } from "../src/importExport";
import { createOfflineQueue } from "../src/offlineQueue";
import { mergeTasks, reconcileTask } from "../src/pagination";
import { describeState, renderTask, renderTaskApp, renderTaskList } from "../src/render";
import { createTaskViewSelector } from "../src/selectors";
import { computeStats, isOverdue } from "../src/stats";
import { type StoreState, createTaskStore, taskReducer } from "../src/store";
import { type Task, toTaskId } from "../src/types";
import { parseTask, parseTaskList, parseTaskPatch } from "../src/validation";
import { makeTask } from "./helpers";

/** A Date that refuses to be modified. It is still `instanceof Date`. */
class GuardedDate extends Date {}
for (const name of Object.getOwnPropertyNames(Date.prototype)) {
  if (name.startsWith("set")) {
    Object.defineProperty(GuardedDate.prototype, name, {
      value: () => {
        throw new TypeError(`Date.${name} was called on an input`);
      },
    });
  }
}
const day = (n: number): Date => new GuardedDate(Date.UTC(2024, 0, n));

function frozenTask(id: string, over: Partial<Omit<Task, "id">> = {}): Task {
  const task = makeTask(id, {
    createdAt: day(1),
    updatedAt: day(2),
    ...over,
    tags: Object.freeze([...(over.tags ?? [])]),
  });
  return Object.freeze(task);
}

function fixture(): readonly Task[] {
  return Object.freeze([
    frozenTask("a", { title: "Alpha", priority: "high", tags: ["x", "y"], dueAt: day(5) }),
    frozenTask("b", { title: "beta", priority: "low", completedAt: day(4), version: 3 }),
    frozenTask("c", { title: "Gamma", priority: "medium", tags: ["x"], updatedAt: day(9) }),
    frozenTask("d", { title: "delta", dueAt: day(1) }),
  ]);
}

const NOW = new Date("2024-03-10T00:00:00Z");
const A = toTaskId("a");
const snapshot = (value: unknown): string => JSON.stringify(value);
const first = (tasks: readonly Task[]): Task => {
  const t = tasks[0];
  if (t === undefined) throw new Error("empty fixture");
  return t;
};

describe("guard fixtures work (so a pass is meaningful)", () => {
  it("GuardedDate really refuses mutation and is still a Date", () => {
    const d = day(3);
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBe(Date.UTC(2024, 0, 3));
    expect(() => d.setTime(0)).toThrow("setTime");
    expect(() => d.setUTCHours(1)).toThrow("setUTCHours");
  });

  it("frozen arrays, tasks and tag lists refuse mutation", () => {
    const tasks = fixture();
    expect(Object.isFrozen(tasks)).toBe(true);
    expect(Object.isFrozen(first(tasks))).toBe(true);
    expect(Object.isFrozen(first(tasks).tags)).toBe(true);
    expect(() => {
      Reflect.defineProperty(tasks, "length", { value: 0 });
      Object.assign(first(tasks), { title: "changed" });
    }).toThrow(TypeError);
  });
});

describe("pure functions never mutate their inputs", () => {
  const cases: readonly [string, (tasks: readonly Task[]) => unknown][] = [
    [
      "filterTasks",
      (t) => filterTasks(t, { priority: "high", tags: ["x"], query: "a", completed: false }),
    ],
    [
      "filterTasks (ranges)",
      (t) => filterTasks(t, { createdRange: { from: day(1) }, dueRange: { to: day(9) } }),
    ],
    ["sortTasks title", (t) => sortTasks(t, "title", "asc")],
    ["sortTasks completedAt", (t) => sortTasks(t, "completedAt", "desc")],
    ["sortTasks dueAt", (t) => sortTasks(t, "dueAt", "asc")],
    ["sortTasks tags", (t) => sortTasks(t, "tags", "asc")],
    [
      "sortTasksBy",
      (t) =>
        sortTasksBy(t, [
          { by: "priority", direction: "desc" },
          { by: "title", direction: "asc" },
        ]),
    ],
    ["groupBy", (t) => groupBy(t, (x) => x.priority)],
    ["groupTasksByPriority", (t) => groupTasksByPriority(t)],
    [
      "mergeTasks",
      (t) => mergeTasks(t, [frozenTask("a", { updatedAt: day(20), version: 9 }), frozenTask("e")]),
    ],
    ["reconcileTask", (t) => reconcileTask(first(t), frozenTask("a", { updatedAt: day(20) }))],
    ["taskReducer add", (t) => taskReducer(t, { type: "add", task: frozenTask("n") })],
    [
      "taskReducer update",
      (t) =>
        taskReducer(t, { type: "update", id: A, patch: { title: "new", tags: ["q"] }, at: day(7) }),
    ],
    [
      "taskReducer toggle",
      (t) => taskReducer(t, { type: "toggle", id: A, completed: true, at: day(7) }),
    ],
    ["taskReducer delete", (t) => taskReducer(t, { type: "delete", id: A })],
    [
      "taskReducer sync",
      (t) => taskReducer(t, { type: "sync", task: frozenTask("a", { title: "server" }) }),
    ],
    ["computeStats", (t) => computeStats(t, NOW)],
    ["isOverdue", (t) => t.map((x) => isOverdue(x, NOW))],
    ["tasksEqual", (t) => t.map((x) => tasksEqual(x, x))],
    ["exportTasks", (t) => exportTasks(t, () => NOW)],
    [
      "previewImport",
      (t) =>
        previewImport(
          t,
          exportTasks([frozenTask("a", { title: "other", updatedAt: day(30) })], () => NOW),
        ),
    ],
    [
      "view selector",
      (t) =>
        createTaskViewSelector()({
          tasks: t,
          view: { filter: { priority: "high" }, sort: [{ by: "title", direction: "asc" }] },
        }),
    ],
    ["renderTask", (t) => t.map((x) => renderTask(x, { now: NOW, pending: { a: 1 } }))],
    ["renderTaskList", (t) => renderTaskList({ status: "success", data: t }, { now: NOW })],
    [
      "renderTaskList refreshing",
      (t) => renderTaskList({ status: "refreshing", data: t }, { now: NOW }),
    ],
    [
      "renderTaskApp",
      (t) =>
        renderTaskApp({ state: { status: "success", data: t }, ctx: { now: NOW }, error: "e" }),
    ],
    ["describeState", (t) => describeState({ status: "success", data: t }, { now: NOW })],
    ["summarizeTask", (t) => t.map(summarizeTask)],
    [
      "describeConflict",
      (t) =>
        describeConflict({
          taskId: A,
          intent: "update",
          patch: { title: "x" },
          local: summarizeTask(first(t)),
          server: summarizeTask(first(t)),
        }),
    ],
    [
      "createDiagnosticSnapshot",
      (t) =>
        createDiagnosticSnapshot(
          {
            store: Object.freeze({
              tasks: t,
              error: "x",
              pending: Object.freeze({ a: 1 }),
              conflicts: Object.freeze([]),
            }),
          },
          () => NOW,
        ),
    ],
  ];

  it.each(cases)("%s leaves a frozen list, its tasks, tags and Dates untouched", (_name, fn) => {
    const tasks = fixture();
    const before = snapshot(tasks);
    expect(() => fn(tasks)).not.toThrow();
    expect(snapshot(tasks)).toBe(before);
  });

  it("applyImport leaves both the existing list and the preview untouched", () => {
    const existing = fixture();
    const result = previewImport(
      existing,
      exportTasks([frozenTask("z")], () => NOW),
    );
    if (!result.ok) throw new Error("preview failed");
    const before = snapshot({ existing, preview: result.value });
    expect(() => applyImport(existing, result.value, { confirmed: true })).not.toThrow();
    expect(snapshot({ existing, preview: result.value })).toBe(before);
  });
});

describe("parsers never mutate the data they validate", () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const v of Object.values(value)) deepFreeze(v);
    }
    return value;
  };
  const raw = {
    id: "t1",
    title: "T",
    priority: "low",
    completedAt: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
    dueAt: null,
    tags: ["a"],
    version: 0,
  };

  it("parseTask, parseTaskList and parseTaskPatch accept deeply frozen raw input", () => {
    const frozenRaw = deepFreeze({ ...raw, tags: [...raw.tags] });
    const before = snapshot(frozenRaw);
    expect(parseTask(frozenRaw).ok).toBe(true);
    expect(parseTaskList(deepFreeze([{ ...raw, tags: ["a"] }, { bad: 1 }])).tasks).toHaveLength(1);
    expect(parseTaskPatch(deepFreeze({ title: "x", tags: ["q"] })).ok).toBe(true);
    expect(snapshot(frozenRaw)).toBe(before);
  });

  it("a parsed task owns its tags, so editing the raw input afterwards cannot change it", () => {
    const rawTags = ["a"];
    const r = parseTask({ ...raw, tags: rawTags });
    rawTags.push("leaked");
    expect(r.ok && r.task.tags).toEqual(["a"]);
  });
});

describe("the store never mutates its inputs or any state it handed out", () => {
  const instantApi = {
    addTask: () => Promise.resolve(),
    updateTask: () => Promise.resolve(),
    deleteTask: () => Promise.resolve(),
  };

  it("leaves a frozen initial list untouched through every kind of change", async () => {
    const initial = fixture();
    const before = snapshot(initial);
    const store = createTaskStore(instantApi, { initialTasks: initial, now: () => NOW });
    await store.addTask(frozenTask("n"));
    await store.updateTask(A, { title: "edited", tags: ["z"] });
    await store.toggleComplete(A);
    await store.deleteTask(toTaskId("b"));
    store.hydrate(fixture(), { removeMissing: true });
    store.hydrate([frozenTask("a", { title: "newer", updatedAt: day(28), version: 9 })]);
    expect(snapshot(initial)).toBe(before);
  });

  it("never changes a snapshot it already returned (history is immutable)", async () => {
    const store = createTaskStore(instantApi, { initialTasks: fixture(), now: () => NOW });
    const firstState: StoreState = store.getState();
    const firstJson = snapshot(firstState);
    await store.updateTask(A, { title: "later" });
    await store.toggleComplete(A);
    expect(snapshot(firstState)).toBe(firstJson);
    expect(store.getState()).not.toBe(firstState);
    expect(firstState.tasks[0]?.title).toBe("Alpha");
  });

  it("property: after any sequence of actions every earlier snapshot is unchanged", async () => {
    const action = fc.record({
      kind: fc.constantFrom("add", "update", "toggle", "delete"),
      id: fc.constantFrom("a", "b", "c", "d", "n1", "n2"),
      title: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim() !== ""),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 12 }), async (steps) => {
        const store = createTaskStore(instantApi, { initialTasks: fixture(), now: () => NOW });
        const seen: { state: StoreState; json: string }[] = [];
        store.subscribe((state) => seen.push({ state, json: snapshot(state) }));
        for (const step of steps) {
          const id = toTaskId(step.id);
          if (step.kind === "add") await store.addTask(frozenTask(step.id, { title: step.title }));
          else if (step.kind === "update") await store.updateTask(id, { title: step.title });
          else if (step.kind === "toggle") await store.toggleComplete(id);
          else await store.deleteTask(id);
        }
        for (const entry of seen) expect(snapshot(entry.state)).toBe(entry.json);
      }),
      { numRuns: 60 },
    );
  });
});

describe("the offline queue never mutates the operations it is given", () => {
  it("serialize leaves frozen operations untouched, and restore leaves its input untouched", () => {
    const queue = createOfflineQueue({ execute: () => Promise.resolve(), online: false });
    const op = Object.freeze({
      kind: "update" as const,
      taskId: A,
      patch: Object.freeze({ title: "x", tags: Object.freeze(["q"]), dueAt: day(9) }),
      expectedVersion: 2,
    });
    const before = snapshot(op);
    void queue.enqueue(op).catch(() => undefined);
    const text = queue.serialize();
    expect(snapshot(op)).toBe(before);

    const doc = Object.freeze(JSON.parse(text));
    const docBefore = snapshot(doc);
    const target = createOfflineQueue({ execute: () => Promise.resolve(), online: false });
    expect(target.restore(doc).ok).toBe(true);
    expect(snapshot(doc)).toBe(docBefore);
  });
});
