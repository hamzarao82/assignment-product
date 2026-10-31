import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createAuditLog, isInvisibleChar, toSafeText } from "../src/audit";
import { describeConflict, summarizeTask, type Conflict } from "../src/conflict";
import { toTaskId } from "../src/types";
import { makeTask } from "./helpers";

describe("toSafeText", () => {
  it("removes markup-significant characters from a script payload", () => {
    const out = toSafeText("<script>alert(1)</script>");
    expect(out).not.toMatch(/[<>]/);
    expect(out).toBe("scriptalert(1)/script");
  });

  it("removes quotes and ampersands that could break out of an attribute", () => {
    expect(toSafeText(`" onmouseover="x" & 'y' \`z\``)).not.toMatch(/["'&`]/);
  });

  it("strips control, zero-width and bidi-override characters", () => {
    const sneaky = [
      "a",
      0x0000,
      "b",
      0x200b,
      "c",
      0x202e,
      "d",
      0x2066,
      "e",
      0x001b,
      "f",
      0x0085,
      "g",
    ]
      .map((p) => (typeof p === "string" ? p : String.fromCharCode(p)))
      .join("");
    const out = toSafeText(sneaky);
    expect(out).toBe("a b c d e f g");
  });

  it("collapses whitespace and trims", () => {
    expect(toSafeText("  a \n\t b   c  ")).toBe("a b c");
  });

  it("truncates with an ellipsis within the limit", () => {
    const out = toSafeText("x".repeat(200), 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("…")).toBe(true);
    expect(toSafeText("short", 20)).toBe("short");
  });

  it("is safe for an empty or all-markup string", () => {
    expect(toSafeText("")).toBe("");
    expect(toSafeText("<<>>")).toBe("");
  });

  it("property: output never contains markup or invisible characters and respects the limit", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), fc.integer({ min: 1, max: 60 }), (s, max) => {
        const out = toSafeText(s, max);
        expect(out).not.toMatch(/[<>&"'`]/);
        expect(Array.from(out).some((ch) => isInvisibleChar(ch.codePointAt(0) ?? 0))).toBe(false);
        expect(out.length).toBeLessThanOrEqual(max);
      }),
      { numRuns: 400 },
    );
  });
});

describe("createAuditLog", () => {
  const fixed = (): Date => new Date("2024-05-01T12:00:00.000Z");

  it("records ordered events stamped by the injected clock", () => {
    const log = createAuditLog(fixed);
    log.record("add", "Added task", "t1");
    log.record("edit", "Edited task", "t1");
    const events = log.list();
    expect(events.map((e) => [e.seq, e.type, e.taskId])).toEqual([
      [1, "add", "t1"],
      [2, "edit", "t1"],
    ]);
    expect(events[0]?.at).toBe("2024-05-01T12:00:00.000Z");
  });

  it("covers every event type the product records", () => {
    const log = createAuditLog(fixed);
    for (const type of [
      "add",
      "edit",
      "complete",
      "delete",
      "import",
      "rollback",
      "retry",
    ] as const) {
      log.record(type, type);
    }
    expect(log.list().map((e) => e.type)).toEqual([
      "add",
      "edit",
      "complete",
      "delete",
      "import",
      "rollback",
      "retry",
    ]);
  });

  it("sanitises summaries and task ids inside the log, whatever the caller passes", () => {
    const log = createAuditLog(fixed);
    const event = log.record("edit", `Renamed to <img src=x onerror="alert(1)">`, "<b>id</b>");
    expect(event.summary).not.toMatch(/[<>"]/);
    expect(event.taskId).not.toMatch(/[<>]/);
  });

  it("returns frozen events that cannot be altered afterwards", () => {
    const log = createAuditLog(fixed);
    const event = log.record("add", "x");
    expect(Object.isFrozen(event)).toBe(true);
    expect(() => {
      Object.assign(event, { summary: "tampered" });
    }).toThrow();
    expect(log.list()[0]?.summary).toBe("x");
  });

  it("hands out a copy of the list, so callers cannot rewrite history", () => {
    const log = createAuditLog(fixed);
    log.record("add", "x");
    const copy = [...log.list()];
    copy.length = 0;
    expect(log.size()).toBe(1);
    expect(log.list()).toHaveLength(1);
  });

  it("is bounded: the oldest events are dropped past maxEntries", () => {
    const log = createAuditLog(fixed, 3);
    for (let i = 1; i <= 5; i++) log.record("add", `n${i}`);
    expect(log.list().map((e) => e.summary)).toEqual(["n3", "n4", "n5"]);
    expect(log.list()[0]?.seq).toBe(3);
  });

  it("clamps a nonsensical maxEntries to 1", () => {
    const log = createAuditLog(fixed, 0);
    log.record("add", "a");
    log.record("add", "b");
    expect(log.list().map((e) => e.summary)).toEqual(["b"]);
  });

  it("defaults to the wall clock when none is injected", () => {
    const log = createAuditLog();
    expect(Number.isNaN(Date.parse(log.record("add", "x").at))).toBe(false);
  });
});

describe("conflict summaries", () => {
  it("summarises a task into plain, immutable-looking fields", () => {
    const task = makeTask("a", {
      title: "T",
      priority: "high",
      version: 4,
      completedAt: new Date("2024-02-01T00:00:00Z"),
      dueAt: new Date("2024-03-01T00:00:00Z"),
      updatedAt: new Date("2024-02-02T00:00:00Z"),
    });
    expect(summarizeTask(task)).toEqual({
      title: "T",
      priority: "high",
      completed: true,
      dueAt: "2024-03-01T00:00:00.000Z",
      version: 4,
      updatedAt: "2024-02-02T00:00:00.000Z",
    });
    expect(summarizeTask(makeTask("b")).dueAt).toBeNull();
    expect(summarizeTask(makeTask("b")).completed).toBe(false);
  });

  it("describes a conflict with ids and versions only, never the user's title", () => {
    const local = summarizeTask(makeTask("a", { title: "<script>secret</script>" }));
    const server = summarizeTask(makeTask("a", { title: "other", version: 7 }));
    const conflict: Conflict = {
      taskId: toTaskId("a"),
      intent: "update",
      patch: { title: "x" },
      local,
      server,
    };
    const text = describeConflict(conflict);
    expect(text).toContain("version 7");
    expect(text).not.toContain("secret");
    expect(text).not.toMatch(/[<>]/);
  });
});
