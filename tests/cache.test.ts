import { describe, expect, it, vi } from "vitest";
import { createCache, createInFlightMap } from "../src/cache";

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1000;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe("createCache", () => {
  it("fetches on a miss and stores the value", async () => {
    const c = clock();
    const cache = createCache<string>({ ttlMs: 100, now: c.now });
    const fetcher = vi.fn(() => Promise.resolve("v1"));
    expect(await cache.get("k", fetcher)).toBe("v1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves a fresh entry directly without fetching", async () => {
    const c = clock();
    const cache = createCache<string>({ ttlMs: 100, now: c.now });
    await cache.get("k", () => Promise.resolve("v1"));
    c.advance(99);
    const fetcher = vi.fn(() => Promise.resolve("v2"));
    expect(await cache.get("k", fetcher)).toBe("v1");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("serves a stale entry immediately and refreshes in the background", async () => {
    const c = clock();
    const cache = createCache<string>({ ttlMs: 100, staleMs: 500, now: c.now });
    await cache.get("k", () => Promise.resolve("v1"));
    c.advance(200);
    const fetcher = vi.fn(() => Promise.resolve("v2"));
    expect(await cache.get("k", fetcher)).toBe("v1"); // stale value returned at once
    expect(fetcher).toHaveBeenCalledTimes(1); // refresh already started
    await Promise.resolve();
    await Promise.resolve();
    expect(await cache.get("k", fetcher)).toBe("v2"); // refreshed, now fresh
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps serving the stale value when the background refresh fails", async () => {
    const c = clock();
    const cache = createCache<string>({ ttlMs: 100, staleMs: 500, now: c.now });
    await cache.get("k", () => Promise.resolve("v1"));
    c.advance(200);
    const failing = vi.fn(() => Promise.reject(new Error("down")));
    expect(await cache.get("k", failing)).toBe("v1");
    await Promise.resolve();
    expect(await cache.get("k", failing)).toBe("v1");
  });

  it("refetches and waits once an entry is older than ttl + stale window", async () => {
    const c = clock();
    const cache = createCache<string>({ ttlMs: 100, staleMs: 100, now: c.now });
    await cache.get("k", () => Promise.resolve("v1"));
    c.advance(250);
    expect(await cache.get("k", () => Promise.resolve("v2"))).toBe("v2");
  });

  it("treats an expired entry as a miss when there is no stale window", async () => {
    const c = clock();
    const cache = createCache<string>({ ttlMs: 100, now: c.now });
    await cache.get("k", () => Promise.resolve("v1"));
    c.advance(100);
    expect(await cache.get("k", () => Promise.resolve("v2"))).toBe("v2");
  });

  it("invalidate forces a refetch", async () => {
    const cache = createCache<string>({ ttlMs: 10_000 });
    await cache.get("k", () => Promise.resolve("v1"));
    cache.invalidate("k");
    expect(await cache.get("k", () => Promise.resolve("v2"))).toBe("v2");
  });

  it("shares one fetch between simultaneous callers for the same key", async () => {
    const cache = createCache<string>({ ttlMs: 100 });
    const fetcher = vi.fn(() => Promise.resolve("v"));
    const [a, b] = await Promise.all([cache.get("k", fetcher), cache.get("k", fetcher)]);
    expect([a, b]).toEqual(["v", "v"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

function controllable<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("regression: invalidate while a request is pending", () => {
  it("does not cache the stale response, but still answers the original caller", async () => {
    const cache = createCache<string>({ ttlMs: 10_000 });
    const old = controllable<string>();
    const first = cache.get("k", () => old.promise);
    cache.invalidate("k");
    old.resolve("old");
    expect(await first).toBe("old");

    const fetcher = vi.fn(() => Promise.resolve("new"));
    expect(await cache.get("k", fetcher)).toBe("new");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh request instead of joining the invalidated one", async () => {
    const cache = createCache<string>({ ttlMs: 10_000 });
    const old = controllable<string>();
    const first = cache.get("k", () => old.promise);
    cache.invalidate("k");

    const fetcher = vi.fn(() => Promise.resolve("new"));
    expect(await cache.get("k", fetcher)).toBe("new");
    expect(fetcher).toHaveBeenCalledTimes(1);

    old.resolve("old"); // the stale response arrives last
    expect(await first).toBe("old");
    const later = vi.fn(() => Promise.resolve("later"));
    expect(await cache.get("k", later)).toBe("new"); // cached value was not overwritten
    expect(later).not.toHaveBeenCalled();
  });

  it("keeps de-duplicating the new request after the stale one settles", async () => {
    const cache = createCache<string>({ ttlMs: 10_000 });
    const old = controllable<string>();
    const fresh = controllable<string>();
    const first = cache.get("k", () => old.promise);
    cache.invalidate("k");
    const second = cache.get("k", () => fresh.promise);

    old.resolve("old");
    await first; // the stale request's cleanup must not drop the newer in-flight entry
    const shared = vi.fn(() => Promise.resolve("duplicate"));
    const third = cache.get("k", shared);
    expect(shared).not.toHaveBeenCalled();

    fresh.resolve("new");
    expect(await Promise.all([second, third])).toEqual(["new", "new"]);
  });

  it("only invalidates the requested key", async () => {
    const cache = createCache<string>({ ttlMs: 10_000 });
    const a = controllable<string>();
    const pendingA = cache.get("a", () => a.promise);
    cache.invalidate("b");
    a.resolve("a1");
    await pendingA;
    const fetcher = vi.fn(() => Promise.resolve("a2"));
    expect(await cache.get("a", fetcher)).toBe("a1");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("createInFlightMap", () => {
  it("returns the very same promise for simultaneous calls and clears afterwards", async () => {
    const map = createInFlightMap<number>();
    const fn = vi.fn(() => Promise.resolve(1));
    const p1 = map.run("a", fn);
    const p2 = map.run("a", fn);
    expect(p2).toBe(p1);
    expect(map.size()).toBe(1);
    await p1;
    expect(map.size()).toBe(0);
    await map.run("a", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not share across different keys and clears after a failure", async () => {
    const map = createInFlightMap<number>();
    const fn = vi.fn(() => Promise.resolve(1));
    await Promise.all([map.run("a", fn), map.run("b", fn)]);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(map.run("c", () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(map.size()).toBe(0);
  });
});
