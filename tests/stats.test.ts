import { describe, expect, it } from "vitest";
import { computeStats } from "../src/stats";
import { makeTask } from "./helpers";

describe("computeStats", () => {
  it("returns zeros, not NaN, for no tasks", () => {
    expect(computeStats([])).toEqual({
      total: 0,
      completed: 0,
      open: 0,
      completionRate: 0,
      byPriority: { low: 0, medium: 0, high: 0 },
      averageHoursToComplete: 0,
    });
  });

  it("counts totals, completion rate and per-priority numbers", () => {
    const stats = computeStats([
      makeTask("a", { priority: "high", completedAt: new Date("2024-01-02") }),
      makeTask("b", { priority: "high" }),
      makeTask("c", { priority: "low" }),
      makeTask("d", { priority: "medium" }),
    ]);
    expect(stats.total).toBe(4);
    expect(stats.completed).toBe(1);
    expect(stats.open).toBe(3);
    expect(stats.completionRate).toBe(0.25);
    expect(stats.byPriority).toEqual({ low: 1, medium: 1, high: 2 });
  });

  it("averages hours to complete over completed tasks only", () => {
    const created = new Date("2024-01-01T00:00:00Z");
    const stats = computeStats([
      makeTask("a", { createdAt: created, completedAt: new Date("2024-01-01T02:00:00Z") }),
      makeTask("b", { createdAt: created, completedAt: new Date("2024-01-01T04:00:00Z") }),
      makeTask("c", { createdAt: created }),
    ]);
    expect(stats.averageHoursToComplete).toBe(3);
  });

  it("clamps a completion that predates creation to 0 hours", () => {
    const stats = computeStats([
      makeTask("a", {
        createdAt: new Date("2024-01-02T00:00:00Z"),
        completedAt: new Date("2024-01-01T00:00:00Z"),
      }),
    ]);
    expect(stats.averageHoursToComplete).toBe(0);
  });

  it("reports a 100% completion rate when everything is done", () => {
    expect(
      computeStats([makeTask("a", { completedAt: new Date("2024-02-01") })]).completionRate,
    ).toBe(1);
  });
});
