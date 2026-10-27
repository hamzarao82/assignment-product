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
}

interface Entry<T> {
  value: T;
  storedAt: number;
}

/**
 * In-memory cache with TTL and stale-while-revalidate:
 *  - age < ttlMs                     -> fresh: return it, no fetch
 *  - ttlMs <= age < ttlMs + staleMs  -> stale: return it now, refresh in the background
 *  - older, or missing               -> fetch normally and wait
 * Concurrent fetches for one key (miss or refresh) share a single promise.
 */
export function createCache<T>(options: CacheOptions): {
  get: (key: string, fetcher: () => Promise<T>) => Promise<T>;
  invalidate: (key: string) => void;
} {
  const { ttlMs, staleMs = 0, now = Date.now } = options;
  const entries = new Map<string, Entry<T>>();
  const inFlight = createInFlightMap<T>();
  // Bumped by invalidate(); a fetch that started under an older generation is stale.
  const generations = new Map<string, number>();
  const generationOf = (key: string): number => generations.get(key) ?? 0;

  function load(key: string, fetcher: () => Promise<T>): Promise<T> {
    return inFlight.run(key, async () => {
      const startedIn = generationOf(key);
      const value = await fetcher();
      // If the key was invalidated while this request was pending, its result is
      // out of date: hand it to the callers that asked, but never cache it.
      if (generationOf(key) === startedIn) entries.set(key, { value, storedAt: now() });
      return value;
    });
  }

  return {
    get(key, fetcher) {
      const entry = entries.get(key);
      if (entry) {
        const age = now() - entry.storedAt;
        if (age < ttlMs) return Promise.resolve(entry.value);
        if (age < ttlMs + staleMs) {
          // Background refresh; a failure keeps serving the stale value.
          load(key, fetcher).catch(() => undefined);
          return Promise.resolve(entry.value);
        }
      }
      return load(key, fetcher);
    },
    invalidate(key) {
      entries.delete(key);
      generations.set(key, generationOf(key) + 1);
      inFlight.forget(key); // a get() after invalidate must not join the stale request
    },
  };
}
