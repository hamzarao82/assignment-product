import { describe, expect, it } from "vitest";
import { parseTask, parseTaskList } from "../src/validation";

const valid = {
  id: "t1",
  title: "Write tests",
  priority: "high",
  completedAt: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  tags: ["a"],
};

describe("parseTask", () => {
  it("accepts a valid record and converts dates", () => {
    const r = parseTask({ ...valid, completedAt: "2024-01-02T00:00:00.000Z" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.task.createdAt).toBeInstanceOf(Date);
      expect(r.task.completedAt?.toISOString()).toBe("2024-01-02T00:00:00.000Z");
    }
  });

  it("treats a missing completedAt as null", () => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest["completedAt"];
    const r = parseTask(rest);
    expect(r.ok && r.task.completedAt).toBe(null);
  });

  it.each([
    ["empty title", { title: "" }, "title"],
    ["whitespace title", { title: "   " }, "title"],
    ["title over 120", { title: "x".repeat(121) }, "title"],
    ["bad priority", { priority: "urgent" }, "priority"],
    ["missing id", { id: undefined }, "id"],
    ["empty id", { id: "" }, "id"],
    ["non-string tags", { tags: ["a", 1] }, "tags"],
    ["tags not an array", { tags: "a" }, "tags"],
    ["invalid date string", { createdAt: "not-a-date" }, "createdAt"],
    ["Invalid Date object", { completedAt: new Date("nope") }, "completedAt"],
  ])("rejects %s", (_name, patch, field) => {
    const r = parseTask({ ...valid, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith(field))).toBe(true);
  });

  it("accepts a title of exactly 120 characters", () => {
    expect(parseTask({ ...valid, title: "x".repeat(120) }).ok).toBe(true);
  });

  it("collects every error in one pass", () => {
    const r = parseTask({ id: "", title: "", priority: "x", tags: 5, createdAt: "bad" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(5);
  });

  it.each([null, undefined, 42, "str", []])("rejects non-object input %j", (raw) => {
    expect(parseTask(raw).ok).toBe(false);
  });
});

describe("parseTaskList", () => {
  it("keeps good items and reports bad ones with their index", () => {
    const { tasks, rejected } = parseTaskList([valid, { ...valid, title: "" }, valid]);
    expect(tasks).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.index).toBe(1);
  });

  it("handles non-array input gracefully", () => {
    const out = parseTaskList({ nope: true });
    expect(out.tasks).toEqual([]);
    expect(out.rejected).toHaveLength(1);
  });
});
