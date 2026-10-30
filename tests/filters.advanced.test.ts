import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { filterTasks, groupBy, sortTasks, sortTasksBy } from "../src/filters";
import type { Task } from "../src/types";
import { makeTask } from "./helpers";

const d = (day: number): Date => new Date(Date.UTC(2024, 0, day));
const ids = (tasks: readonly Task[]): string[] => tasks.map((t) => t.id);

const sample: Task[] = [
  makeTask("a", { title: "Plan Launch", tags: ["work", "urgent"], dueAt: d(10), createdAt: d(1) }),
  makeTask("b", { title: "buy milk", tags: ["home"], dueAt: null, createdAt: d(2) }),
  makeTask("c", { title: "Write report", tags: ["work"], dueAt: d(5), createdAt: d(3) }),
  makeTask("d", { title: "Call mum", tags: [], dueAt: d(20), createdAt: d(4) }),
];

describe("filterTasks: all-of tags", () => {
  it("requires every listed tag", () => {
    expect(ids(filterTasks(sample, { allTags: ["work", "urgent"] }))).toEqual(["a"]);
    expect(ids(filterTasks(sample, { allTags: ["work"] }))).toEqual(["a", "c"]);
  });

  it("treats an empty all-of list as no constraint", () => {
    expect(filterTasks(sample, { allTags: [] })).toHaveLength(4);
  });

  it("combines any-of and all-of with AND", () => {
    expect(ids(filterTasks(sample, { tags: ["home", "urgent"], allTags: ["work"] }))).toEqual([
      "a",
    ]);
  });
});

describe("filterTasks: text query", () => {
  it("matches titles case-insensitively", () => {
    expect(ids(filterTasks(sample, { query: "LAUNCH" }))).toEqual(["a"]);
    expect(ids(filterTasks(sample, { query: "buy" }))).toEqual(["b"]);
  });

  it("matches tags too", () => {
    expect(ids(filterTasks(sample, { query: "urg" }))).toEqual(["a"]);
  });

  it("trims the query and treats a blank one as no filter", () => {
    expect(ids(filterTasks(sample, { query: "  report  " }))).toEqual(["c"]);
    expect(filterTasks(sample, { query: "   " })).toHaveLength(4);
    expect(filterTasks(sample, { query: "" })).toHaveLength(4);
  });

  it("does not interpret the query as a pattern", () => {
    expect(filterTasks(sample, { query: ".*" })).toEqual([]);
    expect(filterTasks(sample, { query: "(" })).toEqual([]);
  });

  it("combines with the other criteria", () => {
    expect(ids(filterTasks(sample, { query: "o", tags: ["work"], priority: "medium" }))).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("filterTasks: due range", () => {
  it("is inclusive at both ends", () => {
    expect(ids(filterTasks(sample, { dueRange: { from: d(5), to: d(10) } }))).toEqual(["a", "c"]);
  });

  it("supports open-ended ranges", () => {
    expect(ids(filterTasks(sample, { dueRange: { from: d(10) } }))).toEqual(["a", "d"]);
    expect(ids(filterTasks(sample, { dueRange: { to: d(5) } }))).toEqual(["c"]);
  });

  it("never matches a task with no due date once a bound is set", () => {
    expect(ids(filterTasks(sample, { dueRange: { from: d(1) } }))).not.toContain("b");
  });

  it("an empty range object constrains nothing, even for tasks without a due date", () => {
    expect(filterTasks(sample, { dueRange: {} })).toHaveLength(4);
  });

  it("an inverted range yields no tasks rather than throwing", () => {
    expect(filterTasks(sample, { dueRange: { from: d(20), to: d(1) } })).toEqual([]);
  });

  it("combines created and due ranges", () => {
    const out = filterTasks(sample, {
      createdRange: { from: d(2) },
      dueRange: { to: d(10) },
    });
    expect(ids(out)).toEqual(["c"]);
  });
});

describe("filterTasks: guarantees", () => {
  it("does not mutate a frozen input", () => {
    const frozen = Object.freeze([...sample]);
    expect(() => filterTasks(frozen, { query: "a", allTags: ["work"] })).not.toThrow();
    expect(frozen).toHaveLength(4);
  });

  it("rejects an unknown criterion at compile time", () => {
    // @ts-expect-error "colour" is not a TaskFilter criterion
    expect(filterTasks(sample, { colour: "red" })).toHaveLength(4);
  });
});

describe("sorting by the new keys", () => {
  it("sorts dueAt with nulls last in both directions", () => {
    expect(ids(sortTasks(sample, "dueAt", "asc"))).toEqual(["c", "a", "d", "b"]);
    expect(ids(sortTasks(sample, "dueAt", "desc"))).toEqual(["d", "a", "c", "b"]);
  });

  it("sorts updatedAt and version", () => {
    const tasks = [
      makeTask("x", { updatedAt: d(5), version: 2 }),
      makeTask("y", { updatedAt: d(3), version: 9 }),
      makeTask("z", { updatedAt: d(4), version: 1 }),
    ];
    expect(ids(sortTasks(tasks, "updatedAt", "asc"))).toEqual(["y", "z", "x"]);
    expect(ids(sortTasks(tasks, "version", "desc"))).toEqual(["y", "x", "z"]);
  });

  it("breaks dueAt ties with a later key", () => {
    const tied = [
      makeTask("p", { dueAt: d(5), title: "b" }),
      makeTask("q", { dueAt: d(5), title: "a" }),
      makeTask("r", { dueAt: null, title: "a" }),
    ];
    const out = sortTasksBy(tied, [
      { by: "dueAt", direction: "asc" },
      { by: "title", direction: "asc" },
    ]);
    expect(ids(out)).toEqual(["q", "p", "r"]);
  });
});

describe("groupBy hostile keys", () => {
  it("does not let keys like __proto__ or constructor corrupt the result", () => {
    const grouped = groupBy(["a", "b", "c"], (s) => (s === "a" ? "__proto__" : "constructor"));
    expect(Object.keys(grouped).sort()).toEqual(["__proto__", "constructor"]);
    expect(grouped["__proto__"]).toEqual(["a"]);
    expect(grouped["constructor"]).toEqual(["b", "c"]);
    const probe: Record<string, unknown> = {};
    expect(probe["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(grouped)).toBeNull();
  });
});

describe("properties", () => {
  const taskArb = fc
    .record({
      id: fc.uuid(),
      title: fc.string({ maxLength: 8 }),
      tag: fc.constantFrom("a", "b", "c"),
      day: fc.integer({ min: 1, max: 28 }),
    })
    .map((r) => makeTask(r.id, { title: r.title, tags: [r.tag], createdAt: d(r.day) }));

  it("filtering is idempotent and never returns more than the input", () => {
    fc.assert(
      fc.property(fc.array(taskArb), fc.string({ maxLength: 3 }), (tasks, query) => {
        const once = filterTasks(tasks, { query });
        expect(once.length).toBeLessThanOrEqual(tasks.length);
        expect(ids(filterTasks(once, { query }))).toEqual(ids(once));
      }),
    );
  });

  it("an all-of filter is always a subset of the any-of filter on the same tags", () => {
    fc.assert(
      fc.property(fc.array(taskArb), fc.subarray(["a", "b", "c"], { minLength: 1 }), (tasks, t) => {
        const all = new Set(ids(filterTasks(tasks, { allTags: t })));
        const any = new Set(ids(filterTasks(tasks, { tags: t })));
        for (const id of all) expect(any.has(id)).toBe(true);
      }),
    );
  });
});
