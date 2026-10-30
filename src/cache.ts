import { NonRetryableError } from "./api";
import type { MetricsSink } from "./metrics";
import type { Task } from "./types";
import { parseTaskList } from "./validation";

/** Shares one underlying promise between simultaneous calls for the same key. */
export function createInFlightMap<T>(): {
  run: (key: string, fn: () => Promise<T>) => Promise<T>;
  /** Stops sharing the current promise for `key`; later calls start a fresh one. */
  forget: (key: string) => void;
  size: () => number;
} {
  const inFlight = new Map<string, Promise<T>>();
  return {
    run(key, fn) {
      const existing = inFlight.get(key);
      if (existing) return existing;
      // A promise that fails is removed too, so the next caller retries instead of
      // being handed the same rejection forever.
      const promise = fn().finally(() => {
        // Only remove our own entry: after forget(), a newer promise may own the key.
        if (inFlight.get(key) === promise) inFlight.delete(key);
      });
      inFlight.set(key, promise);
      return promise;
    },
    forget(key) {
      inFlight.delete(key);
    },
    size: () => inFlight.size,
  };
}

export interface CacheOptions {
  /** Entries younger than this are fresh and served directly. */
  ttlMs: number;
  /** After the TTL, entries up to this much older are served stale while refreshing. */
  staleMs?: number;
  /** Injectable clock so tests never wait in real time. */
  now?: () => number;
  /** Upper bound on stored entries; the oldest is evicted first. Default 500. */
  maxEntries?: number;
  metrics?: MetricsSink;
}

interface Entry<T> {
  value: T;
  storedAt: number;
}

/**
 * In-memory cache with TTL and stale-while-revalidate:
 *  - age < ttlMs                     -> fresh: return it, no fetch
 *  - ttlMs <= age < ttlMs + staleMs  -> stale: return it now, refresh in the background
 *  - older, missing, or from the future (clock moved backwards) -> fetch and wait
 * Concurrent fetches for one key (miss or refresh) share a single promise.
 */
export function createCache<T>(options: CacheOptions): {
  get: (key: string, fetcher: () => Promise<T>) => Promise<T>;
  invalidate: (key: string) => void;
  size: () => number;
} {
  const { ttlMs, staleMs = 0, now = Date.now, metrics } = options;
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 500));
  const entries = new Map<string, Entry<T>>();
  const inFlight = createInFlightMap<T>();
  // Bumped by invalidate(); a fetch that started under an older generation is stale.
  const generations = new Map<string, number>();
  const generationOf = (key: string): number => generations.get(key) ?? 0;

  function store(key: string, entry: Entry<T>): void {
    entries.delete(key); // re-insert so the key becomes the newest
    entries.set(key, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  }

  function load(key: string, fetcher: () => Promise<T>): Promise<T> {
    return inFlight.run(key, async () => {
      const startedIn = generationOf(key);
      const value = await fetcher();
      // If the key was invalidated while this request was pending, its result is
      // out of date: hand it to the callers that asked, but never cache it.
      if (generationOf(key) === startedIn) store(key, { value, storedAt: now() });
      return value;
    });
  }

  return {
    get(key, fetcher) {
      const entry = entries.get(key);
      if (entry) {
        const age = now() - entry.storedAt;
        if (age >= 0 && age < ttlMs) {
          metrics?.recordCache("fresh");
          return Promise.resolve(entry.value);
        }
        if (age >= 0 && age < ttlMs + staleMs) {
          metrics?.recordCache("stale");
          // Background refresh; a failure keeps serving the stale value.
          load(key, fetcher).catch(() => undefined);
          return Promise.resolve(entry.value);
        }
      }
      metrics?.recordCache("miss");
      return load(key, fetcher);
    },
    invalidate(key) {
      entries.delete(key);
      generations.set(key, generationOf(key) + 1);
      inFlight.forget(key); // a get() after invalidate must not join the stale request
    },
    size: () => entries.size,
  };
}

export interface TaskListCacheOptions extends CacheOptions {
  /** How tasks are turned into cached text. Injectable so corruption can be simulated. */
  serialize?: (tasks: readonly Task[]) => string;
}

function decodeTasks(raw: string): Task[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const { tasks, rejected } = parseTaskList(parsed, "cache");
  return rejected.length === 0 ? tasks : null;
}

/**
 * Cache of task lists that treats its own storage as untrusted: entries are kept as text
 * and re-validated from `unknown` on every read, so a corrupted or tampered entry is
 * discarded and refetched instead of being trusted. Persistent storage is out of scope,
 * but the same boundary would apply to it.
 */
export function createTaskListCache(options: TaskListCacheOptions): {
  get: (key: string, fetcher: () => Promise<readonly Task[]>) => Promise<Task[]>;
  invalidate: (key: string) => void;
} {
  const serialize = options.serialize ?? ((tasks) => JSON.stringify(tasks));
  const inner = createCache<string>(options);

  async function read(key: string, fetcher: () => Promise<readonly Task[]>) {
    const raw = await inner.get(key, async () => serialize(await fetcher()));
    return decodeTasks(raw);
  }

  return {
    async get(key, fetcher) {
      const first = await read(key, fetcher);
      if (first !== null) return first;
      inner.invalidate(key);
      const second = await read(key, fetcher);
      if (second !== null) return second;
      throw new NonRetryableError("Cache returned corrupt task data");
    },
    invalidate: (key) => inner.invalidate(key),
  };
}
