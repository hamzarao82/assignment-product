import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryableError } from "../src/api";
import { createMetrics } from "../src/metrics";
import { backoffDelay, createLatestLoader, normalizeAttempts, withRetry } from "../src/retry";
import type { Task, TaskListState } from "../src/types";
import { makeTask } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("normalizeAttempts", () => {
  it.each([
    [0, 1],
    [-5, 1],
    [2.9, 2],
    [1, 1],
    [7, 7],
    [Number.NaN, 3],
    [Number.POSITIVE_INFINITY, 3],
    [undefined, 3],
  ])("maps %s to %s", (input, expected) => {
    expect(normalizeAttempts(input)).toBe(expected);
  });
});

describe("regression: maxAttempts below 1 (F1)", () => {
  it("still makes exactly one attempt and returns its result", async () => {
    const op = vi.fn(() => Promise.resolve("done"));
    await expect(withRetry(op, { maxAttempts: 0 })).resolves.toBe("done");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("throws the real error, never undefined, when the single attempt fails", async () => {
    const op = vi.fn(() => Promise.reject(new RetryableError("network", "down")));
    const p = withRetry(op, { maxAttempts: -2 });
    const assertion = expect(p).rejects.toThrow("down");
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe("regression: synchronous throw leaves no dangling timer (F3)", () => {
  it("clears the attempt timeout and abort listener when op throws synchronously", async () => {
    const ctrl = new AbortController();
    const p = withRetry(
      () => {
        throw new Error("sync boom");
      },
      { signal: ctrl.signal },
    );
    const assertion = expect(p).rejects.toThrow("sync boom");
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    ctrl.abort(); // must be harmless: the listener was already removed
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a synchronous retryable throw like any other failed attempt", async () => {
    let calls = 0;
    const op = (): Promise<string> => {
      calls++;
      if (calls === 1) throw new RetryableError("network", "sync network");
      return Promise.resolve("ok");
    };
    const p = withRetry(op, { baseDelayMs: 10, rng: () => 0 });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("capped backoff", () => {
  it("never exceeds maxDelayMs however many attempts have happened", () => {
    expect(backoffDelay(20, 1000, () => 1, 3000)).toBe(3000);
    expect(backoffDelay(1, 1000, () => 1, 3000)).toBe(1000);
    expect(backoffDelay(2, 1000, () => 0, 3000)).toBe(1000);
  });

  it("is uncapped by default for the pure helper", () => {
    expect(backoffDelay(4, 100, () => 1)).toBe(800);
  });

  it("applies the cap inside withRetry across many attempts", async () => {
    const delays: number[] = [];
    const op = vi.fn(() => Promise.reject(new RetryableError("network", "down")));
    const p = withRetry(op, {
      maxAttempts: 6,
      baseDelayMs: 1000,
      maxDelayMs: 2500,
      rng: () => 1,
      onRetry: (i) => delays.push(i.delayMs),
    });
    const assertion = expect(p).rejects.toThrow("down");
    await vi.runAllTimersAsync();
    await assertion;
    expect(delays).toEqual([1000, 2000, 2500, 2500, 2500]);
  });
});

describe("observers cannot break the retry loop", () => {
  it("ignores a throwing onRetry callback", async () => {
    let calls = 0;
    const op = (): Promise<string> =>
      ++calls < 2 ? Promise.reject(new RetryableError("network", "x")) : Promise.resolve("ok");
    const p = withRetry(op, {
      baseDelayMs: 1,
      rng: () => 0,
      onRetry: () => {
        throw new Error("observer bug");
      },
    });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
  });

  it("counts attempts and retries in the metrics sink", async () => {
    let calls = 0;
    const metrics = createMetrics();
    const op = (): Promise<string> =>
      ++calls < 3 ? Promise.reject(new RetryableError("timeout", "x")) : Promise.resolve("ok");
    const p = withRetry(op, { baseDelayMs: 1, rng: () => 0, metrics });
    await vi.runAllTimersAsync();
    await p;
    expect(metrics.snapshot().attempts).toBe(3);
    expect(metrics.snapshot().retries).toBe(2);
  });

  it("survives a metrics sink that throws", async () => {
    const metrics = createMetrics();
    metrics.recordAttempt = () => {
      throw new Error("sink bug");
    };
    await expect(withRetry(() => Promise.resolve("ok"), { metrics })).resolves.toBe("ok");
  });
});

describe("createLatestLoader refreshing", () => {
  const one: readonly Task[] = [makeTask("a")];
  const two: readonly Task[] = [makeTask("b")];

  it("keeps the previous data visible as refreshing while a reload is in flight", async () => {
    const states: TaskListState[] = [];
    const results = [one, two];
    const loader = createLatestLoader(
      () => Promise.resolve(results.shift() ?? []),
      (s) => states.push(s),
    );
    await loader.load();
    await loader.load();
    expect(states.map((s) => s.status)).toEqual(["loading", "success", "refreshing", "success"]);
    expect(states[2]).toEqual({ status: "refreshing", data: one });
    expect(states[3]).toEqual({ status: "success", data: two });
  });

  it("goes back to plain loading after an empty result (nothing to keep)", async () => {
    const states: TaskListState[] = [];
    const results: (readonly Task[])[] = [one, [], []];
    const loader = createLatestLoader(
      () => Promise.resolve(results.shift() ?? []),
      (s) => states.push(s),
    );
    await loader.load();
    await loader.load();
    await loader.load();
    expect(states.map((s) => s.status)).toEqual([
      "loading",
      "success",
      "refreshing",
      "empty",
      "loading",
      "empty",
    ]);
  });

  it("does not report a throwing subscriber as a failed fetch", async () => {
    const states: TaskListState[] = [];
    const loader = createLatestLoader(
      () => Promise.resolve(one),
      (s) => {
        states.push(s);
        if (s.status === "success") throw new Error("subscriber bug");
      },
    );
    await expect(loader.load()).rejects.toThrow("subscriber bug");
    expect(states.some((s) => s.status === "error")).toBe(false);
  });
});

describe("non-finite timeout disables the per-attempt timer", () => {
  it("lets a slow attempt run to completion when timeoutMs is Infinity", async () => {
    const op = (): Promise<string> =>
      new Promise((resolve) => {
        setTimeout(() => resolve("late but fine"), 60_000);
      });
    const p = withRetry(op, { timeoutMs: Number.POSITIVE_INFINITY });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p).resolves.toBe("late but fine");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still aborts promptly when the caller's signal fires", async () => {
    const ctrl = new AbortController();
    const p = withRetry(() => new Promise<string>(() => undefined), {
      timeoutMs: Number.POSITIVE_INFINITY,
      signal: ctrl.signal,
    });
    const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
    ctrl.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
