import { RetryableError, type TaskApi, VersionConflictError } from "./api";
import type { AuditLog } from "./audit";
import { type ErrorReporter, createEmitter } from "./emitter";
import { serializeTask } from "./importExport";
import type { MetricsSink } from "./metrics";
import { type RetryOptions, withRetry } from "./retry";
import { isAbortError } from "./timing";
import { type Result, type Task, type TaskId, type TaskPatch, toTaskId } from "./types";
import { parseTask, parseTaskPatch } from "./validation";

export type QueuedOp =
  | { readonly kind: "add"; readonly task: Task }
  | {
      readonly kind: "update";
      readonly taskId: TaskId;
      readonly patch: TaskPatch;
      readonly expectedVersion: number;
    }
  | { readonly kind: "delete"; readonly taskId: TaskId; readonly expectedVersion: number };

/** Why a queued operation finally failed. Categories only: no server or user text. */
export type FailureReason = "network" | "timeout" | "conflict" | "rejected";

export type QueueStatus = "idle" | "waiting" | "replaying" | "stopped";

/** Safe to show and to put in a bug report: counts and categories, never task text. */
export interface QueueState {
  readonly online: boolean;
  readonly depth: number;
  readonly status: QueueStatus;
  readonly failed: { readonly kind: QueuedOp["kind"]; readonly reason: FailureReason } | null;
}

export interface OfflineQueueOptions {
  execute: (op: QueuedOp, signal: AbortSignal) => Promise<void>;
  online?: boolean;
  /** Retry policy per operation during replay. Defaults to three attempts. */
  retry?: Omit<RetryOptions, "signal" | "metrics" | "onRetry">;
  metrics?: MetricsSink;
  audit?: AuditLog;
  onListenerError?: ErrorReporter;
}

export interface RestoreReport {
  restored: number;
  rejected: number;
}

export interface OfflineQueue {
  /**
   * Adds an operation. The promise settles when it has been executed successfully, and
   * rejects with the underlying error if it is discarded or the queue is disposed.
   */
  enqueue(op: QueuedOp): Promise<void>;
  setOnline(online: boolean): void;
  getState(): QueueState;
  subscribe(listener: (state: QueueState) => void): () => void;
  /** Retries the operation that stopped the queue, then carries on replaying. */
  retry(): Promise<void>;
  /** Drops the operation that stopped the queue (rejecting its promise) and carries on. */
  discard(): void;
  serialize(): string;
  /** Rebuilds an EMPTY queue from serialized text, validating every entry from unknown. */
  restore(raw: unknown): Result<RestoreReport>;
  /** Aborts in-flight work and rejects everything still queued. */
  dispose(): void;
}

const SCHEMA_VERSION = 1;

interface Entry {
  readonly id: number;
  readonly op: QueuedOp;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function classify(error: unknown): FailureReason {
  if (error instanceof VersionConflictError) return "conflict";
  if (error instanceof RetryableError) return error.kind;
  return "rejected";
}

function serializePatch(patch: TaskPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.title !== undefined) out["title"] = patch.title;
  if (patch.priority !== undefined) out["priority"] = patch.priority;
  if (patch.tags !== undefined) out["tags"] = [...patch.tags];
  if (patch.completedAt !== undefined) {
    out["completedAt"] = patch.completedAt === null ? null : patch.completedAt.toISOString();
  }
  if (patch.dueAt !== undefined) {
    out["dueAt"] = patch.dueAt === null ? null : patch.dueAt.toISOString();
  }
  return out;
}

