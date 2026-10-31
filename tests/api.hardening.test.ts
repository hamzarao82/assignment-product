import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NonRetryableError,
  RetryableError,
  SAMPLE_PAYLOAD,
  VersionConflictError,
  fetchTasks,
  fetchTasksPage,
} from "../src/api";
import { createMetrics } from "../src/metrics";
import { makeTask } from "./helpers";

const instant = { minDelayMs: 0, maxDelayMs: 0 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function settled<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe("fetchTasks outcomes", () => {
  it("simulates a retryable timeout", async () => {
    const p = fetchTasks({ ...instant, outcome: "timeout" });
    const assertion = expect(p).rejects.toMatchObject({ name: "RetryableError", kind: "timeout" });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("simulates a validation failure that must never be retried", async () => {
    const p = fetchTasks({ ...instant, outcome: "invalid" });
    const assertion = expect(p).rejects.toBeInstanceOf(NonRetryableError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("supports a per-call outcome function", async () => {
    const outcomes = ["error", "data"] as const;
    let i = 0;
    const pick = (): "error" | "data" => outcomes[Math.min(i++, 1)] ?? "data";
    const first = expect(fetchTasks({ ...instant, outcome: pick })).rejects.toBeInstanceOf(
      RetryableError,
    );
    await vi.runAllTimersAsync();
    await first;
    expect(await settled(fetchTasks({ ...instant, outcome: pick }))).toHaveLength(2);
  });

  it("returns the valid records and reports how many were dropped", async () => {
    const metrics = createMetrics();
    const payload = [...SAMPLE_PAYLOAD, { broken: true }, 42];
    const tasks = await settled(fetchTasks({ ...instant, payload, metrics }));
    expect(tasks).toHaveLength(2);
    expect(metrics.snapshot().rejectedRecords).toBe(2);
  });

  it("fails permanently when every record is invalid", async () => {
    const p = fetchTasks({ ...instant, payload: [{ broken: true }] });
    const assertion = expect(p).rejects.toBeInstanceOf(NonRetryableError);
    await vi.runAllTimersAsync();
    await assertion;
  });
});

describe("regression: lenient cursor parsing (A1)", () => {
  it.each(["10abc", "1e3", "-1", "1.5", "", " 5", "0x10", "9".repeat(30)])(
    "rejects malformed cursor %j as non-retryable",
    async (cursor) => {
      await expect(fetchTasksPage(cursor, instant)).rejects.toBeInstanceOf(NonRetryableError);
    },
  );

  it("still accepts plain numeric cursors, including zero", async () => {
    const p = fetchTasksPage("0", { ...instant, pageSize: 2, total: 5 });
    expect((await settled(p)).items).toHaveLength(2);
  });
});

describe("clock injection", () => {
  it("generates simulated timestamps relative to the injected clock", async () => {
    const now = new Date("2025-06-15T00:00:00Z");
    const page = await settled(
      fetchTasksPage(null, { ...instant, total: 3, pageSize: 3, now: () => now }),
    );
    expect(page.items.every((t) => t.createdAt < now)).toBe(true);
    const newest = page.items[2];
    expect(newest?.createdAt.toISOString()).toBe("2025-06-14T00:00:00.000Z");
    expect(page.items.every((t) => t.updatedAt.getTime() === t.createdAt.getTime())).toBe(true);
  });

  it("gives every third simulated task a due date after its creation", async () => {
    const page = await settled(fetchTasksPage(null, { ...instant, total: 7, pageSize: 7 }));
    const due = page.items.filter((t) => t.dueAt !== null);
    expect(due.map((t) => t.id)).toEqual(["task-0", "task-3", "task-6"]);
    expect(due.every((t) => t.dueAt !== null && t.dueAt > t.createdAt)).toBe(true);
  });
});

describe("VersionConflictError", () => {
  it("carries the server copy and the version the client expected", () => {
    const server = makeTask("a", { version: 5, title: "server side" });
    const err = new VersionConflictError(server, 3);
    expect(err.server).toBe(server);
    expect(err.expectedVersion).toBe(3);
    expect(err.message).toContain("expected 3");
    expect(err.message).toContain("server has 5");
    expect(err.name).toBe("VersionConflictError");
  });
});
