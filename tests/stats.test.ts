import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeStats, isOverdue } from "../src/stats";
import { makeTask } from "./helpers";

const now = new Date("2024-03-10T00:00:00Z");
const created = new Date("2024-01-01T00:00:00Z");
const afterHours = (h: number): Date => new Date(created.getTime() + h * 3_600_000);

describe("computeStats", () => {
  it("returns zeros, not NaN, for no tasks", () => {
    expect(computeStats([], now)).toEqual({
      total: 0,
      completed: 0,
      open: 0,
      overdue: 0,
      completionRate: 0,
      byPriority: { low: 0, medium: 0, high: 0 },
      averageHoursToComplete: 0,
      medianHoursToComplete: 0,
    });
  });

  it("counts totals, completion rate and per-priority numbers", () => {
    const stats = computeStats(
      [
        makeTask("a", { priority: "high", completedAt: new Date("2024-01-02") }),
        makeTask("b", { priority: "high" }),
        makeTask("c", { priority: "low" }),
        makeTask("d", { priority: "medium" }),
      ],
      now,
    );
    expect(stats.total).toBe(4);
    expect(stats.completed).toBe(1);
    expect(stats.open).toBe(3);
    expect(stats.completionRate).toBe(0.25);
    expect(stats.byPriority).toEqual({ low: 1, medium: 1, high: 2 });
  });

  it("counts only open tasks past their due date as overdue", () => {
    const stats = computeStats(
      [
        makeTask("late", { dueAt: new Date("2024-03-01") }),
        makeTask("future", { dueAt: new Date("2024-04-01") }),
        makeTask("none"),
        makeTask("done-late", {
          dueAt: new Date("2024-02-01"),
          completedAt: new Date("2024-02-02"),
        }),
      ],
      now,
    );
    expect(stats.overdue).toBe(1);
  });

  it("averages hours to complete over completed tasks only", () => {
    const stats = computeStats(
      [
        makeTask("a", { createdAt: created, completedAt: afterHours(2) }),
        makeTask("b", { createdAt: created, completedAt: afterHours(4) }),
        makeTask("c", { createdAt: created }),
      ],
      now,
    );
    expect(stats.averageHoursToComplete).toBe(3);
  });

  it("computes the median for odd and even counts", () => {
    const odd = computeStats(
      [1, 2, 10].map((h, i) =>
        makeTask(`o${i}`, { createdAt: created, completedAt: afterHours(h) }),
      ),
      now,
    );
    expect(odd.medianHoursToComplete).toBe(2);
    const even = computeStats(
      [1, 2, 3, 10].map((h, i) =>
        makeTask(`e${i}`, { createdAt: created, completedAt: afterHours(h) }),
      ),
      now,
    );
    expect(even.medianHoursToComplete).toBe(2.5);
    expect(even.averageHoursToComplete).toBe(4);
  });

  it("is not thrown off by input order when finding the median", () => {
    const stats = computeStats(
      [10, 1, 5].map((h, i) =>
        makeTask(`x${i}`, { createdAt: created, completedAt: afterHours(h) }),
      ),
      now,
    );
    expect(stats.medianHoursToComplete).toBe(5);
  });

  it("clamps a completion that predates creation to 0 hours", () => {
    const stats = computeStats(
      [makeTask("a", { createdAt: afterHours(5), completedAt: created })],
      now,
    );
    expect(stats.averageHoursToComplete).toBe(0);
    expect(stats.medianHoursToComplete).toBe(0);
  });

  it("reports a 100% completion rate when everything is done", () => {
    expect(
      computeStats([makeTask("a", { completedAt: new Date("2024-02-01") })], now).completionRate,
    ).toBe(1);
  });

  it("does not mutate its input", () => {
    const tasks = Object.freeze([
      makeTask("a", { completedAt: afterHours(3) }),
      makeTask("b", { completedAt: afterHours(1) }),
    ]);
    computeStats(tasks, now);
    expect(tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("defaults the clock to the present", () => {
    expect(computeStats([makeTask("a")]).open).toBe(1);
  });

  it("property: totals add up and no field is ever NaN or negative", () => {
    const taskArb = fc
      .record({
        n: fc.nat(100_000),
        priority: fc.constantFrom("low", "medium", "high"),
        doneAfter: fc.option(fc.integer({ min: -50, max: 500 }), { nil: null }),
        due: fc.option(fc.integer({ min: -100, max: 100 }), { nil: null }),
      })
      .map((r) =>
        makeTask(`t${r.n}`, {
          priority: r.priority,
          completedAt: r.doneAfter === null ? null : afterHours(r.doneAfter),
          dueAt: r.due === null ? null : afterHours(r.due * 24),
        }),
      );
    fc.assert(
      fc.property(fc.array(taskArb, { maxLength: 30 }), (tasks) => {
        const s = computeStats(tasks, now);
        expect(s.completed + s.open).toBe(s.total);
        expect(s.byPriority.low + s.byPriority.medium + s.byPriority.high).toBe(s.total);
        expect(s.overdue).toBeLessThanOrEqual(s.open);
        for (const n of [s.completionRate, s.averageHoursToComplete, s.medianHoursToComplete]) {
          expect(Number.isFinite(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(0);
        }
        expect(s.completionRate).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe("isOverdue", () => {
  it("is true only for an open task whose due date is before now", () => {
    expect(isOverdue(makeTask("a", { dueAt: new Date("2024-03-09") }), now)).toBe(true);
    expect(isOverdue(makeTask("a", { dueAt: new Date("2024-03-10T00:00:00Z") }), now)).toBe(false);
    expect(isOverdue(makeTask("a"), now)).toBe(false);
    expect(
      isOverdue(
        makeTask("a", { dueAt: new Date("2024-03-01"), completedAt: new Date("2024-03-02") }),
        now,
      ),
    ).toBe(false);
  });
});
