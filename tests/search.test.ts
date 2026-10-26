import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSearch } from "../src/search";
import { sleep } from "../src/timing";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createSearch", () => {
  it("collapses rapid keystrokes into a single request for the last query", async () => {
    const fetchFn = vi.fn((q: string) => Promise.resolve(`results:${q}`));
    const { search } = createSearch(fetchFn, { debounceMs: 300 });
    const p1 = search("r");
    const p2 = search("re");
    const p3 = search("rea");
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith("rea", expect.any(AbortSignal));
    expect(await p1).toBeUndefined();
    expect(await p2).toBeUndefined();
    expect(await p3).toBe("results:rea");
  });

  it("does not fire before the debounce window elapses", async () => {
    const fetchFn = vi.fn(() => Promise.resolve("x"));
    const { search } = createSearch(fetchFn, { debounceMs: 300 });
    void search("a");
    await vi.advanceTimersByTimeAsync(299);
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("aborts the in-flight request when a newer query arrives", async () => {
    const signals: AbortSignal[] = [];
    const fetchFn = (q: string, signal: AbortSignal): Promise<string> => {
      signals.push(signal);
      return sleep(1000, signal).then(() => q);
    };
    const { search } = createSearch(fetchFn, { debounceMs: 100 });
    const first = search("a");
    await vi.advanceTimersByTimeAsync(100); // first request now in flight
    expect(signals[0]?.aborted).toBe(false);
    const second = search("ab");
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await first).toBeUndefined();
    expect(await second).toBe("ab");
  });

  it("never delivers results from a superseded query even if the fetch ignores the signal", async () => {
    const fetchFn = async (q: string): Promise<string> => {
      await sleep(q === "slow" ? 1000 : 50);
      return q;
    };
    const { search } = createSearch(fetchFn, { debounceMs: 10 });
    const slow = search("slow");
    await vi.advanceTimersByTimeAsync(10); // slow is in flight
    const fast = search("fast");
    await vi.advanceTimersByTimeAsync(2000);
    expect(await slow).toBeUndefined();
    expect(await fast).toBe("fast");
  });

  it("propagates a real error for the current query", async () => {
    const { search } = createSearch(() => Promise.reject(new Error("server down")), {
      debounceMs: 10,
    });
    const p = search("a");
    const assertion = expect(p).rejects.toThrow("server down");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it("swallows errors of a superseded query", async () => {
    const fetchFn = async (q: string): Promise<string> => {
      await sleep(100);
      if (q === "old") throw new Error("late failure");
      return q;
    };
    const { search } = createSearch(fetchFn, { debounceMs: 10 });
    const old = search("old");
    await vi.advanceTimersByTimeAsync(10);
    const fresh = search("new");
    await vi.advanceTimersByTimeAsync(500);
    expect(await old).toBeUndefined();
    expect(await fresh).toBe("new");
  });

  it("cancel() drops a pending debounce and leaves no timers", async () => {
    const fetchFn = vi.fn(() => Promise.resolve("x"));
    const { search, cancel } = createSearch(fetchFn, { debounceMs: 100 });
    const p = search("a");
    cancel();
    expect(await p).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
