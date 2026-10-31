import { isAbortError } from "./timing";

export interface SearchOptions {
  debounceMs: number;
  /**
   * Queries shorter than this (after trimming) fire no request. They still cancel any
   * older work and settle as `undefined`, which is how a cleared input should behave.
   */
  minQueryLength?: number;
}

/**
 * Debounced, cancellable search.
 *  - rapid keystrokes collapse into one request (only the last query fires)
 *  - a newer query aborts the in-flight request
 *  - a superseded call settles IMMEDIATELY with `undefined` and never delivers results,
 *    even if its fetch ignores the abort signal or never finishes
 *  - a fetch that throws synchronously rejects the search promise instead of crashing
 */
export function createSearch<T>(
  fetchFn: (query: string, signal: AbortSignal) => Promise<T>,
  options: SearchOptions,
): { search: (query: string) => Promise<T | undefined>; cancel: () => void } {
  const minLength = options.minQueryLength ?? 0;
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let settleActive: (() => void) | null = null;

  /** Cancels all older work: timer, in-flight request, and the promise waiting on them. */
  function supersede(): void {
    clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = null;
    settleActive?.();
    settleActive = null;
  }

  function search(query: string): Promise<T | undefined> {
    supersede();
    const id = ++latest;
    if (query.trim().length < minLength) return Promise.resolve(undefined);
    return new Promise<T | undefined>((resolve, reject) => {
      settleActive = () => resolve(undefined);
      timer = setTimeout(() => {
        timer = undefined;
        const ctrl = new AbortController();
        controller = ctrl;
        const finish = (settle: () => void): void => {
          if (controller === ctrl) controller = null;
          if (id === latest) settleActive = null;
          settle();
        };
        let request: Promise<T>;
        try {
          request = Promise.resolve(fetchFn(query, ctrl.signal));
        } catch (error) {
          finish(() => reject(error));
          return;
        }
        request.then(
          (result) => finish(() => resolve(id === latest ? result : undefined)),
          (error: unknown) =>
            finish(() => {
              if (id !== latest || isAbortError(error)) resolve(undefined);
              else reject(error);
            }),
        );
      }, options.debounceMs);
    });
  }

  return {
    search,
    cancel() {
      latest++;
      supersede();
    },
  };
}
