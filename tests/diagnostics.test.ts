import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { summarizeTask, type Conflict } from "../src/conflict";
import { createDiagnosticSnapshot, formatDiagnostics } from "../src/diagnostics";
import { createMetrics } from "../src/metrics";
import type { QueueState } from "../src/offlineQueue";
import type { StoreState } from "../src/store";
import { toTaskId } from "../src/types";
import { makeTask } from "./helpers";

const NOW = new Date("2024-03-10T00:00:00.000Z");
const clock = (): Date => NOW;

function storeState(over: Partial<StoreState> = {}): StoreState {
  return { tasks: [], error: null, pending: {}, conflicts: [], ...over };
}

describe("createDiagnosticSnapshot: counts and statuses", () => {
  const tasks = [
    makeTask("a", {
      priority: "high",
      dueAt: new Date("2024-03-01"),
      version: 3,
      tags: ["x", "y"],
    }),
    makeTask("b", { priority: "low", completedAt: new Date("2024-02-01") }),
    makeTask("c", { priority: "low", dueAt: new Date("2024-12-01") }),
  ];

  it("summarises totals, completion, overdue and priorities", () => {
    const snap = createDiagnosticSnapshot({ store: storeState({ tasks }) }, clock);
    expect(snap.tasks).toMatchObject({
      total: 3,
      completed: 1,
      open: 2,
      overdue: 1,
      byPriority: { low: 2, medium: 0, high: 1 },
      truncated: false,
    });
  });

  it("describes each task by status only, with ref numbers instead of ids", () => {
    const snap = createDiagnosticSnapshot(
      { store: storeState({ tasks, pending: { a: 2 } }) },
      clock,
    );
    expect(snap.tasks.listed[0]).toEqual({
      ref: 0,
      priority: "high",
      completed: false,
      overdue: true,
      pending: true,
      version: 3,
      tagCount: 2,
      title: "[redacted]",
      tags: "[redacted]",
    });
    expect(snap.tasks.withPendingChanges).toBe(1);
  });

  it("stamps the injected clock and marks itself redacted and versioned", () => {
    const snap = createDiagnosticSnapshot({ store: storeState() }, clock);
    expect(snap).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2024-03-10T00:00:00.000Z",
      redacted: true,
    });
  });

  it("works with the wall clock and with minimal input", () => {
    const snap = createDiagnosticSnapshot({ store: storeState() });
    expect(snap.list).toBeNull();
    expect(snap.queue).toBeNull();
    expect(snap.metrics).toBeNull();
    expect(snap.tasks.total).toBe(0);
  });

  it("bounds the per-task rows for a large list and says so", () => {
    const many = Array.from({ length: 450 }, (_, i) => makeTask(`t${i}`));
    const snap = createDiagnosticSnapshot({ store: storeState({ tasks: many }) }, clock);
    expect(snap.tasks.total).toBe(450);
    expect(snap.tasks.listed).toHaveLength(200);
    expect(snap.tasks.truncated).toBe(true);
  });
});

