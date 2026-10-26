import type { Page } from "./api";
import { type RetryOptions, withRetry } from "./fetcher";
import { errorMessage } from "./timing";
import type { AsyncState, Task } from "./types";

/**
 * De-duplication rule: tasks are keyed by id. When the same id appears twice with
 * different content, the version with the LATER createdAt wins. On a tie the version
 * seen first is kept. A task keeps the position where it was first seen, so the list
 * never reorders when a duplicate is merged in.
 */
export function mergeTasks(existing: readonly Task[], incoming: readonly Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const task of [...existing, ...incoming]) {
    const current = byId.get(task.id);
    if (current === undefined || task.createdAt.getTime() > current.createdAt.getTime()) {
      byId.set(task.id, task);
    }
  }
  return [...byId.values()];
}

export interface PagedSnapshot {
  /** Accumulated tasks. Stays "success" with earlier pages if a later page fails. */
  state: AsyncState<Task[]>;
  /** Set when the last page load failed; earlier pages remain in `state`. */
  error: string | null;
  loading: boolean;
  hasMore: boolean;
}

export interface PagedLoaderOptions {
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<Page>;
  retry?: Omit<RetryOptions, "signal">;
  /** Safeguard against endless pagination. */
  maxPages?: number;
}

export function createPagedLoader(options: PagedLoaderOptions): {
  getState: () => PagedSnapshot;
  subscribe: (listener: () => void) => () => void;
  loadMore: () => Promise<void>;
} {
  const { fetchPage, retry = {}, maxPages = 50 } = options;
  let tasks: Task[] = [];
  let cursor: string | null = null;
  let pagesLoaded = 0;
  let hasMore = true;
  let error: string | null = null;
  let inFlight: Promise<void> | null = null;
  const seenCursors = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot: PagedSnapshot = {
    state: { status: "loading" },
    error: null,
    loading: false,
    hasMore,
  };

  function publish(loading: boolean): void {
    const state: AsyncState<Task[]> =
      tasks.length > 0
        ? { status: "success", data: tasks }
        : error !== null
          ? { status: "error", message: error }
          : pagesLoaded === 0
            ? { status: "loading" }
            : { status: "empty" };
    snapshot = { state, error, loading, hasMore };
    for (const listener of [...listeners]) listener();
  }

  async function loadNext(): Promise<void> {
    error = null;
    publish(true);
    try {
      const page = await withRetry((signal) => fetchPage(cursor, signal), retry);
      tasks = mergeTasks(tasks, page.items);
      pagesLoaded++;
      const next = page.nextCursor;
      if (next === null) {
        hasMore = false;
      } else if (seenCursors.has(next) || pagesLoaded >= maxPages) {
        // Repeated cursor or page cap: stop instead of looping forever.
        hasMore = false;
      } else {
        seenCursors.add(next);
        cursor = next;
      }
    } catch (e) {
      // Keep everything loaded so far; the same cursor can be retried with loadMore().
      error = errorMessage(e);
    }
    publish(false);
  }

  function loadMore(): Promise<void> {
    if (inFlight !== null) return inFlight; // a second call must not double-fetch
    if (!hasMore) return Promise.resolve();
    inFlight = loadNext().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    getState: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadMore,
  };
}
