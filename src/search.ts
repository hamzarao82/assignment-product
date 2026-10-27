import { isAbortError } from "./timing";

export interface SearchOptions {
  debounceMs: number;
}

/**
 * Debounced, cancellable search.
 *  - rapid keystrokes collapse into one request (only the last query fires)
 *  - a newer query aborts the in-flight request
 *  - a superseded call resolves with `undefined` and never delivers its results
 */
export function createSearch<T>(
  fetchFn: (query: string, signal: AbortSignal) => Promise<T>,
  options: SearchOptions,
): { search: (query: string) => Promise<T | undefined>; cancel: () => void } {
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let settleDebounced: ((value: undefined) => void) | null = null;

  function supersede(): void {
    clearTimeout(timer);
    timer = undefined;
    settleDebounced?.(undefined); // the keystroke that never fired
    settleDebounced = null;
    controller?.abort();
    controller = null;
  }

  function search(query: string): Promise<T | undefined> {
    supersede();
    const id = ++latest;
    return new Promise<T | undefined>((resolve, reject) => {
      settleDebounced = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        settleDebounced = null;
        const ctrl = new AbortController();
        controller = ctrl;
        fetchFn(query, ctrl.signal).then(
          (result) => resolve(id === latest ? result : undefined),
          (error: unknown) => {
            if (id !== latest || isAbortError(error)) resolve(undefined);
            else reject(error);
          },
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
