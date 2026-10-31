import { describe, expect, it, vi } from "vitest";
import { createSelector, createTaskViewSelector, type TaskViewState } from "../src/selectors";
import type { Task } from "../src/types";
import { makeTask } from "./helpers";

interface State {
  items: readonly number[];
  factor: number;
  noise: string;
}

describe("createSelector", () => {
  const make = () => {
    const combine = vi.fn((items: readonly number[], factor: number) =>
      items.map((n) => n * factor),
    );
    const selector = createSelector((s: State) => [s.items, s.factor] as const, combine);
    return { selector, combine };
  };

  it("computes once and returns the same reference while inputs are unchanged", () => {
    const { selector, combine } = make();
    const state: State = { items: [1, 2], factor: 2, noise: "a" };
    const first = selector(state);
    expect(first).toEqual([2, 4]);
    expect(selector(state)).toBe(first);
    expect(selector({ ...state })).toBe(first); // a new state object, same inputs
    expect(combine).toHaveBeenCalledTimes(1);
  });

  it("ignores changes to state the selector does not read", () => {
    const { selector, combine } = make();
    const state: State = { items: [1], factor: 3, noise: "a" };
    const first = selector(state);
    expect(selector({ ...state, noise: "b" })).toBe(first);
    expect(combine).toHaveBeenCalledTimes(1);
  });

  it("recomputes when any single input changes by identity", () => {
    const { selector, combine } = make();
    const items = [1, 2];
    const first = selector({ items, factor: 2, noise: "" });
    const second = selector({ items, factor: 3, noise: "" });
    expect(second).not.toBe(first);
    expect(second).toEqual([3, 6]);
    const third = selector({ items: [1, 2], factor: 3, noise: "" }); // equal contents, new array
    expect(third).not.toBe(second);
    expect(combine).toHaveBeenCalledTimes(3);
  });

  it("treats NaN as unchanged (Object.is semantics)", () => {
    const combine = vi.fn((n: number) => ({ n }));
    const selector = createSelector((s: { n: number }) => [s.n] as const, combine);
    const first = selector({ n: Number.NaN });
    expect(selector({ n: Number.NaN })).toBe(first);
    expect(combine).toHaveBeenCalledTimes(1);
  });

  it("keeps independent selectors independent", () => {
    const a = make();
    const b = make();
    const state: State = { items: [1], factor: 1, noise: "" };
    a.selector(state);
    b.selector(state);
    a.selector({ ...state, factor: 2 });
    expect(a.combine).toHaveBeenCalledTimes(2);
    expect(b.combine).toHaveBeenCalledTimes(1);
  });
});

describe("createTaskViewSelector", () => {
  const tasks: readonly Task[] = [
    makeTask("a", { title: "b", priority: "low" }),
    makeTask("b", { title: "a", priority: "high" }),
    makeTask("c", { title: "c", priority: "high" }),
  ];
  const view = {
    filter: { priority: "high" as const },
    sort: [{ by: "title" as const, direction: "asc" as const }],
  };
  const state: TaskViewState = { tasks, view };

  it("filters then sorts", () => {
    const select = createTaskViewSelector();
    expect(select(state).map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("returns the same reference until the tasks, filter or sort change", () => {
    const select = createTaskViewSelector();
    const first = select(state);
    expect(select({ tasks, view })).toBe(first);
    expect(select({ tasks, view: { ...view } })).toBe(first); // same filter and sort objects
    expect(select({ tasks: [...tasks], view })).not.toBe(first);
    const withNewFilter = select({ tasks, view: { ...view, filter: { priority: "low" } } });
    expect(withNewFilter.map((t) => t.id)).toEqual(["a"]);
  });

  it("does not mutate the task list it was given", () => {
    const frozen = Object.freeze([...tasks]);
    const select = createTaskViewSelector();
    expect(() => select({ tasks: frozen, view })).not.toThrow();
    expect(frozen.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});
