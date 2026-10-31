import { describe, expect, it, vi } from "vitest";
import { type Page, fetchTasksPage } from "../src/api";
import { createPagedLoader } from "../src/pagination";
import type { Task } from "../src/types";
import { makeTask } from "./helpers";

const instant = { minDelayMs: 0, maxDelayMs: 0 };
const noRetry = { maxAttempts: 1, baseDelayMs: 0 };

function data(loader: ReturnType<typeof createPagedLoader>): Task[] {
  const s = loader.getState().state;
  return s.status === "success" || s.status === "refreshing" ? s.data : [];
}

describe("simulated repeated cursors (4.6)", () => {
  it("the simulator can point every page back at the cursor just requested", async () => {
    const first = await fetchTasksPage(null, { ...instant, pageSize: 5, cursorLoop: true });
    expect(first.nextCursor).toBe("0");
    const again = await fetchTasksPage("0", { ...instant, pageSize: 5, cursorLoop: true });
    expect(again.nextCursor).toBe("0");
    const later = await fetchTasksPage("10", { ...instant, pageSize: 5, cursorLoop: true });
    expect(later.nextCursor).toBe("10");
  });

  it("the loader stops after the repeat instead of looping forever, with no duplicates", async () => {
    const fetchPage = vi.fn((cursor: string | null) =>
      fetchTasksPage(cursor, { ...instant, total: 25, pageSize: 10, cursorLoop: true }),
    );
    const loader = createPagedLoader({ fetchPage, retry: noRetry });
    for (let i = 0; i < 10; i++) await loader.loadMore();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(loader.getState().hasMore).toBe(false);
    expect(data(loader)).toHaveLength(10); // the repeated page was de-duplicated
    expect(new Set(data(loader).map((t) => t.id)).size).toBe(10);
  });

  it("detects a longer cycle (A, B, A) as well as a self-repeat", async () => {
    const pages: Record<string, Page> = {
      start: { items: [makeTask("1")], nextCursor: "A" },
      A: { items: [makeTask("2")], nextCursor: "B" },
      B: { items: [makeTask("3")], nextCursor: "A" },
    };
    const fetchPage = vi.fn((cursor: string | null): Promise<Page> => {
      const page = pages[cursor ?? "start"];
      return page ? Promise.resolve(page) : Promise.reject(new Error("unknown cursor"));
    });
    const loader = createPagedLoader({ fetchPage, retry: noRetry });
    for (let i = 0; i < 10; i++) await loader.loadMore();
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(loader.getState().hasMore).toBe(false);
    expect(data(loader).map((t) => t.id)).toEqual(["1", "2", "3"]);
  });

  it("a page cap also ends an endless stream of fresh cursors", async () => {
    let n = 0;
    const fetchPage = vi.fn((): Promise<Page> => {
      n++;
      return Promise.resolve({ items: [makeTask(`t${n}`)], nextCursor: `c${n}` });
    });
    const loader = createPagedLoader({ fetchPage, retry: noRetry, maxPages: 4 });
    for (let i = 0; i < 20; i++) await loader.loadMore();
    expect(fetchPage).toHaveBeenCalledTimes(4);
    expect(loader.getState().hasMore).toBe(false);
  });

  it("combines overlap, a failing page and recovery without losing earlier pages", async () => {
    let healthy = false;
    const fetchPage = vi.fn((cursor: string | null) =>
      fetchTasksPage(cursor, {
        ...instant,
        total: 30,
        pageSize: 10,
        overlap: 3,
        failPages: healthy ? [] : [1],
      }),
    );
    const loader = createPagedLoader({ fetchPage, retry: noRetry });
    await loader.loadMore(); // page 0 succeeds
    await loader.loadMore(); // page 1 fails
    expect(loader.getState().error).toContain("failed");
    expect(data(loader)).toHaveLength(10);
    healthy = true;
    await loader.loadMore();
    await loader.loadMore();
    expect(new Set(data(loader).map((t) => t.id)).size).toBe(30);
    expect(data(loader)).toHaveLength(30); // overlap never produced a duplicate
    expect(loader.getState().hasMore).toBe(false);
  });
});
