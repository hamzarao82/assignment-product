/** Shares one underlying promise between simultaneous calls for the same key. */
export function createInFlightMap<T>(): {
  run: (key: string, fn: () => Promise<T>) => Promise<T>;
  size: () => number;
} {
  const inFlight = new Map<string, Promise<T>>();
  return {
    run(key, fn) {
      const existing = inFlight.get(key);
      if (existing) return existing;
      const promise = fn().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, promise);
      return promise;
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

  function load(key: string, fetcher: () => Promise<T>): Promise<T> {
    return inFlight.run(key, async () => {
      const value = await fetcher();
      entries.set(key, { value, storedAt: now() });
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
    },
  };
}
