import type { MetricsSink } from "./metrics";
import { sleep } from "./timing";
import { type Priority, type Task, type TaskId, type TaskPatch, toTaskId } from "./types";
import { parseTaskList } from "./validation";

/** Injectable randomness: tests pass a seeded generator so runs are deterministic. */
export type Rng = () => number;

/** Injectable clock: simulated data is generated relative to it, never to the wall clock. */
export type Clock = () => Date;

/** Small deterministic PRNG (mulberry32). */
export function createSeededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Transient failures: worth retrying. */
export class RetryableError extends Error {
  readonly kind: "network" | "timeout";
  constructor(kind: "network" | "timeout", message: string) {
    super(message);
    this.name = "RetryableError";
    this.kind = kind;
  }
}

/** Permanent failures (e.g. the server sent invalid data): retrying cannot help. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/**
 * The server rejected a mutation because the client's copy was stale. Carries the
 * server's current task so the caller can show both sides instead of overwriting.
 * Permanent for this attempt: replaying the same stale mutation cannot succeed.
 */
export class VersionConflictError extends Error {
  readonly server: Task;
  readonly expectedVersion: number;
  constructor(server: Task, expectedVersion: number) {
    super(`Version conflict: expected ${expectedVersion}, server has ${server.version}`);
    this.name = "VersionConflictError";
    this.server = server;
    this.expectedVersion = expectedVersion;
  }
}

/**
 * data/empty succeed; error is a retryable network failure; timeout is a retryable
 * timeout; invalid is a server payload that fails validation (never retried).
 */
export type Outcome = "data" | "empty" | "error" | "timeout" | "invalid";

export interface SimOptions {
  rng?: Rng;
  now?: Clock;
  minDelayMs?: number;
  maxDelayMs?: number;
  outcome?: Outcome | (() => Outcome);
  /** Raw server payload; validated with parseTaskList like any untrusted input. */
  payload?: unknown;
  signal?: AbortSignal | undefined;
  metrics?: MetricsSink;
}

export const SAMPLE_PAYLOAD: readonly unknown[] = [
  {
    id: "task-1",
    title: "Write the report",
    priority: "high",
    completedAt: null,
    createdAt: "2024-01-01T09:00:00.000Z",
    updatedAt: "2024-01-01T09:00:00.000Z",
    dueAt: "2024-02-01T09:00:00.000Z",
    tags: ["work"],
    version: 1,
  },
  {
    id: "task-2",
    title: "Buy groceries",
    priority: "low",
    completedAt: "2024-01-02T10:00:00.000Z",
    createdAt: "2024-01-01T10:00:00.000Z",
    updatedAt: "2024-01-02T10:00:00.000Z",
    dueAt: null,
    tags: ["home"],
    version: 2,
  },
];

const DEFAULT_NOW: Clock = () => new Date(Date.UTC(2024, 0, 31));

function pickDelay(opts: SimOptions): number {
  const rng = opts.rng ?? Math.random;
  const min = opts.minDelayMs ?? 50;
  const max = opts.maxDelayMs ?? 300;
  return min + rng() * (max - min);
}

function pickOutcome(opts: SimOptions): Outcome {
  const o = opts.outcome ?? "data";
  return typeof o === "function" ? o() : o;
}

/** Simulated network call: resolves with data, resolves empty, or rejects. */
export async function fetchTasks(opts: SimOptions = {}): Promise<Task[]> {
  await sleep(pickDelay(opts), opts.signal);
  switch (pickOutcome(opts)) {
    case "error":
      throw new RetryableError("network", "Network request failed");
    case "timeout":
      throw new RetryableError("timeout", "Request timed out");
    case "invalid":
      throw new NonRetryableError("Server returned invalid task data");
    case "empty":
      return [];
    case "data":
      break;
  }
  const { tasks, rejected } = parseTaskList(opts.payload ?? SAMPLE_PAYLOAD, "api");
  // Partial corruption must not be invisible: report how many records were dropped.
  opts.metrics?.recordRejectedRecords(rejected.length);
  if (tasks.length === 0 && rejected.length > 0) {
    throw new NonRetryableError("Server returned invalid task data");
  }
  return tasks;
}

export interface Page {
  items: Task[];
  nextCursor: string | null;
}

export interface PageSimOptions extends SimOptions {
  total?: number;
  pageSize?: number;
  /** Number of items each page repeats from the end of the previous page. */
  overlap?: number;
  /** Zero-based page indexes that always fail with a network error. */
  failPages?: readonly number[];
  /** Simulates a broken server whose every page points back at the cursor just requested. */
  cursorLoop?: boolean;
}

const PRIORITIES: readonly Priority[] = ["low", "medium", "high"];
const DAY_MS = 24 * 60 * 60 * 1000;

function makeSimTask(i: number, total: number, now: Date): Task {
  const createdAt = new Date(now.getTime() - (total - i) * DAY_MS);
  return {
    id: toTaskId(`task-${i}`),
    title: `Task ${i}`,
    priority: PRIORITIES[i % PRIORITIES.length] ?? "low",
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
    dueAt: i % 3 === 0 ? new Date(createdAt.getTime() + 7 * DAY_MS) : null,
    tags: [],
    version: 0,
  };
}

