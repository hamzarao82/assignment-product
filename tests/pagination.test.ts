import { describe, expect, it, vi } from "vitest";
import { type Page, RetryableError, fetchTasksPage } from "../src/api";
import { createPagedLoader, mergeTasks } from "../src/pagination";
import type { Task } from "../src/types";
import { makeTask } from "./helpers";

const noDelay = { baseDelayMs: 0, rng: () => 0 };
const instant = { minDelayMs: 0, maxDelayMs: 0 };
const ids = (tasks: readonly Task[]): string[] => tasks.map((t) => t.id);

function dataOf(loader: ReturnType<typeof createPagedLoader>): Task[] {
  const s = loader.getState().state;
  return s.status === "success" ? s.data : [];
}

describe("mergeTasks", () => {
  it("de-duplicates by id and keeps first-seen position", () => {
    const out = mergeTasks([makeTask("a"), makeTask("b")], [makeTask("b"), makeTask("c")]);
    expect(ids(out)).toEqual(["a", "b", "c"]);
  });

  it("keeps the version with the later createdAt when content differs", () => {
    const older = makeTask("a", { title: "old", createdAt: new Date("2024-01-01") });
    const newer = makeTask("a", { title: "new", createdAt: new Date("2024-02-01") });
    expect(mergeTasks([older], [newer])[0]?.title).toBe("new");
    expect(mergeTasks([newer], [older])[0]?.title).toBe("new");
  });

  it("keeps the first version on a createdAt tie", () => {
    const first = makeTask("a", { title: "first" });
    const second = makeTask("a", { title: "second" });
    expect(mergeTasks([first], [second])[0]?.title).toBe("first");
  });

  it("does not mutate its inputs", () => {
    const existing = Object.freeze([makeTask("a")]);
    mergeTasks(existing, [makeTask("a"), makeTask("b")]);
    expect(existing).toHaveLength(1);
  });
});

