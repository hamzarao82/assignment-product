import { describe, expect, it, vi } from "vitest";
import { type Page, RetryableError } from "../src/api";
import { createPagedLoader } from "../src/pagination";
import type { Task } from "../src/types";
import { makeTask } from "./helpers";

const noRetry = { maxAttempts: 1, baseDelayMs: 0 };
const ids = (tasks: readonly Task[]): string[] => tasks.map((t) => t.id);

function dataOf(loader: ReturnType<typeof createPagedLoader>): Task[] {
  const s = loader.getState().state;
  return s.status === "success" || s.status === "refreshing" ? s.data : [];
}

function deferredPage(): { promise: Promise<Page>; resolve: (p: Page) => void } {
  let resolve: (p: Page) => void = () => undefined;
  const promise = new Promise<Page>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createPagedLoader.refresh", () => {
  it("keeps the old data visible as refreshing, then replaces it", async () => {
    const first = deferredPage();
    const generations: Page[] = [{ items: [makeTask("a"), makeTask("b")], nextCursor: null }];
    let call = 0;
    const fetchPage = vi.fn((): Promise<Page> => {
      call++;
      return call === 1
        ? Promise.resolve(generations[0] ?? { items: [], nextCursor: null })
        : first.promise;
    });
    const loader = createPagedLoader({ fetchPage, retry: noRetry });
    await loader.loadMore();
    expect(ids(dataOf(loader))).toEqual(["a", "b"]);

    const refreshing = loader.refresh();
    expect(loader.getState().state.status).toBe("refreshing");
    expect(ids(dataOf(loader))).toEqual(["a", "b"]); // old data still shown

    first.resolve({ items: [makeTask("b"), makeTask("c")], nextCursor: null });
    await refreshing;
    expect(loader.getState().state.status).toBe("success");
    expect(ids(dataOf(loader))).toEqual(["b", "c"]); // "a" was deleted upstream
  });

  it("keeps old data, paging position and reports the error when the refresh fails", async () => {
    let call = 0;
    const fetchPage = vi.fn((cursor: string | null): Promise<Page> => {
      call++;
      if (call === 1) return Promise.resolve({ items: [makeTask("a")], nextCursor: "p2" });
      if (call === 2) return Promise.reject(new RetryableError("network", "refresh failed"));
      return Promise.resolve({ items: [makeTask(cursor === "p2" ? "b" : "z")], nextCursor: null });
    });
    const loader = createPagedLoader({ fetchPage, retry: noRetry });
    await loader.loadMore();
    await loader.refresh();
    expect(loader.getState().error).toBe("refresh failed");
    expect(ids(dataOf(loader))).toEqual(["a"]);
    expect(loader.getState().state.status).toBe("success");
    await loader.loadMore(); // still continues from the old cursor, not from the start
    expect(fetchPage).toHaveBeenLastCalledWith("p2", expect.any(AbortSignal));
    expect(ids(dataOf(loader))).toEqual(["a", "b"]);
  });

  it("restarts pagination from the first cursor", async () => {
    const seen: (string | null)[] = [];
    const fetchPage = vi.fn((cursor: string | null): Promise<Page> => {
      seen.push(cursor);
      return Promise.resolve(
        cursor === null
          ? { items: [makeTask("a")], nextCursor: "p2" }
          : { items: [makeTask("b")], nextCursor: null },
      );
    });
    const loader = createPagedLoader({ fetchPage, retry: noRetry });
    await loader.loadMore();
    await loader.loadMore();
    await loader.refresh();
    await loader.loadMore();
    expect(seen).toEqual([null, "p2", null, "p2"]);
    expect(ids(dataOf(loader))).toEqual(["a", "b"]);
  });

  it("joins a refresh already in flight instead of fetching twice", async () => {
    const page = deferredPage();
    const fetchPage = vi.fn((): Promise<Page> => page.promise);
    const loader = createPagedLoader({ fetchPage, retry: noRetry });
    const first = loader.refresh();
    const second = loader.refresh();
    page.resolve({ items: [makeTask("a")], nextCursor: null });
    await Promise.all([first, second]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("queues a refresh behind an in-flight loadMore and coalesces repeated calls", async () => {
    const slow = deferredPage();
    let call = 0;
    const fetchPage = vi.fn((): Promise<Page> => {
      call++;
      return call === 1
        ? slow.promise
        : Promise.resolve({ items: [makeTask("fresh")], nextCursor: null });
    });
    const loader = createPagedLoader({ fetchPage, retry: noRetry });
    const load = loader.loadMore();
    const r1 = loader.refresh();
    const r2 = loader.refresh();
    expect(r2).toBe(r1);
    expect(fetchPage).toHaveBeenCalledTimes(1); // the refresh waits its turn
    slow.resolve({ items: [makeTask("stale")], nextCursor: null });
    await Promise.all([load, r1]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(ids(dataOf(loader))).toEqual(["fresh"]);
  });

  it("shows empty when a refresh returns no items", async () => {
    let call = 0;
    const fetchPage = vi.fn((): Promise<Page> => {
      call++;
      return Promise.resolve(
        call === 1 ? { items: [makeTask("a")], nextCursor: null } : { items: [], nextCursor: null },
      );
    });
    const loader = createPagedLoader({ fetchPage, retry: noRetry });
    await loader.loadMore();
    await loader.refresh();
    expect(loader.getState().state).toEqual({ status: "empty" });
  });

  it("shows the loading state, not refreshing, when the very first load is a refresh", async () => {
    const page = deferredPage();
    const loader = createPagedLoader({ fetchPage: () => page.promise, retry: noRetry });
    const p = loader.refresh();
    expect(loader.getState().state.status).toBe("loading");
    page.resolve({ items: [makeTask("a")], nextCursor: null });
    await p;
    expect(loader.getState().state.status).toBe("success");
  });
});
