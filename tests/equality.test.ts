import { describe, expect, it } from "vitest";
import { tasksEqual } from "../src/equality";
import { toTaskId } from "../src/types";
import { makeTask } from "./helpers";

const d = (day: number): Date => new Date(Date.UTC(2024, 0, day));

describe("tasksEqual", () => {
  const base = makeTask("a", {
    title: "T",
    priority: "high",
    completedAt: d(2),
    createdAt: d(1),
    updatedAt: d(3),
    dueAt: d(9),
    tags: ["x", "y"],
    version: 4,
  });

  it("is true for the same reference and for an equal copy with distinct Date objects", () => {
    expect(tasksEqual(base, base)).toBe(true);
    const copy = makeTask("a", {
      title: "T",
      priority: "high",
      completedAt: d(2),
      createdAt: d(1),
      updatedAt: d(3),
      dueAt: d(9),
      tags: ["x", "y"],
      version: 4,
    });
    expect(tasksEqual(base, copy)).toBe(true);
  });

  it.each([
    ["id", { ...base, id: toTaskId("b") }],
    ["title", makeTask("a", { ...base, title: "other" })],
    ["priority", makeTask("a", { ...base, priority: "low" })],
    ["completedAt", makeTask("a", { ...base, completedAt: d(5) })],
    ["completedAt cleared", makeTask("a", { ...base, completedAt: null })],
    ["createdAt", makeTask("a", { ...base, createdAt: d(2) })],
    ["updatedAt", makeTask("a", { ...base, updatedAt: d(4) })],
    ["dueAt", makeTask("a", { ...base, dueAt: d(10) })],
    ["dueAt cleared", makeTask("a", { ...base, dueAt: null })],
    ["version", makeTask("a", { ...base, version: 5 })],
    ["tag order", makeTask("a", { ...base, tags: ["y", "x"] })],
    ["tag count", makeTask("a", { ...base, tags: ["x"] })],
  ])("is false when %s differs", (_name, other) => {
    expect(tasksEqual(base, other)).toBe(false);
  });

  it("treats two null dates as equal", () => {
    expect(tasksEqual(makeTask("a"), makeTask("a"))).toBe(true);
  });
});
