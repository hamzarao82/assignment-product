import type { Page } from "./api";
import { type ErrorReporter, createEmitter } from "./emitter";
import { type RetryOptions, withRetry } from "./retry";
import { errorMessage } from "./timing";
import type { AsyncState, Task } from "./types";

/**
 * Reconciliation rule, shared by pagination and import:
 *  1. the copy with the LATER updatedAt wins;
 *  2. on equal updatedAt, the HIGHER version wins;
 *  3. if both are equal, the copy seen first (`existing`) is kept.
 */
export function reconcileTask(existing: Task, incoming: Task): Task {
  const byTime = incoming.updatedAt.getTime() - existing.updatedAt.getTime();
  if (byTime !== 0) return byTime > 0 ? incoming : existing;
  return incoming.version > existing.version ? incoming : existing;
}

/**
 * De-duplicates by id using reconcileTask. A task keeps the position where it was first
 * seen, so the list never reorders when a duplicate is merged in. Inputs are not mutated.
 */
export function mergeTasks(existing: readonly Task[], incoming: readonly Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const task of [...existing, ...incoming]) {
    const current = byId.get(task.id);
    byId.set(task.id, current === undefined ? task : reconcileTask(current, task));
  }
  return [...byId.values()];
}

export interface PagedSnapshot {
  /**
   * Accumulated tasks. Stays "success" with earlier pages if a later page fails, and is
   * "refreshing" (old data kept) while a refresh of the first page is in flight.
   */
  state: AsyncState<Task[]>;
  /** Set when the last load failed; earlier pages remain in `state`. */
  error: string | null;
  loading: boolean;
  hasMore: boolean;
}

export interface PagedLoaderOptions {
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<Page>;
  retry?: Omit<RetryOptions, "signal">;
  /** Safeguard against endless pagination. */
  maxPages?: number;
  onListenerError?: ErrorReporter;
}

interface Paging {
  tasks: Task[];
  cursor: string | null;
  pagesLoaded: number;
  hasMore: boolean;
  seenCursors: Set<string>;
}

export function createPagedLoader(options: PagedLoaderOptions): {
  getState: () => PagedSnapshot;
  subscribe: (listener: () => void) => () => void;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
} {
  const { fetchPage, retry = {}, maxPages = 50 } = options;
  let paging: Paging = {
    tasks: [],
    cursor: null,
    pagesLoaded: 0,
    hasMore: true,
    seenCursors: new Set(),
  };
  let error: string | null = null;
  let refreshing = false;
  let inFlight: Promise<void> | null = null;
  let inFlightIsRefresh = false;
  let queuedRefresh: Promise<void> | null = null;
  const emitter = createEmitter<undefined>(options.onListenerError);
  let snapshot: PagedSnapshot = {
    state: { status: "loading" },
    error: null,
    loading: false,
    hasMore: true,
  };

  function publish(loading: boolean): void {
    const { tasks, pagesLoaded, hasMore } = paging;
    const state: AsyncState<Task[]> =
      tasks.length > 0
        ? { status: refreshing ? "refreshing" : "success", data: tasks }
        : error !== null
          ? { status: "error", message: error }
          : pagesLoaded === 0
            ? { status: "loading" }
            : { status: "empty" };
    snapshot = { state, error, loading, hasMore };
    emitter.emit(undefined);
  }

  /** Loads the next page, or (for a refresh) restarts from the first page keeping old data. */
  async function loadNext(restart: boolean): Promise<void> {
    error = null;
    const previous = paging;
    const base: Paging = restart
      ? { tasks: [], cursor: null, pagesLoaded: 0, hasMore: true, seenCursors: new Set() }
      : paging;
    try {
      const page = await withRetry((signal) => fetchPage(base.cursor, signal), retry);
      const tasks = mergeTasks(base.tasks, page.items);
      const pagesLoaded = base.pagesLoaded + 1;
      const seenCursors = new Set(base.seenCursors);
      let { cursor, hasMore } = base;
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
      paging = { tasks, cursor, pagesLoaded, hasMore, seenCursors };
    } catch (e) {
      // Keep everything loaded so far; the same cursor can be retried with loadMore().
      paging = previous;
      error = errorMessage(e);
    }
  }

  function start(restart: boolean): Promise<void> {
    // inFlight must be set BEFORE publish(true): a subscriber that calls loadMore()
    // from inside the loading notification would otherwise see no request in flight
    // and start a duplicate one.
    let done: () => void = () => undefined;
    const request = new Promise<void>((resolve) => {
      done = resolve;
    });
    inFlight = request;
    inFlightIsRefresh = restart;
    refreshing = restart;
    publish(true);
    void loadNext(restart).finally(() => {
      // Cleared before the final publish so a subscriber may chain the next loadMore().
      inFlight = null;
      inFlightIsRefresh = false;
      refreshing = false;
      publish(false);
      done();
    });
    return request;
  }

  function loadMore(): Promise<void> {
    if (inFlight !== null) return inFlight; // a second call must not double-fetch
    if (!paging.hasMore) return Promise.resolve();
    return start(false);
  }

  /** Reloads from the first page. Old data stays visible (as "refreshing") until it lands. */
  function refresh(): Promise<void> {
    if (queuedRefresh !== null) return queuedRefresh;
    if (inFlight === null) return start(true);
    if (inFlightIsRefresh) return inFlight; // already reloading: join it
    queuedRefresh = inFlight.then(() => {
      queuedRefresh = null;
      return start(true);
    });
    return queuedRefresh;
  }

  return {
    getState: () => snapshot,
    subscribe: (listener) => emitter.subscribe(() => listener()),
    loadMore,
    refresh,
  };
}