/** Cursors are plain non-negative integers; "10abc" or "1e3" are malformed, not 10 or 1. */
function parseCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  if (!/^\d+$/.test(cursor)) throw new NonRetryableError(`Invalid cursor: ${cursor.slice(0, 20)}`);
  const start = Number(cursor);
  if (!Number.isSafeInteger(start)) throw new NonRetryableError("Invalid cursor: out of range");
  return start;
}

/** Cursor-based pagination over a generated dataset; cursor is the start index. */
export async function fetchTasksPage(
  cursor: string | null,
  opts: PageSimOptions = {},
): Promise<Page> {
  const total = opts.total ?? 25;
  const pageSize = opts.pageSize ?? 10;
  const overlap = opts.overlap ?? 0;
  const start = parseCursor(cursor);
  await sleep(pickDelay(opts), opts.signal);
  if (opts.failPages?.includes(Math.floor(start / pageSize))) {
    throw new RetryableError("network", `Page starting at ${start} failed`);
  }
  const now = (opts.now ?? DEFAULT_NOW)();
  const from = Math.max(0, start - overlap);
  const end = Math.min(total, start + pageSize);
  const items: Task[] = [];
  for (let i = from; i < end; i++) items.push(makeSimTask(i, total, now));
  const nextCursor = opts.cursorLoop === true ? String(start) : end < total ? String(end) : null;
  return { items, nextCursor };
}

/** Mutation endpoints used by the store. Every write carries the version the client saw. */
export interface TaskApi {
  addTask(task: Task): Promise<void>;
  updateTask(id: TaskId, patch: TaskPatch, expectedVersion: number): Promise<void>;
  deleteTask(id: TaskId, expectedVersion: number): Promise<void>;
}

export interface SimulatedTaskServer extends TaskApi {
  /** The server-side tasks right now (a copy). */
  snapshot(): readonly Task[];
  /** Another client edits a task directly on the server, bumping its version. */
  externalUpdate(id: TaskId, patch: TaskPatch): void;
}

export type ServerOp = "add" | "update" | "delete";

export interface SimulatedServerOptions {
  initialTasks?: readonly Task[];
  rng?: Rng;
  now?: Clock;
  /** A fixed delay, or a function so tests can make some requests slower than others. */
  delayMs?: number | ((op: ServerOp, id: TaskId) => number);
  /** Chance (0..1) that a request fails with a retryable network error before applying. */
  failureRate?: number;
}

/**
 * In-memory server with real state. Changes are applied when a request ARRIVES (after its
 * delay), so out-of-order arrival is observable. Stale writes are refused with a
 * VersionConflictError instead of overwriting; add and delete are idempotent.
 */
export function createSimulatedTaskApi(opts: SimulatedServerOptions = {}): SimulatedTaskServer {
  const rng = opts.rng ?? Math.random;
  const now = opts.now ?? (() => new Date());
  const failureRate = opts.failureRate ?? 0;
  const tasks = new Map<string, Task>((opts.initialTasks ?? []).map((t) => [t.id, t]));
  const delayFor = (op: ServerOp, id: TaskId): number =>
    typeof opts.delayMs === "function" ? opts.delayMs(op, id) : (opts.delayMs ?? 100);

  async function arrive(op: ServerOp, id: TaskId): Promise<void> {
    await sleep(delayFor(op, id));
    if (rng() < failureRate) throw new RetryableError("network", "Mutation failed");
  }

  function applyPatch(task: Task, patch: TaskPatch): Task {
    return { ...task, ...patch, version: task.version + 1, updatedAt: now() };
  }

  return {
    async addTask(task) {
      await arrive("add", task.id);
      const existing = tasks.get(task.id);
      if (existing === undefined) {
        tasks.set(task.id, task);
      } else if (existing.version !== task.version) {
        throw new NonRetryableError(`Task ${task.id} already exists`);
      }
    },
    async updateTask(id, patch, expectedVersion) {
      await arrive("update", id);
      const existing = tasks.get(id);
      if (existing === undefined) throw new NonRetryableError(`Task ${id} not found`);
      if (existing.version !== expectedVersion) {
        throw new VersionConflictError(existing, expectedVersion);
      }
      tasks.set(id, applyPatch(existing, patch));
    },
    async deleteTask(id, expectedVersion) {
      await arrive("delete", id);
      const existing = tasks.get(id);
      if (existing === undefined) return;
      if (existing.version !== expectedVersion) {
        throw new VersionConflictError(existing, expectedVersion);
      }
      tasks.delete(id);
    },
    snapshot: () => [...tasks.values()],
    externalUpdate(id, patch) {
      const existing = tasks.get(id);
      if (existing === undefined) throw new NonRetryableError(`Task ${id} not found`);
      tasks.set(id, applyPatch(existing, patch));
    },
  };
}