function serializeOp(op: QueuedOp): Record<string, unknown> {
  switch (op.kind) {
    case "add":
      return { kind: "add", task: serializeTask(op.task) };
    case "update":
      return {
        kind: "update",
        taskId: op.taskId,
        patch: serializePatch(op.patch),
        expectedVersion: op.expectedVersion,
      };
    case "delete":
      return { kind: "delete", taskId: op.taskId, expectedVersion: op.expectedVersion };
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function parseVersion(x: unknown): number | null {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null;
}

function parseTaskId(x: unknown): TaskId | null {
  return typeof x === "string" && x.trim() !== "" ? toTaskId(x) : null;
}

/** Validates one serialized operation from unknown. Never throws. */
function parseOp(raw: unknown): Result<QueuedOp> {
  if (!isRecord(raw)) return { ok: false, errors: ["operation must be an object"] };
  const kind = raw["kind"];
  if (kind === "add") {
    const parsed = parseTask(raw["task"]);
    return parsed.ok
      ? { ok: true, value: { kind: "add", task: parsed.task } }
      : { ok: false, errors: parsed.errors };
  }
  if (kind === "update" || kind === "delete") {
    const errors: string[] = [];
    const taskId = parseTaskId(raw["taskId"]);
    if (taskId === null) errors.push("taskId must be a non-empty string");
    const expectedVersion = parseVersion(raw["expectedVersion"]);
    if (expectedVersion === null) errors.push("expectedVersion must be a non-negative integer");
    if (kind === "delete") {
      return taskId !== null && expectedVersion !== null
        ? { ok: true, value: { kind: "delete", taskId, expectedVersion } }
        : { ok: false, errors };
    }
    const patch = parseTaskPatch(raw["patch"]);
    if (!patch.ok) errors.push(...patch.errors);
    return taskId !== null && expectedVersion !== null && patch.ok
      ? { ok: true, value: { kind: "update", taskId, patch: patch.value, expectedVersion } }
      : { ok: false, errors };
  }
  return { ok: false, errors: ["unknown operation kind"] };
}

export function createOfflineQueue(options: OfflineQueueOptions): OfflineQueue {
  const { metrics, audit } = options;
  let online = options.online ?? true;
  const entries: Entry[] = [];
  let failed: { entry: Entry; error: unknown; reason: FailureReason } | null = null;
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let disposed = false;
  let nextId = 1;
  const emitter = createEmitter<QueueState>(options.onListenerError);
  let state: QueueState = compute();

  function compute(): QueueState {
    const depth = entries.length;
    let status: QueueStatus = "idle";
    if (failed !== null) status = "stopped";
    else if (depth > 0) status = online && !disposed ? "replaying" : "waiting";
    return {
      online,
      depth,
      status,
      failed: failed === null ? null : { kind: failed.entry.op.kind, reason: failed.reason },
    };
  }

  /** Publishes the new state once, only if it differs from the last one. */
  function emit(): void {
    const next = compute();
    const same =
      next.online === state.online &&
      next.depth === state.depth &&
      next.status === state.status &&
      next.failed?.kind === state.failed?.kind &&
      next.failed?.reason === state.failed?.reason;
    metrics?.setQueueDepth(next.depth);
    if (same) return;
    state = next;
    emitter.emit(next);
  }

  function taskIdOf(op: QueuedOp): string {
    return op.kind === "add" ? op.task.id : op.taskId;
  }

  /** Replays strictly one operation at a time, in order, and stops on a final failure. */
  function pump(): Promise<void> {
    if (running !== null) return running;
    if (disposed || !online || failed !== null || entries.length === 0) return Promise.resolve();
    running = (async () => {
      try {
        while (!disposed && online && failed === null) {
          const entry = entries[0];
          if (entry === undefined) break;
          const ctrl = new AbortController();
          controller = ctrl;
          emit();
          try {
            await withRetry((signal) => options.execute(entry.op, signal), {
              maxAttempts: 3,
              timeoutMs: 10_000,
              ...options.retry,
              signal: ctrl.signal,
              ...(metrics === undefined ? {} : { metrics }),
            });
            entries.shift();
            entry.resolve();
          } catch (error) {
            // Going offline (or disposing) aborts the attempt; the operation stays at the
            // head and is replayed later. Anything else is a final failure: stop here.
            if (isAbortError(error)) break;
            failed = { entry, error, reason: classify(error) };
          } finally {
            if (controller === ctrl) controller = null;
          }
          emit();
        }
      } finally {
        running = null;
        emit();
        // The connection may have flapped (dropped and returned) while the aborted attempt
        // was still unwinding; if work remains and we may run, start again instead of stalling.
        if (!disposed && online && failed === null && entries.length > 0) void pump();
      }
    })();
    return running;
  }

  return {
    enqueue(op) {
      if (disposed) return Promise.reject(new Error("Queue disposed"));
      return new Promise<void>((resolve, reject) => {
        entries.push({ id: nextId++, op, resolve, reject });
        emit();
        void pump();
      });
    },
    setOnline(next) {
      if (next === online) return;
      online = next;
      if (!online) controller?.abort();
      emit();
      if (online) void pump();
    },
    getState: () => state,
    subscribe: (listener) => emitter.subscribe(listener),
    retry() {
      if (failed === null) return running ?? Promise.resolve();
      const current = failed;
      failed = null;
      audit?.record(
        "retry",
        `Retrying queued ${current.entry.op.kind}`,
        taskIdOf(current.entry.op),
      );
      emit();
      return pump();
    },
    discard() {
      if (failed === null) return;
      const current = failed;
      failed = null;
      entries.shift(); // a final failure always stops the queue at its head
      audit?.record(
        "rollback",
        `Discarded queued ${current.entry.op.kind}`,
        taskIdOf(current.entry.op),
      );
      current.entry.reject(current.error);
      emit();
      void pump();
    },
    serialize() {
      return JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        ops: entries.map((e) => ({ id: e.id, op: serializeOp(e.op) })),
      });
    },
    restore(raw) {
      if (entries.length > 0) {
        return { ok: false, errors: ["queue must be empty before restoring"] };
      }
      let doc: unknown = raw;
      if (typeof raw === "string") {
        try {
          doc = JSON.parse(raw);
        } catch {
          return { ok: false, errors: ["queue data is not valid JSON"] };
        }
      }
      const ops: unknown = isRecord(doc) ? doc["ops"] : undefined;
      if (!isRecord(doc) || doc["schemaVersion"] !== SCHEMA_VERSION || !Array.isArray(ops)) {
        return { ok: false, errors: ["queue data has an unsupported shape or version"] };
      }
      let restored = 0;
      let rejected = 0;
      for (const candidate of ops) {
        const item: unknown = candidate;
        const parsed = isRecord(item) ? parseOp(item["op"]) : parseOp(item);
        if (!parsed.ok) {
          rejected++;
          continue;
        }
        // Nobody awaits a restored operation, so its promise callbacks do nothing.
        entries.push({
          id: nextId++,
          op: parsed.value,
          resolve: () => undefined,
          reject: () => undefined,
        });
        restored++;
      }
      emit();
      void pump();
      return { ok: true, value: { restored, rejected } };
    },
    dispose() {
      disposed = true;
      controller?.abort();
      const pending = entries.splice(0);
      failed = null;
      for (const entry of pending) entry.reject(new Error("Queue disposed"));
      emit();
    },
  };
}

