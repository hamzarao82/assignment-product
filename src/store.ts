import type { TaskApi, TaskChanges } from "./api";
import { errorMessage } from "./timing";
import { type Task, type TaskId, assertNever } from "./types";

export interface StoreState {
  readonly tasks: readonly Task[];
  readonly error: string | null;
}

export type TaskAction =
  | { type: "add"; task: Task }
  | { type: "update"; id: TaskId; changes: TaskChanges }
  | { type: "toggle"; id: TaskId; completed: boolean; now: Date }
  | { type: "delete"; id: TaskId };

/** Pure: never mutates `tasks`; unchanged tasks keep their identity. */
export function taskReducer(tasks: readonly Task[], action: TaskAction): readonly Task[] {
  switch (action.type) {
    case "add":
      return tasks.some((t) => t.id === action.task.id) ? tasks : [...tasks, action.task];
    case "update":
      return tasks.map((t) => (t.id === action.id ? { ...t, ...action.changes } : t));
    case "toggle":
      return tasks.map((t) =>
        t.id === action.id ? { ...t, completedAt: action.completed ? action.now : null } : t,
      );
    case "delete":
      return tasks.filter((t) => t.id !== action.id);
    default:
      return assertNever(action);
  }
}

function sameTask(a: Task, b: Task): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.title === b.title &&
      a.priority === b.priority &&
      a.completedAt?.getTime() === b.completedAt?.getTime() &&
      a.createdAt.getTime() === b.createdAt.getTime() &&
      a.tags.length === b.tags.length &&
      a.tags.every((tag, i) => tag === b.tags[i]))
  );
}

function sameState(a: StoreState, b: StoreState): boolean {
  return (
    a.error === b.error &&
    a.tasks.length === b.tasks.length &&
    a.tasks.every((t, i) => {
      const other = b.tasks[i];
      return other !== undefined && sameTask(t, other);
    })
  );
}

interface Pending {
  readonly action: TaskAction;
  settled: boolean;
}

export interface TaskStore {
  getState(): StoreState;
  subscribe(listener: (state: StoreState) => void): () => void;
  addTask(task: Task): Promise<void>;
  updateTask(id: TaskId, changes: TaskChanges): Promise<void>;
  toggleComplete(id: TaskId): Promise<void>;
  deleteTask(id: TaskId): Promise<void>;
  clearError(): void;
}

/**
 * Optimistic store.
 *
 * Model: visible state = `confirmed` (what the server accepted) with every pending
 * mutation re-applied on top, in the order the mutations were issued.
 *
 * Ordering rule: confirmations are folded into `confirmed` strictly in issue order,
 * so a later success can never be overwritten by an earlier one.
 *
 * Rollback rule: a failed mutation is simply removed from the pending list and the
 * visible state is recomputed. Consequently:
 *  - if a rollback arrives AFTER a newer mutation on the same task succeeded, only the
 *    failed change disappears; the newer successful change stays applied.
 *  - if the newer mutation fails but the older one succeeded, the task returns to the
 *    older mutation's result (not all the way back to the original).
 */
export function createTaskStore(
  api: TaskApi,
  options: { initialTasks?: readonly Task[]; now?: () => Date } = {},
): TaskStore {
  const now = options.now ?? (() => new Date());
  let confirmed: readonly Task[] = options.initialTasks ?? [];
  let pending: Pending[] = [];
  let state: StoreState = { tasks: confirmed, error: null };
  const listeners = new Set<(state: StoreState) => void>();
  const queue: StoreState[] = [];
  let delivering = false;

  /** Recomputes visible state and notifies listeners once, only if something changed. */
  function commit(error?: string | null): void {
    const next: StoreState = {
      tasks: pending.reduce<readonly Task[]>((acc, p) => taskReducer(acc, p.action), confirmed),
      error: error === undefined ? state.error : error,
    };
    if (sameState(state, next)) return;
    state = next;
    notify(next);
  }

  /**
   * Delivers each state to every listener exactly once, in order. A listener may call
   * store actions from inside its callback: the resulting state is queued and delivered
   * after the current delivery finishes, instead of re-entering the loop (which would
   * hand the newest state to the remaining listeners twice).
   */
  function notify(next: StoreState): void {
    queue.push(next);
    if (delivering) return;
    delivering = true;
    try {
      for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
        for (const listener of [...listeners]) {
          if (listeners.has(listener)) listener(s);
        }
      }
    } finally {
      delivering = false;
    }
  }

  function drain(): void {
    for (let head = pending[0]; head?.settled; head = pending[0]) {
      confirmed = taskReducer(confirmed, head.action);
      pending = pending.slice(1);
    }
  }

  async function mutate(
    action: TaskAction,
    call: () => Promise<void>,
    failure: string,
  ): Promise<void> {
    const entry: Pending = { action, settled: false };
    pending = [...pending, entry];
    commit(null);
    try {
      await call();
      entry.settled = true;
      drain();
      commit();
    } catch (e) {
      pending = pending.filter((p) => p !== entry);
      drain();
      commit(`${failure}: ${errorMessage(e)}`);
    }
  }

  const find = (id: TaskId): Task | undefined => state.tasks.find((t) => t.id === id);

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    addTask(task) {
      if (find(task.id)) return Promise.resolve();
      return mutate({ type: "add", task }, () => api.addTask(task), "Could not add task");
    },
    updateTask(id, changes) {
      if (!find(id)) return Promise.resolve();
      return mutate(
        { type: "update", id, changes },
        () => api.updateTask(id, changes),
        "Could not update task",
      );
    },
    toggleComplete(id) {
      const task = find(id);
      if (!task) return Promise.resolve();
      const completed = task.completedAt === null;
      const at = now();
      return mutate(
        { type: "toggle", id, completed, now: at },
        () => api.updateTask(id, { completedAt: completed ? at : null }),
        "Could not update task",
      );
    },
    deleteTask(id) {
      if (!find(id)) return Promise.resolve();
      return mutate({ type: "delete", id }, () => api.deleteTask(id), "Could not delete task");
    },
    clearError() {
      commit(null);
    },
  };
}
