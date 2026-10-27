import { type Rng, RetryableError } from "./api";
import { abortError, errorMessage, sleep } from "./timing";
import type { Task, TaskListState } from "./types";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Per-attempt timeout; exceeding it counts as a failed (retryable) attempt. */
  timeoutMs?: number;
  rng?: Rng;
  signal?: AbortSignal | undefined;
  onRetry?: (info: { attempt: number; delayMs: number; error: RetryableError }) => void;
}

/** Exponential backoff with jitter: base * 2^(attempt-1), scaled by a factor in [0.5, 1). */
export function backoffDelay(attempt: number, baseDelayMs: number, rng: Rng): number {
  return Math.round(baseDelayMs * 2 ** (attempt - 1) * (0.5 + rng() / 2));
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
    op(ctrl.signal).then(
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
 */
export async function withRetry<T>(
  op: (signal: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 200,
    timeoutMs = 2000,
    rng = Math.random,
    signal,
  } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runAttempt(op, timeoutMs, signal);
    } catch (error) {
      if (!(error instanceof RetryableError)) throw error;
      lastError = error;
      if (attempt === maxAttempts) break;
      const delayMs = backoffDelay(attempt, baseDelayMs, rng);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
  throw lastError;
}

/**
 * Race-condition guard. Every load() gets an increasing id and aborts the previous
 * request; a response is only applied if its id is still the latest. The id check
 * (not just abort) matters because a fetch may ignore the signal and resolve anyway.
 */
export function createLatestLoader(
  fetchTasks: (signal: AbortSignal) => Promise<readonly Task[]>,
  onState: (state: TaskListState) => void,
): { load: () => Promise<void>; cancel: () => void } {
  let latestId = 0;
  let controller: AbortController | null = null;

  async function load(): Promise<void> {
    const id = ++latestId;
    controller?.abort();
    const ctrl = new AbortController();
    controller = ctrl;
    onState({ status: "loading" });
    try {
      const tasks = await fetchTasks(ctrl.signal);
      if (id !== latestId) return;
      onState(tasks.length === 0 ? { status: "empty" } : { status: "success", data: tasks });
    } catch (error) {
      if (id !== latestId) return;
      onState({ status: "error", message: errorMessage(error) });
    }
  }

  function cancel(): void {
    latestId++;
    controller?.abort();
    controller = null;
  }

  return { load, cancel };
}
