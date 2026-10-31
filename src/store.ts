import { type Clock, type TaskApi, VersionConflictError } from "./api";
import type { AuditLog } from "./audit";
import { type Conflict, summarizeTask } from "./conflict";
import { type ErrorReporter, createEmitter } from "./emitter";
import { tasksEqual } from "./equality";
import type { MetricsSink } from "./metrics";
import { reconcileTask } from "./pagination";
import { type RetryOptions, withRetry } from "./retry";
import { errorMessage } from "./timing";
import { type Task, type TaskId, type TaskPatch, assertNever } from "./types";
import { checkPatchAgainstTask, parseTask, parseTaskPatch } from "./validation";

export interface StoreState {
  readonly tasks: readonly Task[];
  /** Latest mutation failure, as plain text. Rendered in an aria-live alert region. */
  readonly error: string | null;
  /** Number of unconfirmed mutations per task id. Absent means nothing is pending. */
  readonly pending: Readonly<Record<string, number>>;
  /** Stale edits the server refused. They are never applied over newer data. */
  readonly conflicts: readonly Conflict[];
}

/** What a caller asks for (intent). */
export type TaskCommand =
  | { type: "add"; task: Task }
  | { type: "update"; id: TaskId; patch: TaskPatch }
  | { type: "toggle"; id: TaskId }
  | { type: "delete"; id: TaskId };

/** What the reducer applies. Timestamps are decided before the reducer, so it stays pure. */
export type TaskAction =
  | { type: "add"; task: Task }
  | { type: "update"; id: TaskId; patch: TaskPatch; at: Date }
  | { type: "toggle"; id: TaskId; completed: boolean; at: Date }
  | { type: "delete"; id: TaskId }
  /** Server-authoritative replacement (after a conflict or a hydrate). */
  | { type: "sync"; task: Task };

/**
 * Pure: never mutates `tasks`; unchanged tasks keep their identity. Every accepted edit
 * bumps `version` by one and stamps `updatedAt`, exactly as the server does, so the
 * optimistic view and the confirmed view agree.
 */
export function taskReducer(tasks: readonly Task[], action: TaskAction): readonly Task[] {
  switch (action.type) {
    case "add":
      return tasks.some((t) => t.id === action.task.id) ? tasks : [...tasks, action.task];
    case "update":
      return tasks.map((t) =>
        t.id === action.id
          ? { ...t, ...action.patch, version: t.version + 1, updatedAt: action.at }
          : t,
      );
    case "toggle":
      return tasks.map((t) =>
        t.id === action.id
          ? {
              ...t,
              completedAt: action.completed ? action.at : null,
              version: t.version + 1,
              updatedAt: action.at,
            }
          : t,
      );
    case "delete":
      return tasks.filter((t) => t.id !== action.id);
    case "sync":
      return tasks.some((t) => t.id === action.task.id)
        ? tasks.map((t) => (t.id === action.task.id ? action.task : t))
        : [...tasks, action.task];
    default:
      return assertNever(action);
  }
}

