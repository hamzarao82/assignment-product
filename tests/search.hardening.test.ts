import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSearch } from "../src/search";
import { sleep } from "../src/timing";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const HUNG = "HUNG";

/** Settles with HUNG if the promise has not settled once all timers have run. */
async function outcomeOf<T>(p: Promise<T>): Promise<T | typeof HUNG> {
  let result: T | typeof HUNG = HUNG;
  void p.then(
    (v) => (result = v),
    () => (result = HUNG),
  );
  await vi.advanceTimersByTimeAsync(5000);
  return result;
}

describe("regression S1: a superseded promise always settles", () => {
  it("settles an in-flight search with undefined even if its fetch never finishes", async () => {
    const { search } = createSearch(() => new Promise<string>(() => undefined), { debounceMs: 10 });
    const first = search("a");
    await vi.advanceTimersByTimeAsync(10); // the first request is now in flight
    void search("b");
    expect(await outcomeOf(first.then((v) => (v === undefined ? "undefined" : v)))).toBe(
      "undefined",
    );
  });

  it("settles an in-flight search even when the fetch ignores the abort signal", async () => {
    const fetchFn = async (q: string): Promise<string> => {
      await sleep(q === "slow" ? 10_000 : 20);
      return q;
    };
    const { search } = createSearch(fetchFn, { debounceMs: 5 });
    const slow = search("slow");
    await vi.advanceTimersByTimeAsync(5);
    const fast = search("fast");
    expect(await outcomeOf(slow.then((v) => (v === undefined ? "undefined" : v)))).toBe(
      "undefined",
    );
    await vi.advanceTimersByTimeAsync(30);
    expect(await fast).toBe("fast");
  });
});

describe("regression S3: a synchronously throwing fetch rejects instead of crashing", () => {
  it("rejects the search promise with the thrown error", async () => {
    const { search } = createSearch(
      () => {
        throw new Error("sync search boom");
      },
      { debounceMs: 10 },
    );
    const p = search("a");
    const assertion = expect(p).rejects.toThrow("sync search boom");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it("keeps working for the next query after a synchronous failure", async () => {
    let calls = 0;
    const { search } = createSearch(
      (q: string) => {
        if (++calls === 1) throw new Error("first fails");
        return Promise.resolve(`ok:${q}`);
      },
      { debounceMs: 10 },
    );
    const first = search("a");
    const firstAssertion = expect(first).rejects.toThrow("first fails");
    await vi.advanceTimersByTimeAsync(10);
    await firstAssertion;
    const second = search("b");
    await vi.advanceTimersByTimeAsync(10);
    expect(await second).toBe("ok:b");
  });
});

describe("minQueryLength", () => {
  it("fires no request for a short query and settles with undefined", async () => {
    const fetchFn = vi.fn(() => Promise.resolve("x"));
    const { search } = createSearch(fetchFn, { debounceMs: 10, minQueryLength: 2 });
    expect(await search("a")).toBeUndefined();
    expect(await search("   ")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a cleared input cancels the in-flight request and the waiting promise", async () => {
    const signals: AbortSignal[] = [];
    const fetchFn = (q: string, signal: AbortSignal): Promise<string> => {
      signals.push(signal);
      return sleep(1000, signal).then(() => q);
    };
    const { search } = createSearch(fetchFn, { debounceMs: 10, minQueryLength: 1 });
    const pending = search("abc");
    await vi.advanceTimersByTimeAsync(10);
    expect(signals[0]?.aborted).toBe(false);
    expect(await search("")).toBeUndefined();
    expect(signals[0]?.aborted).toBe(true);
    expect(await pending).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defaults to firing for any query, including an empty one", async () => {
    const fetchFn = vi.fn(() => Promise.resolve("all"));
    const { search } = createSearch(fetchFn, { debounceMs: 10 });
    const p = search("");
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBe("all");
  });
});

describe("search lifecycle", () => {
  it("leaves no timers behind after a completed search", async () => {
    const { search } = createSearch(() => Promise.resolve("x"), { debounceMs: 10 });
    const p = search("a");
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancel() aborts the in-flight request and settles its promise", async () => {
    let signal: AbortSignal | undefined;
    const { search, cancel } = createSearch(
      (_q, s) => {
        signal = s;
        return new Promise<string>(() => undefined);
      },
      { debounceMs: 10 },
    );
    const p = search("a");
    await vi.advanceTimersByTimeAsync(10);
    cancel();
    expect(signal?.aborted).toBe(true);
    expect(await p).toBeUndefined();
  });

  it("still delivers the latest result after several superseded queries", async () => {
    const { search } = createSearch((q: string) => Promise.resolve(`r:${q}`), { debounceMs: 20 });
    void search("a");
    void search("ab");
    const last = search("abc");
    await vi.advanceTimersByTimeAsync(20);
    expect(await last).toBe("r:abc");
  });
});
