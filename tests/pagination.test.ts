import { describe, expect, it, vi } from "vitest";
import { type Page, RetryableError, fetchTasksPage } from "../src/api";
import { createPagedLoader, mergeTasks, reconcileTask } from "../src/pagination";
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

  it("keeps the copy with the later updatedAt, whatever the order", () => {
    const older = makeTask("a", { title: "old", updatedAt: new Date("2024-01-01"), version: 9 });
    const newer = makeTask("a", { title: "new", updatedAt: new Date("2024-02-01"), version: 1 });
    expect(mergeTasks([older], [newer])[0]?.title).toBe("new");
    expect(mergeTasks([newer], [older])[0]?.title).toBe("new");
  });

  it("on equal updatedAt keeps the higher version", () => {
    const at = new Date("2024-03-01");
    const low = makeTask("a", { title: "low", updatedAt: at, version: 1 });
    const high = makeTask("a", { title: "high", updatedAt: at, version: 2 });
    expect(mergeTasks([low], [high])[0]?.title).toBe("high");
    expect(mergeTasks([high], [low])[0]?.title).toBe("high");
  });

  it("ignores createdAt entirely when deciding the winner", () => {
    const early = makeTask("a", {
      title: "fresh edit",
      createdAt: new Date("2023-01-01"),
      updatedAt: new Date("2024-05-01"),
    });
    const late = makeTask("a", {
      title: "stale",
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-02-01"),
    });
    expect(mergeTasks([late], [early])[0]?.title).toBe("fresh edit");
  });

  it("keeps the first copy when updatedAt and version both tie", () => {
    const first = makeTask("a", { title: "first" });
    const second = makeTask("a", { title: "second" });
    expect(mergeTasks([first], [second])[0]?.title).toBe("first");
    expect(reconcileTask(first, second)).toBe(first);
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

  it("isolates a throwing subscriber: the load still runs and the error is reported", async () => {
    const fetchPage = vi.fn((): Promise<Page> =>
      Promise.resolve({ items: [makeTask("a")], nextCursor: null }),
    );
    const errors: unknown[] = [];
    const loader = createPagedLoader({ fetchPage, onListenerError: (e) => errors.push(e) });
    loader.subscribe(() => {
      throw new Error("subscriber bug");
    });
    await loader.loadMore();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(errors.length).toBeGreaterThan(0);
    expect(dataOf(loader)).toHaveLength(1);
  });

  it("settles loadMore() even when a subscriber throws on the final publish (P17)", async () => {
    const loader = createPagedLoader({
      fetchPage: () => Promise.resolve({ items: [makeTask("a")], nextCursor: null }),
      onListenerError: () => undefined,
    });
    loader.subscribe(() => {
      if (!loader.getState().loading) throw new Error("subscriber bug");
    });
    const outcome = await Promise.race([
      loader.loadMore().then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 200)),
    ]);
    expect(outcome).toBe("settled");
  });
});