describe("createPagedLoader", () => {
  it("accumulates every page with no duplicates even when pages overlap", async () => {
    const loader = createPagedLoader({
      fetchPage: (cursor, signal) =>
        fetchTasksPage(cursor, { ...instant, total: 25, pageSize: 10, overlap: 3, signal }),
      retry: noDelay,
    });
    await loader.loadMore();
    await loader.loadMore();
    await loader.loadMore();
    const data = dataOf(loader);
    expect(data).toHaveLength(25);
    expect(new Set(ids(data)).size).toBe(25);
    expect(loader.getState().hasMore).toBe(false);
  });

  it("does not double-fetch when loadMore is called twice quickly", async () => {
    const fetchPage = vi.fn((): Promise<Page> =>
      Promise.resolve({ items: [makeTask("a")], nextCursor: "1" }),
    );
    const loader = createPagedLoader({ fetchPage, retry: noDelay });
    const first = loader.loadMore();
    const second = loader.loadMore();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("keeps earlier pages and reports the error when a later page fails after retries", async () => {
    const loader = createPagedLoader({
      fetchPage: (cursor, signal) =>
        fetchTasksPage(cursor, { ...instant, pageSize: 10, failPages: [1], signal }),
      retry: noDelay,
    });
    await loader.loadMore();
    await loader.loadMore();
    const snap = loader.getState();
    expect(dataOf(loader)).toHaveLength(10);
    expect(snap.state.status).toBe("success");
    expect(snap.error).toContain("failed");
    expect(snap.hasMore).toBe(true);
  });

  it("can resume from the failed cursor on the next loadMore", async () => {
    let failing = true;
    const loader = createPagedLoader({
      fetchPage: (cursor) => {
        if (cursor === null) return Promise.resolve({ items: [makeTask("a")], nextCursor: "1" });
        if (failing) return Promise.reject(new RetryableError("network", "flaky"));
        return Promise.resolve({ items: [makeTask("b")], nextCursor: null });
      },
      retry: noDelay,
    });
    await loader.loadMore();
    await loader.loadMore();
    expect(loader.getState().error).toBe("flaky");
    failing = false;
    await loader.loadMore();
    expect(ids(dataOf(loader))).toEqual(["a", "b"]);
    expect(loader.getState().error).toBeNull();
  });

  it("shows an error state when the very first page fails", async () => {
    const loader = createPagedLoader({
      fetchPage: () => Promise.reject(new RetryableError("network", "offline")),
      retry: noDelay,
    });
    await loader.loadMore();
    expect(loader.getState().state).toEqual({ status: "error", message: "offline" });
  });

  it("shows empty when the first page has no items", async () => {
    const loader = createPagedLoader({
      fetchPage: () => Promise.resolve({ items: [], nextCursor: null }),
    });
    await loader.loadMore();
    expect(loader.getState().state).toEqual({ status: "empty" });
  });

  it("stops on a repeated cursor", async () => {
    const fetchPage = vi.fn((): Promise<Page> =>
      Promise.resolve({ items: [makeTask("a")], nextCursor: "same" }),
    );
    const loader = createPagedLoader({ fetchPage });
    await loader.loadMore();
    await loader.loadMore();
    await loader.loadMore();
    expect(loader.getState().hasMore).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("stops at the maximum page count", async () => {
    let n = 0;
    const fetchPage = vi.fn((): Promise<Page> => {
      n++;
      return Promise.resolve({ items: [makeTask(`t${n}`)], nextCursor: `c${n}` });
    });
    const loader = createPagedLoader({ fetchPage, maxPages: 3 });
    for (let i = 0; i < 6; i++) await loader.loadMore();
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(loader.getState().hasMore).toBe(false);
  });

  it("notifies subscribers until they unsubscribe", async () => {
    const loader = createPagedLoader({
      fetchPage: () => Promise.resolve({ items: [makeTask("a")], nextCursor: null }),
    });
    const listener = vi.fn();
    const off = loader.subscribe(listener);
    await loader.loadMore();
    expect(listener).toHaveBeenCalledTimes(2); // loading, then loaded
    off();
    listener.mockClear();
    await loader.loadMore();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("regression: subscriber re-entrancy", () => {
  it("does not start a duplicate request when a subscriber calls loadMore while loading", async () => {
    const fetchPage = vi.fn((): Promise<Page> =>
      Promise.resolve({ items: [makeTask("a")], nextCursor: null }),
    );
    const loader = createPagedLoader({ fetchPage });
    loader.subscribe(() => {
      if (loader.getState().loading) void loader.loadMore();
    });
    await loader.loadMore();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("lets a subscriber chain the next page as soon as a load has finished", async () => {
    const pages: Record<string, Page> = {
      first: { items: [makeTask("a")], nextCursor: "p2" },
      p2: { items: [makeTask("b")], nextCursor: "p3" },
      p3: { items: [makeTask("c")], nextCursor: null },
    };
    const fetchPage = vi.fn((cursor: string | null): Promise<Page> => {
      const page = pages[cursor ?? "first"];
      return page ? Promise.resolve(page) : Promise.reject(new Error("unknown cursor"));
    });
    const loader = createPagedLoader({ fetchPage });
    loader.subscribe(() => {
      const s = loader.getState();
      if (!s.loading && s.hasMore) void loader.loadMore();
    });
    await loader.loadMore();
    await vi.waitFor(() => expect(loader.getState().hasMore).toBe(false));
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(ids(dataOf(loader))).toEqual(["a", "b", "c"]);
  });

  it("does not stay stuck in flight when a subscriber throws during the loading notification", async () => {
    const fetchPage = vi.fn((): Promise<Page> =>
      Promise.resolve({ items: [makeTask("a")], nextCursor: null }),
    );
    const loader = createPagedLoader({ fetchPage });
    const off = loader.subscribe(() => {
      throw new Error("subscriber bug");
    });
    expect(() => loader.loadMore()).toThrow("subscriber bug");
    expect(fetchPage).not.toHaveBeenCalled();
    off();
    await loader.loadMore();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