function samePending(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

function sameState(a: StoreState, b: StoreState): boolean {
  return (
    a.error === b.error &&
    a.conflicts.length === b.conflicts.length &&
    a.conflicts.every((c, i) => c === b.conflicts[i]) &&
    samePending(a.pending, b.pending) &&
    a.tasks.length === b.tasks.length &&
    a.tasks.every((t, i) => {
      const other = b.tasks[i];
      return other !== undefined && tasksEqual(t, other);
    })
  );
}

interface Pending {
  readonly taskId: TaskId;
  readonly action: TaskAction;
  /** True once the server accepted it; it folds into `confirmed` when it reaches the head. */
  settled: boolean;
}

/** Raised for an operation skipped because its task has an unresolved conflict. */
class BlockedByConflictError extends Error {
  constructor() {
    super("Skipped: this task has an unresolved conflict");
    this.name = "BlockedByConflictError";
  }
}

export interface TaskStore {
  getState(): StoreState;
  subscribe(listener: (state: StoreState) => void): () => void;
  dispatch(command: TaskCommand): Promise<void>;
  addTask(task: Task): Promise<void>;
  updateTask(id: TaskId, patch: TaskPatch): Promise<void>;
  toggleComplete(id: TaskId): Promise<void>;
  deleteTask(id: TaskId): Promise<void>;
  /** Resolves a conflict: "server" keeps the server copy, "local" replays the refused change. */
  resolveConflict(id: TaskId, choice: "server" | "local"): Promise<void>;
  /**
   * Merges a server snapshot into the confirmed state without disturbing pending
   * mutations. A stale snapshot cannot overwrite newer data (reconcileTask decides).
   * Pass `removeMissing` only for a COMPLETE snapshot: tasks absent from it are dropped.
   */
  hydrate(tasks: readonly Task[], options?: { removeMissing?: boolean }): void;
  clearError(): void;
}

export interface StoreOptions {
  initialTasks?: readonly Task[];
  now?: Clock;
  audit?: AuditLog;
  metrics?: MetricsSink;
  /** Retry policy for each API call. Defaults to a single attempt. */
  retry?: Omit<RetryOptions, "signal" | "metrics" | "onRetry">;
  /** Per-call timeout so a hung request cannot leave a mutation pending forever. */
  mutationTimeoutMs?: number;
  onListenerError?: ErrorReporter;
}

/**
 * Optimistic store.
 *
 * Model: visible state = `confirmed` (what the server accepted) with every unconfirmed
 * mutation re-applied on top, in the order the mutations were issued.
 *
 * Sequencing rule (per task): API calls for one task are sent strictly one after
 * another, so the server sees them in issue order and can never end up older than the
 * UI. Calls for different tasks run in parallel. Confirmations are folded into
 * `confirmed` in global issue order, so a later success is never overwritten by an
 * earlier one.
 *
 * Rollback rule: a failed mutation is removed and the visible state is recomputed. A
 * rollback that arrives AFTER a newer mutation on the same task succeeded removes only
 * the failed change; the newer success stays. If the newer one fails but the older one
 * succeeded, the task returns to the older result, not to the original.
 *
 * Conflict rule: if the server refuses a mutation as stale, the local change is NOT
 * forced through. The server copy becomes the confirmed copy, the refused change is
 * kept in `conflicts` for the user to resolve, and queued edits to that task are
 * skipped until it is resolved.
 */
export function createTaskStore(api: TaskApi, options: StoreOptions = {}): TaskStore {
  const now = options.now ?? (() => new Date());
  const { audit, metrics } = options;
  let confirmed: readonly Task[] = options.initialTasks ?? [];
  let pending: Pending[] = [];
  let conflicts: readonly Conflict[] = [];
  let state: StoreState = { tasks: confirmed, error: null, pending: {}, conflicts };
  const emitter = createEmitter<StoreState>(options.onListenerError);
  const chains = new Map<string, Promise<void>>();
  const serverVersions = new Map<string, number>();
  const blocked = new Set<string>();

  function pendingCounts(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const p of pending) {
      if (!p.settled) counts[p.taskId] = (counts[p.taskId] ?? 0) + 1;
    }
    return counts;
  }

  /** Recomputes visible state and notifies subscribers once, only if something changed. */
  function commit(error?: string | null): void {
    const next: StoreState = {
      tasks: pending.reduce<readonly Task[]>((acc, p) => taskReducer(acc, p.action), confirmed),
      error: error === undefined ? state.error : error,
      pending: pendingCounts(),
      conflicts,
    };
    if (sameState(state, next)) return;
    state = next;
    emitter.emit(next);
  }

  function drain(): void {
    for (let head = pending[0]; head?.settled; head = pending[0]) {
      confirmed = taskReducer(confirmed, head.action);
      pending = pending.slice(1);
    }
  }

  const visible = (id: TaskId): Task | undefined => state.tasks.find((t) => t.id === id);

  /** The version the server holds, as far as this client's own completed writes know. */
  function expectedVersion(id: TaskId): number {
    return serverVersions.get(id) ?? confirmed.find((t) => t.id === id)?.version ?? 0;
  }

  function fail(message: string): Promise<void> {
    commit(message);
    return Promise.resolve();
  }

  function handleConflict(entry: Pending, conflict: VersionConflictError): void {
    const { server } = conflict;
    const local = taskReducer([server], entry.action)[0] ?? server;
    const patch = entry.action.type === "update" ? entry.action.patch : null;
    const record: Conflict = {
      taskId: entry.taskId,
      intent: entry.action.type === "delete" ? "delete" : "update",
      patch:
        patch ??
        (entry.action.type === "toggle"
          ? { completedAt: entry.action.completed ? entry.action.at : null }
          : null),
      local: summarizeTask(local),
      server: summarizeTask(server),
    };
    confirmed = taskReducer(confirmed, { type: "sync", task: server });
    // Earlier accepted edits to this task are already part of the server copy; folding them
    // again later would apply them twice.
    pending = pending.filter((p) => !(p.taskId === entry.taskId && p.settled));
    serverVersions.set(entry.taskId, server.version);
    blocked.add(entry.taskId);
    conflicts = [...conflicts.filter((c) => c.taskId !== entry.taskId), record];
    metrics?.recordConflict();
  }

  async function mutate(
    taskId: TaskId,
    action: TaskAction,
    send: (expected: number) => Promise<void>,
    failure: string,
    audited: { type: "add" | "edit" | "complete" | "delete"; summary: string },
  ): Promise<void> {
    const entry: Pending = { taskId, action, settled: false };
    pending = [...pending, entry];
    // Recorded and committed before anything can throw, so state and trail stay in step.
    audit?.record(audited.type, audited.summary, taskId);
    commit(null);

    const previous = chains.get(taskId) ?? Promise.resolve();
    const run = previous.then(() => {
      if (blocked.has(taskId)) throw new BlockedByConflictError();
      return withRetry(() => send(expectedVersion(taskId)), {
        maxAttempts: 1,
        ...options.retry,
        timeoutMs: options.mutationTimeoutMs ?? 10_000,
        ...(metrics === undefined ? {} : { metrics }),
        onRetry: ({ attempt }) =>
          audit?.record("retry", `Retrying ${failure} (attempt ${attempt})`, taskId),
      });
    });
    chains.set(
      taskId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );

    try {
      await run;
      entry.settled = true;
      if (action.type === "delete") serverVersions.delete(taskId);
      else if (action.type === "add") serverVersions.set(taskId, action.task.version);
      else serverVersions.set(taskId, expectedVersion(taskId) + 1);
      drain();
      commit();
    } catch (e) {
      pending = pending.filter((p) => p !== entry);
      let message = `${failure}: ${errorMessage(e)}`;
      if (e instanceof VersionConflictError) {
        handleConflict(entry, e);
        message = `${failure}: this task changed elsewhere; review the conflict`;
      } else if (!(e instanceof BlockedByConflictError)) {
        metrics?.recordMutationFailure();
      }
      audit?.record("rollback", message, taskId);
      drain();
      commit(message);
    }
  }

  function dispatch(command: TaskCommand): Promise<void> {
    switch (command.type) {
      case "add": {
        const parsed = parseTask(command.task);
        if (!parsed.ok) return fail(`Invalid task: ${parsed.errors.join("; ")}`);
        const { task } = parsed;
        if (visible(task.id)) return Promise.resolve();
        return mutate(
          task.id,
          { type: "add", task },
          () => api.addTask(task),
          "Could not add task",
          { type: "add", summary: `Added task ${task.title}` },
        );
      }
      case "update": {
        const current = visible(command.id);
        if (!current) return Promise.resolve();
        const parsed = parseTaskPatch(command.patch);
        if (!parsed.ok) return fail(`Invalid update: ${parsed.errors.join("; ")}`);
        const patchError = checkPatchAgainstTask(current, parsed.value);
        if (patchError !== null) return fail(`Invalid update: ${patchError}`);
        const patch = parsed.value;
        return mutate(
          command.id,
          { type: "update", id: command.id, patch, at: now() },
          (expected) => api.updateTask(command.id, patch, expected),
          "Could not update task",
          { type: "edit", summary: `Edited task ${current.title}` },
        );
      }
      case "toggle": {
        const current = visible(command.id);
        if (!current) return Promise.resolve();
        const completed = current.completedAt === null;
        const at = now();
        return mutate(
          command.id,
          { type: "toggle", id: command.id, completed, at },
          (expected) =>
            api.updateTask(command.id, { completedAt: completed ? at : null }, expected),
          "Could not update task",
          {
            type: "complete",
            summary: `${completed ? "Completed" : "Reopened"} task ${current.title}`,
          },
        );
      }
      case "delete": {
        const current = visible(command.id);
        if (!current) return Promise.resolve();
        return mutate(
          command.id,
          { type: "delete", id: command.id },
          (expected) => api.deleteTask(command.id, expected),
          "Could not delete task",
          { type: "delete", summary: `Deleted task ${current.title}` },
        );
      }
      default:
        return assertNever(command);
    }
  }

  async function resolveConflict(id: TaskId, choice: "server" | "local"): Promise<void> {
    const conflict = conflicts.find((c) => c.taskId === id);
    if (!conflict) return;
    conflicts = conflicts.filter((c) => c !== conflict);
    blocked.delete(id);
    commit();
    if (choice === "server") return;
    if (conflict.intent === "delete") return dispatch({ type: "delete", id });
    if (conflict.patch !== null) return dispatch({ type: "update", id, patch: conflict.patch });
  }

  function hydrate(tasks: readonly Task[], opts: { removeMissing?: boolean } = {}): void {
    const serverIds = new Set(tasks.map((t) => t.id));
    // Fold accepted-but-unfolded edits for these tasks first, so the snapshot is compared
    // with our latest confirmed copy instead of being layered under it.
    for (const p of pending) {
      if (p.settled && serverIds.has(p.taskId)) confirmed = taskReducer(confirmed, p.action);
    }
    pending = pending.filter((p) => !(p.settled && serverIds.has(p.taskId)));
    const pendingAdds = new Set<string>(
      pending.filter((p) => p.action.type === "add").map((p) => p.taskId),
    );
    let next: readonly Task[] =
      opts.removeMissing === true
        ? confirmed.filter((t) => serverIds.has(t.id) || pendingAdds.has(t.id))
        : confirmed;
    for (const incoming of tasks) {
      const existing = next.find((t) => t.id === incoming.id);
      const winner = existing === undefined ? incoming : reconcileTask(existing, incoming);
      next = taskReducer(next, { type: "sync", task: winner });
      const busy = pending.some((p) => p.taskId === incoming.id && !p.settled);
      if (!busy) serverVersions.set(incoming.id, winner.version);
    }
    confirmed = next;
    commit();
  }

  return {
    getState: () => state,
    subscribe: (listener) => emitter.subscribe(listener),
    dispatch,
    addTask: (task) => dispatch({ type: "add", task }),
    updateTask: (id, patch) => dispatch({ type: "update", id, patch }),
    toggleComplete: (id) => dispatch({ type: "toggle", id }),
    deleteTask: (id) => dispatch({ type: "delete", id }),
    resolveConflict,
    hydrate,
    clearError() {
      commit(null);
    },
  };
}
