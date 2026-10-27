import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { filterTasks, groupBy, groupTasksByPriority, sortTasks, sortTasksBy } from "../src/filters";
import type { Priority, Task } from "../src/types";
import { makeTask } from "./helpers";

const d = (day: number): Date => new Date(Date.UTC(2024, 0, day));
const ids = (tasks: readonly Task[]): string[] => tasks.map((t) => t.id);

const sample: Task[] = [
  makeTask("a", { title: "banana", priority: "low", createdAt: d(3), tags: ["x"] }),
  makeTask("b", {
    title: "Apple",
    priority: "high",
    createdAt: d(1),
    completedAt: d(5),
    tags: ["y"],
  }),
  makeTask("c", { title: "cherry", priority: "medium", createdAt: d(2), completedAt: d(4) }),
  makeTask("d", { title: "apple", priority: "high", createdAt: d(4), tags: ["x", "y"] }),
];

describe("filterTasks", () => {
  it("returns everything for an empty filter", () => {
    expect(ids(filterTasks(sample, {}))).toEqual(["a", "b", "c", "d"]);
  });

  it("filters by priority and by completed state", () => {
    expect(ids(filterTasks(sample, { priority: "high" }))).toEqual(["b", "d"]);
    expect(ids(filterTasks(sample, { completed: true }))).toEqual(["b", "c"]);
    expect(ids(filterTasks(sample, { completed: false }))).toEqual(["a", "d"]);
  });

  it("matches tags with any-of semantics", () => {
    expect(ids(filterTasks(sample, { tags: ["x"] }))).toEqual(["a", "d"]);
    expect(ids(filterTasks(sample, { tags: ["x", "y"] }))).toEqual(["a", "b", "d"]);
    expect(filterTasks(sample, { tags: [] })).toEqual([]);
  });

  it("applies an inclusive createdAt range", () => {
    expect(ids(filterTasks(sample, { createdRange: { from: d(2), to: d(3) } }))).toEqual([
      "a",
      "c",
    ]);
    expect(ids(filterTasks(sample, { createdRange: { from: d(4) } }))).toEqual(["d"]);
    expect(ids(filterTasks(sample, { createdRange: { to: d(1) } }))).toEqual(["b"]);
  });

  it("combines every criterion with AND", () => {
    const out = filterTasks(sample, {
      priority: "high",
      completed: false,
      tags: ["y"],
      createdRange: { from: d(2) },
    });
    expect(ids(out)).toEqual(["d"]);
  });

  it("does not mutate its input", () => {
    const frozen = Object.freeze([...sample]);
    expect(() => filterTasks(frozen, { priority: "low" })).not.toThrow();
    expect(frozen).toHaveLength(4);
  });
});

describe("sortTasks", () => {
  it("sorts titles case-insensitively", () => {
    expect(sortTasks(sample, "title", "asc").map((t) => t.title)).toEqual([
      "Apple",
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("sorts priority by rank, not alphabetically", () => {
    expect(sortTasks(sample, "priority", "asc").map((t) => t.priority)).toEqual([
      "low",
      "medium",
      "high",
      "high",
    ]);
    expect(sortTasks(sample, "priority", "desc").map((t) => t.priority)).toEqual([
      "high",
      "high",
      "medium",
      "low",
    ]);
  });

  it("sorts createdAt in both directions", () => {
    expect(ids(sortTasks(sample, "createdAt", "asc"))).toEqual(["b", "c", "a", "d"]);
    expect(ids(sortTasks(sample, "createdAt", "desc"))).toEqual(["d", "a", "c", "b"]);
  });

  it("puts null completedAt last in both directions", () => {
    expect(ids(sortTasks(sample, "completedAt", "asc"))).toEqual(["c", "b", "a", "d"]);
    expect(ids(sortTasks(sample, "completedAt", "desc"))).toEqual(["b", "c", "a", "d"]);
  });

  it("sorts by id and by tags", () => {
    expect(ids(sortTasks(sample, "id", "desc"))).toEqual(["d", "c", "b", "a"]);
    expect(ids(sortTasks(sample, "tags", "asc"))).toEqual(["c", "a", "d", "b"]);
  });

  it("is stable: equal keys keep their input order", () => {
    const tied = [
      makeTask("1", { priority: "high" }),
      makeTask("2", { priority: "low" }),
      makeTask("3", { priority: "high" }),
      makeTask("4", { priority: "low" }),
    ];
    expect(ids(sortTasks(tied, "priority", "asc"))).toEqual(["2", "4", "1", "3"]);
    expect(ids(sortTasks(tied, "priority", "desc"))).toEqual(["1", "3", "2", "4"]);
  });

  it("does not mutate the input array", () => {
    const input = [...sample];
    const snapshot = ids(input);
    sortTasks(input, "title", "desc");
    expect(ids(input)).toEqual(snapshot);
  });

  it("rejects an invalid field at compile time", () => {
    // @ts-expect-error "colour" is not a key of Task
    expect(() => sortTasks(sample, "colour", "asc")).toThrow("Unexpected value");
  });
});

describe("sortTasksBy", () => {
  it("uses later keys to break ties", () => {
    const out = sortTasksBy(sample, [
      { by: "priority", direction: "desc" },
      { by: "createdAt", direction: "asc" },
    ]);
    expect(ids(out)).toEqual(["b", "d", "c", "a"]);
  });

  it("returns a copy for an empty key list", () => {
    const out = sortTasksBy(sample, []);
    expect(ids(out)).toEqual(ids(sample));
    expect(out).not.toBe(sample);
  });
});

describe("groupBy", () => {
  it("groups items by the key function", () => {
    expect(groupBy([1, 2, 3, 4, 5], (n) => (n % 2 === 0 ? "even" : "odd"))).toEqual({
      odd: [1, 3, 5],
      even: [2, 4],
    });
  });

  it("groups tasks by priority, keeping empty buckets", () => {
    const g = groupTasksByPriority([makeTask("a", { priority: "low" })]);
    expect(ids(g.low)).toEqual(["a"]);
    expect(g.medium).toEqual([]);
    expect(g.high).toEqual([]);
  });
});

describe("properties", () => {
  const priorityArb = fc.constantFrom<Priority>("low", "medium", "high");
  const taskArb = fc
    .record({
      id: fc.uuid(),
      priority: priorityArb,
      day: fc.integer({ min: 1, max: 28 }),
      done: fc.boolean(),
      title: fc.string({ maxLength: 10 }),
    })
    .map((r) =>
      makeTask(r.id, {
        priority: r.priority,
        title: r.title,
        createdAt: d(r.day),
        completedAt: r.done ? d(r.day + 1) : null,
      }),
    );

  it("sorting twice equals sorting once and preserves length", () => {
    fc.assert(
      fc.property(
        fc.array(taskArb),
        fc.constantFrom("title", "priority", "createdAt", "completedAt"),
        (tasks, by) => {
          const once = sortTasks(tasks, by, "asc");
          expect(ids(sortTasks(once, by, "asc"))).toEqual(ids(once));
          expect(once).toHaveLength(tasks.length);
        },
      ),
    );
  });

  it("filtering never returns more items than the input", () => {
    fc.assert(
      fc.property(fc.array(taskArb), priorityArb, (tasks, priority) => {
        const out = filterTasks(tasks, { priority });
        expect(out.length).toBeLessThanOrEqual(tasks.length);
        expect(out.every((t) => t.priority === priority)).toBe(true);
      }),
    );
  });
});
