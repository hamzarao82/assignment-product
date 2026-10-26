import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NonRetryableError,
  RetryableError,
  createSeededRng,
  createSimulatedTaskApi,
  fetchTasks,
  fetchTasksPage,
} from "../src/api";
import { toTaskId } from "../src/types";
import { makeTask } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createSeededRng", () => {
  it("is deterministic for a seed and stays within [0, 1)", () => {
    const a = createSeededRng(42);
    const b = createSeededRng(42);
    const seqA = [a(), a(), a()];
    expect(seqA).toEqual([b(), b(), b()]);
    expect(seqA.every((n) => n >= 0 && n < 1)).toBe(true);
    expect(createSeededRng(43)()).not.toBe(seqA[0]);
  });
});

describe("fetchTasks", () => {
  it("resolves with parsed tasks after the injected delay", async () => {
    const p = fetchTasks({ rng: () => 0, minDelayMs: 100, maxDelayMs: 200 });
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).map((t) => t.id)).toEqual(["task-1", "task-2"]);
  });

  it("resolves empty", async () => {
    const p = fetchTasks({ outcome: "empty", minDelayMs: 0, maxDelayMs: 0 });
    await vi.runAllTimersAsync();
    expect(await p).toEqual([]);
  });

  it("rejects with a retryable network error", async () => {
    const p = fetchTasks({ outcome: "error", minDelayMs: 0, maxDelayMs: 0 });
    const assertion = expect(p).rejects.toBeInstanceOf(RetryableError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("rejects with a non-retryable error when the payload is invalid", async () => {
    const p = fetchTasks({ payload: [{ nope: 1 }], minDelayMs: 0, maxDelayMs: 0 });
    const assertion = expect(p).rejects.toBeInstanceOf(NonRetryableError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("aborts while waiting", async () => {
    const ctrl = new AbortController();
    const p = fetchTasks({ minDelayMs: 1000, maxDelayMs: 1000, signal: ctrl.signal });
    const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
    ctrl.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("fetchTasksPage", () => {
  const fast = { minDelayMs: 0, maxDelayMs: 0 };

  it("walks the cursor until nextCursor is null", async () => {
    const run = async (cursor: string | null) => {
      const p = fetchTasksPage(cursor, { ...fast, total: 25, pageSize: 10 });
      await vi.runAllTimersAsync();
      return p;
    };
    const p1 = await run(null);
    expect(p1.items).toHaveLength(10);
    expect(p1.nextCursor).toBe("10");
    const p3 = await run("20");
    expect(p3.items.map((t) => t.id)).toEqual([
      "task-20",
      "task-21",
      "task-22",
      "task-23",
      "task-24",
    ]);
    expect(p3.nextCursor).toBeNull();
  });

  it("can produce overlapping pages", async () => {
    const p = fetchTasksPage("10", { ...fast, pageSize: 10, overlap: 2 });
    await vi.runAllTimersAsync();
    expect((await p).items[0]?.id).toBe("task-8");
  });

  it("fails on the configured page", async () => {
    const p = fetchTasksPage("10", { ...fast, pageSize: 10, failPages: [1] });
    const assertion = expect(p).rejects.toBeInstanceOf(RetryableError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("rejects a malformed cursor as non-retryable", async () => {
    await expect(fetchTasksPage("abc", fast)).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe("createSimulatedTaskApi", () => {
  it("succeeds when failureRate is 0", async () => {
    const api = createSimulatedTaskApi({ delayMs: 10 });
    const p = api.addTask(makeTask("a"));
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBeUndefined();
  });

  it("fails when the rng falls under failureRate", async () => {
    const api = createSimulatedTaskApi({ delayMs: 10, failureRate: 1, rng: () => 0 });
    const p = api.deleteTask(toTaskId("a"));
    const assertion = expect(p).rejects.toBeInstanceOf(RetryableError);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
});
