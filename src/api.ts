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
  /** Clock the generated tasks are dated against; never the wall clock. */
  now?: Clock;
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

export type TaskChanges = Partial<Pick<Task, "title" | "priority" | "tags" | "completedAt">>;

/** Mutation endpoints used by the store. */
export interface TaskApi {
  addTask(task: Task): Promise<void>;
  updateTask(id: TaskId, changes: TaskChanges | TaskPatch): Promise<void>;
  deleteTask(id: TaskId): Promise<void>;
}

export function createSimulatedTaskApi(
  opts: { rng?: Rng; delayMs?: number; failureRate?: number } = {},
): TaskApi {
  const rng = opts.rng ?? Math.random;
  const delayMs = opts.delayMs ?? 100;
  const failureRate = opts.failureRate ?? 0;
  const call = async (): Promise<void> => {
    await sleep(delayMs);
    if (rng() < failureRate) throw new RetryableError("network", "Mutation failed");
  };
  return { addTask: call, updateTask: call, deleteTask: call };
}
