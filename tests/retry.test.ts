import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../src/api";
import { backoffDelay, createLatestLoader, withRetry } from "../src/fetcher";
import { sleep } from "../src/timing";
import type { Task, TaskListState } from "../src/types";
import { makeTask } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("backoffDelay", () => {
  it("grows exponentially and applies jitter in [0.5x, 1x)", () => {
    expect(backoffDelay(1, 100, () => 0)).toBe(50);
    expect(backoffDelay(1, 100, () => 0.999)).toBe(100);
    expect(backoffDelay(2, 100, () => 0)).toBe(100);
    expect(backoffDelay(3, 100, () => 0)).toBe(200);
  });
});

describe("withRetry", () => {
  it("returns the first success without retrying", async () => {
    const op = vi.fn(() => Promise.resolve("ok"));
    await expect(withRetry(op)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors then succeeds, using growing jittered delays", async () => {
    let calls = 0;
    const op = (): Promise<string> => {
      calls++;
      return calls < 3
        ? Promise.reject(new RetryableError("network", "down"))
        : Promise.resolve("ok");
    };
    const delays: number[] = [];
    const p = withRetry(op, {
      baseDelayMs: 100,
      rng: () => 0,
      onRetry: (i) => delays.push(i.delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([50, 100]);
  });

  it("gives up after 3 attempts and throws the last error", async () => {
    const op = vi.fn(() => Promise.reject(new RetryableError("network", "still down")));
    const p = withRetry(op, { baseDelayMs: 10 });
    const assertion = expect(p).rejects.toThrow("still down");
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("never retries a non-retryable error", async () => {
    const op = vi.fn(() => Promise.reject(new NonRetryableError("bad data")));
    await expect(withRetry(op)).rejects.toBeInstanceOf(NonRetryableError);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("counts a per-attempt timeout as a failed attempt", async () => {
    const op = vi.fn(() => new Promise<string>(() => undefined));
    const p = withRetry(op, { timeoutMs: 2000, baseDelayMs: 10 });
    const assertion = expect(p).rejects.toMatchObject({ kind: "timeout" });
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("passes an abort signal to the op that fires on timeout", async () => {
    let seen: AbortSignal | undefined;
    const op = (signal: AbortSignal): Promise<string> => {
      seen = signal;
      return new Promise<string>(() => undefined);
    };
    const p = withRetry(op, { maxAttempts: 1, timeoutMs: 500 });
    const assertion = expect(p).rejects.toBeInstanceOf(RetryableError);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(seen?.aborted).toBe(true);
  });

  it("aborts mid-backoff and leaves no timers behind", async () => {
    const ctrl = new AbortController();
    const op = vi.fn(() => Promise.reject(new RetryableError("network", "down")));
    const p = withRetry(op, { baseDelayMs: 1000, rng: () => 1, signal: ctrl.signal });
    const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10); // attempt 1 failed, now sleeping in backoff
    expect(vi.getTimerCount()).toBe(1);
    ctrl.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight attempt and clears its timeout", async () => {
    const ctrl = new AbortController();
    const op = vi.fn(() => new Promise<string>(() => undefined));
    const p = withRetry(op, { signal: ctrl.signal });
    const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(100);
    ctrl.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const op = vi.fn(() => Promise.resolve("x"));
    await expect(withRetry(op, { signal: ctrl.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(op).not.toHaveBeenCalled();
  });
});

describe("createLatestLoader (race condition)", () => {
  it("ignores a stale response that resolves after a newer one", async () => {
    const first = makeTask("first");
    const second = makeTask("second");
    let call = 0;
    // The fetch deliberately ignores the abort signal, so ONLY the id guard protects the UI.
    const fetchFn = async (): Promise<Task[]> => {
      call++;
      if (call === 1) {
        await sleep(1000);
        return [first];
      }
      await sleep(100);
      return [second];
    };
    const states: TaskListState[] = [];
    const loader = createLatestLoader(fetchFn, (s) => states.push(s));

    void loader.load(); // slow, will become stale
    void loader.load(); // fast, newest
    await vi.advanceTimersByTimeAsync(100);
    expect(states.at(-1)).toEqual({ status: "success", data: [second] });

    await vi.advanceTimersByTimeAsync(2000); // stale response finally arrives
    expect(states.at(-1)).toEqual({ status: "success", data: [second] });
    expect(JSON.stringify(states)).not.toContain('"first"');
  });

  it("ignores a stale error too", async () => {
    let call = 0;
    const fetchFn = async (): Promise<Task[]> => {
      call++;
      if (call === 1) {
        await sleep(500);
        throw new RetryableError("network", "old failure");
      }
      await sleep(10);
      return [makeTask("ok")];
    };
    const states: TaskListState[] = [];
    const loader = createLatestLoader(fetchFn, (s) => states.push(s));
    void loader.load();
    void loader.load();
    await vi.advanceTimersByTimeAsync(1000);
    expect(states.some((s) => s.status === "error")).toBe(false);
  });

  it("reports empty and error states", async () => {
    const states: TaskListState[] = [];
    const empty = createLatestLoader(
      () => Promise.resolve([]),
      (s) => states.push(s),
    );
    await empty.load();
    expect(states).toEqual([{ status: "loading" }, { status: "empty" }]);

    states.length = 0;
    const failing = createLatestLoader(
      () => Promise.reject(new Error("boom")),
      (s) => states.push(s),
    );
    await failing.load();
    expect(states.at(-1)).toEqual({ status: "error", message: "boom" });
  });

  it("cancel() prevents any later state from being applied", async () => {
    const states: TaskListState[] = [];
    const loader = createLatestLoader(
      async () => {
        await sleep(100);
        return [makeTask("x")];
      },
      (s) => states.push(s),
    );
    void loader.load();
    loader.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(states).toEqual([{ status: "loading" }]);
  });
});
