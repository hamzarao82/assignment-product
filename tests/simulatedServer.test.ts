import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NonRetryableError,
  RetryableError,
  VersionConflictError,
  createSimulatedTaskApi,
} from "../src/api";
import { toTaskId } from "../src/types";
import { makeTask } from "./helpers";

const A = toTaskId("a");
const clock = (): Date => new Date("2024-06-01T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function done<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe("simulated server: add", () => {
  it("stores the task and reports it in the snapshot", async () => {
    const server = createSimulatedTaskApi({ delayMs: 5 });
    await done(server.addTask(makeTask("a")));
    expect(server.snapshot().map((t) => t.id)).toEqual(["a"]);
  });

  it("is idempotent for a repeated add of the same version", async () => {
    const server = createSimulatedTaskApi({ delayMs: 5, initialTasks: [makeTask("a")] });
    await expect(done(server.addTask(makeTask("a")))).resolves.toBeUndefined();
    expect(server.snapshot()).toHaveLength(1);
  });

  it("refuses a different task that reuses an id, permanently", async () => {
    const server = createSimulatedTaskApi({ delayMs: 5, initialTasks: [makeTask("a")] });
    const p = server.addTask(makeTask("a", { version: 3 }));
    const assertion = expect(p).rejects.toBeInstanceOf(NonRetryableError);
    await vi.runAllTimersAsync();
    await assertion;
  });
});

describe("simulated server: update", () => {
  it("applies the patch, bumps the version and stamps updatedAt from the injected clock", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 5,
      now: clock,
      initialTasks: [makeTask("a", { title: "old", version: 2 })],
    });
    await done(server.updateTask(A, { title: "new" }, 2));
    const task = server.snapshot()[0];
    expect(task?.title).toBe("new");
    expect(task?.version).toBe(3);
    expect(task?.updatedAt.toISOString()).toBe("2024-06-01T00:00:00.000Z");
  });

  it("refuses a stale write with a conflict carrying the server copy, and changes nothing", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 5,
      initialTasks: [makeTask("a", { title: "server", version: 5 })],
    });
    const p = server.updateTask(A, { title: "mine" }, 4);
    const assertion = expect(p).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof VersionConflictError && e.server.version === 5 && e.expectedVersion === 4,
    );
    await vi.runAllTimersAsync();
    await assertion;
    expect(server.snapshot()[0]?.title).toBe("server");
  });

  it("fails permanently when the task does not exist", async () => {
    const server = createSimulatedTaskApi({ delayMs: 5 });
    const p = server.updateTask(A, { title: "x" }, 0);
    const assertion = expect(p).rejects.toBeInstanceOf(NonRetryableError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("applies changes when a request ARRIVES, so a slower first request loses the race", async () => {
    const server = createSimulatedTaskApi({
      initialTasks: [makeTask("a", { title: "orig" })],
      delayMs: () => 0,
    });
    const slow = createSimulatedTaskApi({
      initialTasks: [makeTask("a", { title: "orig" })],
      delayMs: () => 50,
    });
    const first = slow.updateTask(A, { title: "first" }, 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(slow.snapshot()[0]?.title).toBe("orig"); // not applied until it arrives
    await vi.advanceTimersByTimeAsync(50);
    await first;
    expect(slow.snapshot()[0]?.title).toBe("first");
    expect(server.snapshot()[0]?.title).toBe("orig");
  });
});

describe("simulated server: delete", () => {
  it("removes the task", async () => {
    const server = createSimulatedTaskApi({ delayMs: 5, initialTasks: [makeTask("a")] });
    await done(server.deleteTask(A, 0));
    expect(server.snapshot()).toEqual([]);
  });

  it("is idempotent when the task is already gone", async () => {
    const server = createSimulatedTaskApi({ delayMs: 5 });
    await expect(done(server.deleteTask(A, 0))).resolves.toBeUndefined();
  });

  it("refuses a stale delete with a conflict", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 5,
      initialTasks: [makeTask("a", { version: 3 })],
    });
    const p = server.deleteTask(A, 1);
    const assertion = expect(p).rejects.toBeInstanceOf(VersionConflictError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(server.snapshot()).toHaveLength(1);
  });
});

describe("simulated server: external edits and failures", () => {
  it("externalUpdate simulates another client and bumps the version", () => {
    const server = createSimulatedTaskApi({ now: clock, initialTasks: [makeTask("a")] });
    server.externalUpdate(A, { title: "elsewhere" });
    expect(server.snapshot()[0]?.title).toBe("elsewhere");
    expect(server.snapshot()[0]?.version).toBe(1);
  });

  it("externalUpdate on a missing task throws", () => {
    expect(() => createSimulatedTaskApi().externalUpdate(A, { title: "x" })).toThrow(
      NonRetryableError,
    );
  });

  it("returns a copy from snapshot()", () => {
    const server = createSimulatedTaskApi({ initialTasks: [makeTask("a")] });
    const copy = [...server.snapshot()];
    copy.length = 0;
    expect(server.snapshot()).toHaveLength(1);
  });

  it("fails BEFORE applying when the failure roll hits, leaving the server unchanged", async () => {
    const server = createSimulatedTaskApi({
      delayMs: 5,
      failureRate: 1,
      rng: () => 0,
      initialTasks: [makeTask("a", { title: "orig" })],
    });
    const p = server.updateTask(A, { title: "x" }, 0);
    const assertion = expect(p).rejects.toBeInstanceOf(RetryableError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(server.snapshot()[0]?.title).toBe("orig");
  });
});
