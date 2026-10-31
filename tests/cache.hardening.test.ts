import { describe, expect, it, vi } from "vitest";
import { NonRetryableError } from "../src/api";
import { createCache, createTaskListCache } from "../src/cache";
import { createMetrics } from "../src/metrics";
import { makeTask } from "./helpers";

function clock(start = 1000): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (v) => (t = v) };
}

describe("cache metrics", () => {
  it("counts miss, fresh and stale reads", async () => {
    const c = clock();
    const metrics = createMetrics();
    const cache = createCache<string>({ ttlMs: 100, staleMs: 500, now: c.now, metrics });
    await cache.get("k", () => Promise.resolve("v1")); // miss
    await cache.get("k", () => Promise.resolve("v2")); // fresh
    c.set(1200);
    await cache.get("k", () => Promise.resolve("v3")); // stale
    expect(metrics.snapshot().cache).toEqual({ fresh: 1, stale: 1, miss: 1 });
  });
});

describe("cache clock safety and bounds", () => {
  it("treats an entry from the future (clock moved backwards) as a miss", async () => {
    const c = clock(1000);
    const cache = createCache<string>({ ttlMs: 100, now: c.now });
    await cache.get("k", () => Promise.resolve("old"));
    c.set(500);
    const fetcher = vi.fn(() => Promise.resolve("new"));
    expect(await cache.get("k", fetcher)).toBe("new");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest entry once maxEntries is exceeded", async () => {
    const cache = createCache<string>({ ttlMs: 10_000, maxEntries: 2 });
    await cache.get("a", () => Promise.resolve("A"));
    await cache.get("b", () => Promise.resolve("B"));
    await cache.get("c", () => Promise.resolve("C"));
    expect(cache.size()).toBe(2);
    const refetch = vi.fn(() => Promise.resolve("A2"));
    expect(await cache.get("a", refetch)).toBe("A2"); // "a" was evicted
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("clamps a nonsensical maxEntries to 1", async () => {
    const cache = createCache<string>({ ttlMs: 10_000, maxEntries: 0 });
    await cache.get("a", () => Promise.resolve("A"));
    await cache.get("b", () => Promise.resolve("B"));
    expect(cache.size()).toBe(1);
  });

  it("refreshing a key makes it the newest, so it survives eviction", async () => {
    const c = clock();
    const cache = createCache<string>({ ttlMs: 10, maxEntries: 2, now: c.now });
    await cache.get("a", () => Promise.resolve("A"));
    await cache.get("b", () => Promise.resolve("B"));
    c.set(1100); // both expired
    await cache.get("a", () => Promise.resolve("A2")); // refetched, newest again
    await cache.get("c", () => Promise.resolve("C")); // evicts "b", not "a"
    const keepA = vi.fn(() => Promise.resolve("should not run"));
    c.set(1101);
    expect(await cache.get("a", keepA)).toBe("A2");
    expect(keepA).not.toHaveBeenCalled();
  });
});

describe("failed requests are not cached or shared (4.8)", () => {
  it("lets a later request retry after a failure", async () => {
    const cache = createCache<string>({ ttlMs: 10_000 });
    const failing = vi.fn(() => Promise.reject(new Error("down")));
    await expect(cache.get("k", failing)).rejects.toThrow("down");
    const working = vi.fn(() => Promise.resolve("ok"));
    expect(await cache.get("k", working)).toBe("ok");
    expect(working).toHaveBeenCalledTimes(1);
  });

  it("shares one failing request between simultaneous callers, then allows a retry", async () => {
    const cache = createCache<string>({ ttlMs: 10_000 });
    const failing = vi.fn(() => Promise.reject(new Error("down")));
    const results = await Promise.allSettled([cache.get("k", failing), cache.get("k", failing)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(await cache.get("k", () => Promise.resolve("recovered"))).toBe("recovered");
  });
});

describe("createTaskListCache (validated from unknown)", () => {
  const tasks = [
    makeTask("a", { title: "One", dueAt: new Date("2024-02-01T00:00:00Z"), tags: ["x"] }),
    makeTask("b", { title: "Two", completedAt: new Date("2024-01-05T00:00:00Z") }),
  ];

  it("round-trips tasks, reviving every Date", async () => {
    const cache = createTaskListCache({ ttlMs: 10_000 });
    const out = await cache.get("k", () => Promise.resolve(tasks));
    expect(out).toHaveLength(2);
    expect(out[0]?.dueAt).toBeInstanceOf(Date);
    expect(out[0]?.dueAt?.toISOString()).toBe("2024-02-01T00:00:00.000Z");
    expect(out[1]?.completedAt).toBeInstanceOf(Date);
    expect(out[0]?.tags).toEqual(["x"]);
  });

  it("serves later reads from the cache without fetching again", async () => {
    const cache = createTaskListCache({ ttlMs: 10_000 });
    const fetcher = vi.fn(() => Promise.resolve(tasks));
    await cache.get("k", fetcher);
    await cache.get("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("discards a corrupted entry (invalid JSON) and refetches", async () => {
    let serializations = 0;
    const cache = createTaskListCache({
      ttlMs: 10_000,
      serialize: (t) => (++serializations === 1 ? "{not json" : JSON.stringify(t)),
    });
    const fetcher = vi.fn(() => Promise.resolve(tasks));
    expect(await cache.get("k", fetcher)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("discards an entry whose JSON is valid but whose records are not tasks", async () => {
    let serializations = 0;
    const cache = createTaskListCache({
      ttlMs: 10_000,
      serialize: (t) =>
        ++serializations === 1 ? JSON.stringify([{ id: "x", title: "" }]) : JSON.stringify(t),
    });
    expect(await cache.get("k", () => Promise.resolve(tasks))).toHaveLength(2);
    expect(serializations).toBe(2);
  });

  it("discards an entry that is not even an array", async () => {
    let serializations = 0;
    const cache = createTaskListCache({
      ttlMs: 10_000,
      serialize: (t) => (++serializations === 1 ? '{"tasks":[]}' : JSON.stringify(t)),
    });
    expect(await cache.get("k", () => Promise.resolve(tasks))).toHaveLength(2);
  });

  it("fails permanently if the source keeps producing corrupt data", async () => {
    const cache = createTaskListCache({ ttlMs: 10_000, serialize: () => "{still not json" });
    await expect(cache.get("k", () => Promise.resolve(tasks))).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("invalidate forces a refetch", async () => {
    const cache = createTaskListCache({ ttlMs: 10_000 });
    const fetcher = vi.fn(() => Promise.resolve(tasks));
    await cache.get("k", fetcher);
    cache.invalidate("k");
    await cache.get("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("caches an empty list rather than treating it as corrupt", async () => {
    const cache = createTaskListCache({ ttlMs: 10_000 });
    const fetcher = vi.fn(() => Promise.resolve([]));
    expect(await cache.get("k", fetcher)).toEqual([]);
    await cache.get("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
