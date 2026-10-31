import { type Rng, RetryableError } from "./api";
import type { MetricsSink } from "./metrics";
import { abortError, errorMessage, sleep } from "./timing";
import type { Task, TaskListState } from "./types";

export interface RetryOptions {
  /** Total tries, including the first. Clamped to a whole number from 1 to 3. */
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Upper bound for any single backoff delay, so exponential growth stays sane. */
  maxDelayMs?: number;
  /** Per-attempt timeout; exceeding it counts as a failed (retryable) attempt. */
  timeoutMs?: number;
  rng?: Rng;
  signal?: AbortSignal | undefined;
  onRetry?: (info: { attempt: number; delayMs: number; error: RetryableError }) => void;
  metrics?: MetricsSink;
}

/** Policy ceiling from the spec: no operation is ever tried more than three times. */
const MAX_ATTEMPTS = 3;
const DEFAULT_ATTEMPTS = MAX_ATTEMPTS;

/** Whole number from 1 to 3; unusable input (NaN, 0, negative) falls back safely. */
export function normalizeAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ATTEMPTS;
  return Math.min(MAX_ATTEMPTS, Math.max(1, Math.floor(value)));
}

/**
 * Capped exponential backoff with jitter: base * 2^(attempt-1) scaled by a factor in
 * [0.5, 1), never above maxDelayMs.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  rng: Rng,
  maxDelayMs = Number.POSITIVE_INFINITY,
): number {
  const raw = Math.round(baseDelayMs * 2 ** (attempt - 1) * (0.5 + rng() / 2));
  return Math.min(raw, maxDelayMs);
}

function runAttempt<T>(
  op: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (outer?.aborted) {
      reject(abortError());
      return;
    }
    const ctrl = new AbortController();
    const cleanup = (): void => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      ctrl.abort();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      ctrl.abort();
      reject(new RetryableError("timeout", `Attempt timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    outer?.addEventListener("abort", onAbort, { once: true });

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(op(ctrl.signal));
    } catch (error) {
      // An op that throws synchronously must still release its timer and listener.
      cleanup();
      reject(error);
      return;
    }
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Runs `op` with a per-attempt timeout and up to `maxAttempts` tries.
 * Only RetryableError is retried; anything else (validation, abort) is thrown at once.
 * Observer callbacks (onRetry, metrics) can never break the retry loop.
 */
export async function withRetry<T>(
  op: (signal: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    baseDelayMs = 200,
    maxDelayMs = 5000,
    timeoutMs = 2000,
    rng = Math.random,
    signal,
    metrics,
  } = options;
  const maxAttempts = normalizeAttempts(options.maxAttempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    safely(() => metrics?.recordAttempt());
    try {
      return await runAttempt(op, timeoutMs, signal);
    } catch (error) {
      if (!(error instanceof RetryableError)) throw error;
      lastError = error;
      if (attempt === maxAttempts) break;
      const delayMs = backoffDelay(attempt, baseDelayMs, rng, maxDelayMs);
      safely(() => metrics?.recordRetry());
      safely(() => options.onRetry?.({ attempt, delayMs, error }));
      await sleep(delayMs, signal);
    }
  }
  throw lastError;
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Observers are best-effort; their faults must not change the outcome.
  }
}

/**
 * Race-condition guard. Every load() gets an increasing id and aborts the previous
 * request; a response is only applied if its id is still the latest. The id check
 * (not just abort) matters because a fetch may ignore the signal and resolve anyway.
 * While a reload is in flight the previous data stays visible as `refreshing`.
 */
export function createLatestLoader(
  fetchTasks: (signal: AbortSignal) => Promise<readonly Task[]>,
  onState: (state: TaskListState) => void,
): { load: () => Promise<void>; cancel: () => void } {
  let latestId = 0;
  let controller: AbortController | null = null;
  let lastData: readonly Task[] | null = null;

  async function load(): Promise<void> {
    const id = ++latestId;
    controller?.abort();
    const ctrl = new AbortController();
    controller = ctrl;
    onState(lastData === null ? { status: "loading" } : { status: "refreshing", data: lastData });

    let tasks: readonly Task[];
    try {
      tasks = await fetchTasks(ctrl.signal);
    } catch (error) {
      if (id !== latestId) return;
      onState({ status: "error", message: errorMessage(error) });
      return;
    }
    if (id !== latestId) return;
    // Delivered outside the try block: a throwing subscriber must not be reported as a
    // failed fetch.
    lastData = tasks.length === 0 ? null : tasks;
    onState(tasks.length === 0 ? { status: "empty" } : { status: "success", data: tasks });
  }

  function cancel(): void {
    latestId++;
    controller?.abort();
    controller = null;
  }

  return { load, cancel };
}
