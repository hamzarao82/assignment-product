import { sleep } from "./timing";
import { type Priority, type Task, type TaskId, toTaskId } from "./types";
import { parseTaskList } from "./validation";

/** Injectable randomness: tests pass a seeded generator so runs are deterministic. */
export type Rng = () => number;

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

export type Outcome = "data" | "empty" | "error";

export interface SimOptions {
  rng?: Rng;
  minDelayMs?: number;
  maxDelayMs?: number;
  outcome?: Outcome | (() => Outcome);
  /** Raw server payload; validated with parseTaskList like any untrusted input. */
  payload?: unknown;
  signal?: AbortSignal | undefined;
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
  const outcome = pickOutcome(opts);
  if (outcome === "error") throw new RetryableError("network", "Network request failed");
  if (outcome === "empty") return [];
  const { tasks, rejected } = parseTaskList(opts.payload ?? SAMPLE_PAYLOAD);
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
}

const PRIORITIES: readonly Priority[] = ["low", "medium", "high"];

function makeSimTask(i: number): Task {
  return {
    id: toTaskId(`task-${i}`),
    title: `Task ${i}`,
    priority: PRIORITIES[i % PRIORITIES.length] ?? "low",
    completedAt: null,
    createdAt: new Date(Date.UTC(2024, 0, 1 + i)),
    updatedAt: new Date(Date.UTC(2024, 0, 1 + i)),
    dueAt: null,
    tags: [],
    version: 0,
  };
}

/** Cursor-based pagination over a generated dataset; cursor is the start index. */
export async function fetchTasksPage(
  cursor: string | null,
  opts: PageSimOptions = {},
): Promise<Page> {
  const total = opts.total ?? 25;
  const pageSize = opts.pageSize ?? 10;
  const overlap = opts.overlap ?? 0;
  const start = cursor === null ? 0 : Number.parseInt(cursor, 10);
  if (!Number.isInteger(start) || start < 0) {
    throw new NonRetryableError(`Invalid cursor: ${String(cursor)}`);
  }
  await sleep(pickDelay(opts), opts.signal);
  if (opts.failPages?.includes(Math.floor(start / pageSize))) {
    throw new RetryableError("network", `Page starting at ${start} failed`);
  }
  const from = Math.max(0, start - overlap);
  const end = Math.min(total, start + pageSize);
  const items: Task[] = [];
  for (let i = from; i < end; i++) items.push(makeSimTask(i));
  return { items, nextCursor: end < total ? String(end) : null };
}

export type TaskChanges = Partial<Pick<Task, "title" | "priority" | "tags" | "completedAt">>;

/** Mutation endpoints used by the store. */
export interface TaskApi {
  addTask(task: Task): Promise<void>;
  updateTask(id: TaskId, changes: TaskChanges): Promise<void>;
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