describe("createDiagnosticSnapshot: other sections", () => {
  it("reports an error as present without copying its message", () => {
    const snap = createDiagnosticSnapshot(
      { store: storeState({ error: "Could not update task: <b>secret</b>" }) },
      clock,
    );
    expect(snap.store).toMatchObject({ hasError: true, error: "[redacted]" });
    expect(formatDiagnostics(snap)).not.toContain("secret");
  });

  it("reports conflicts by intent and versions only", () => {
    const conflict: Conflict = {
      taskId: toTaskId("a"),
      intent: "update",
      patch: { title: "mine" },
      local: summarizeTask(makeTask("a", { title: "my private title", version: 2 })),
      server: summarizeTask(makeTask("a", { title: "their private title", version: 5 })),
    };
    const snap = createDiagnosticSnapshot({ store: storeState({ conflicts: [conflict] }) }, clock);
    expect(snap.store.conflicts).toEqual([{ intent: "update", localVersion: 2, serverVersion: 5 }]);
    expect(formatDiagnostics(snap)).not.toContain("private");
  });

  it("includes the queue status and failure category", () => {
    const queue: QueueState = {
      online: false,
      depth: 3,
      status: "stopped",
      failed: { kind: "update", reason: "conflict" },
    };
    const snap = createDiagnosticSnapshot({ store: storeState(), queue }, clock);
    expect(snap.queue).toEqual({
      online: false,
      depth: 3,
      status: "stopped",
      failedKind: "update",
      failedReason: "conflict",
    });
    const healthy = createDiagnosticSnapshot(
      { store: storeState(), queue: { online: true, depth: 0, status: "idle", failed: null } },
      clock,
    );
    expect(healthy.queue).toMatchObject({ failedKind: null, failedReason: null });
  });

  it("reports the list status and item count, never the items", () => {
    const loaded = createDiagnosticSnapshot(
      { store: storeState(), list: { status: "success", data: [makeTask("a"), makeTask("b")] } },
      clock,
    );
    expect(loaded.list).toEqual({ status: "success", itemCount: 2, hasError: false });
    const refreshing = createDiagnosticSnapshot(
      { store: storeState(), list: { status: "refreshing", data: [makeTask("a")] } },
      clock,
    );
    expect(refreshing.list?.itemCount).toBe(1);
    const failed = createDiagnosticSnapshot(
      { store: storeState(), list: { status: "error", message: "network down" } },
      clock,
    );
    expect(failed.list).toEqual({ status: "error", itemCount: null, hasError: true });
    expect(formatDiagnostics(failed)).not.toContain("network down");
    expect(
      createDiagnosticSnapshot({ store: storeState(), list: { status: "loading" } }, clock).list,
    ).toEqual({ status: "loading", itemCount: null, hasError: false });
  });

  it("includes a copy of the metrics, so later activity cannot change a captured snapshot", () => {
    const metrics = createMetrics();
    metrics.recordAttempt();
    metrics.recordCache("miss");
    const snap = createDiagnosticSnapshot(
      { store: storeState(), metrics: metrics.snapshot() },
      clock,
    );
    metrics.recordAttempt();
    metrics.recordCache("miss");
    expect(snap.metrics?.attempts).toBe(1);
    expect(snap.metrics?.cache.miss).toBe(1);
  });
});

describe("redaction guarantees", () => {
  it("never contains a title, tag, id or error text anywhere in the serialised output", () => {
    const secretTask = makeTask("id-SECRET-ID", {
      title: "title-SECRET-TITLE",
      tags: ["tag-SECRET-TAG"],
    });
    const snap = createDiagnosticSnapshot(
      {
        store: storeState({
          tasks: [secretTask],
          error: "error-SECRET-ERROR",
          pending: { "id-SECRET-ID": 1 },
        }),
        list: { status: "error", message: "msg-SECRET-MSG" },
      },
      clock,
    );
    const text = formatDiagnostics(snap);
    for (const secret of [
      "SECRET-ID",
      "SECRET-TITLE",
      "SECRET-TAG",
      "SECRET-ERROR",
      "SECRET-MSG",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("<script");
  });

  it("is plain data that survives a JSON round trip unchanged", () => {
    const snap = createDiagnosticSnapshot(
      { store: storeState({ tasks: [makeTask("a")] }), metrics: createMetrics().snapshot() },
      clock,
    );
    expect(JSON.parse(formatDiagnostics(snap))).toEqual(JSON.parse(JSON.stringify(snap)));
  });

  it("property: secrets planted in any text field never appear in the output", () => {
    const token = fc.integer({ min: 100_000, max: 999_999 }).map((n) => `ZQ${n}ZQ`);
    fc.assert(
      fc.property(token, token, token, token, (title, tag, id, error) => {
        const task = makeTask(id, { title, tags: [tag] });
        const text = formatDiagnostics(
          createDiagnosticSnapshot(
            {
              store: storeState({ tasks: [task], error, pending: { [id]: 1 } }),
              list: { status: "error", message: error },
            },
            clock,
          ),
        );
        for (const secret of new Set([title, tag, id, error])) expect(text).not.toContain(secret);
      }),
      { numRuns: 200 },
    );
  });
});