function executeOn(api: TaskApi, op: QueuedOp): Promise<void> {
  switch (op.kind) {
    case "add":
      return api.addTask(op.task);
    case "update":
      return api.updateTask(op.taskId, op.patch, op.expectedVersion);
    case "delete":
      return api.deleteTask(op.taskId, op.expectedVersion);
  }
}

/**
 * Wraps a TaskApi so every write goes through the offline queue. Hand the returned api
 * to createTaskStore: while offline the store keeps its optimistic view (the call simply
 * has not finished yet). Create that store with `mutationTimeoutMs: Infinity`, otherwise
 * its own per-call timeout would roll the change back while the device is offline.
 */
export function createQueuedTaskApi(
  api: TaskApi,
  options: Omit<OfflineQueueOptions, "execute"> = {},
): { api: TaskApi; queue: OfflineQueue } {
  const queue = createOfflineQueue({ ...options, execute: (op) => executeOn(api, op) });
  return {
    queue,
    api: {
      addTask: (task) => queue.enqueue({ kind: "add", task }),
      updateTask: (taskId, patch, expectedVersion) =>
        queue.enqueue({ kind: "update", taskId, patch, expectedVersion }),
      deleteTask: (taskId, expectedVersion) =>
        queue.enqueue({ kind: "delete", taskId, expectedVersion }),
    },
  };
}
