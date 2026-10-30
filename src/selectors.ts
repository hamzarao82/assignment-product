import { filterTasks, sortTasksBy, type SortKey, type TaskFilter } from "./filters";
import type { Task } from "./types";

type Mutable<T extends readonly unknown[]> = { -readonly [K in keyof T]: T[K] };

/**
 * Memoized selector factory. `select` picks the inputs from the state as a tuple;
 * `combine` derives the result. While every input is unchanged (compared with
 * Object.is) the SAME result reference is returned and `combine` is not run again, so
 * a view layer can use `===` to skip re-rendering.
 */
export function createSelector<S, I extends readonly unknown[], R>(
  select: (state: S) => I,
  combine: (...inputs: Mutable<I>) => R,
): (state: S) => R {
  let last: { inputs: I; result: R } | null = null;
  return (state) => {
    const inputs = select(state);
    if (last !== null) {
      const previous = last.inputs;
      if (previous.length === inputs.length && inputs.every((v, i) => Object.is(v, previous[i]))) {
        return last.result;
      }
    }
    const result = combine(...inputs);
    last = { inputs, result };
    return result;
  };
}

export interface TaskView {
  readonly filter: TaskFilter;
  readonly sort: readonly SortKey[];
}

export interface TaskViewState {
  readonly tasks: readonly Task[];
  readonly view: TaskView;
}

/**
 * Filtered-then-sorted tasks for the current view. The result keeps its reference
 * until the task list, the filter or the sort keys change by identity, so callers should
 * hold on to their `view` objects instead of rebuilding them every render.
 */
export function createTaskViewSelector(): (state: TaskViewState) => readonly Task[] {
  return createSelector(
    (s: TaskViewState) => [s.tasks, s.view.filter, s.view.sort] as const,
    (tasks, filter, sort) => sortTasksBy(filterTasks(tasks, filter), sort),
  );
}
