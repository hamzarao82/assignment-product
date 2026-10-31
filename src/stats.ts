import type { Priority, Task } from "./types";

export interface TaskStats {
  total: number;
  completed: number;
  open: number;
  /** Open tasks whose due date has passed. */
  overdue: number;
  /** completed / total, or 0 when there are no tasks (never NaN). */
  completionRate: number;
  byPriority: Record<Priority, number>;
  /** Mean hours from createdAt to completedAt over completed tasks; 0 if none. */
  averageHoursToComplete: number;
  /** Median of the same durations; 0 if none. Less sensitive to one very slow task. */
  medianHoursToComplete: number;
}

const HOUR_MS = 60 * 60 * 1000;

/** A task is overdue when it is still open and its due date is in the past. */
export function isOverdue(task: Task, now: Date): boolean {
  return task.completedAt === null && task.dueAt !== null && task.dueAt.getTime() < now.getTime();
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  const hi = sorted[mid] ?? 0;
  if (n % 2 === 1) return hi;
  return ((sorted[mid - 1] ?? 0) + hi) / 2;
}

/**
 * Never returns NaN or Infinity. A completion that predates creation (bad data) is
 * clamped to 0 hours rather than producing a negative duration.
 */
export function computeStats(tasks: readonly Task[], now: Date = new Date()): TaskStats {
  const byPriority: Record<Priority, number> = { low: 0, medium: 0, high: 0 };
  const durations: number[] = [];
  let overdue = 0;
  for (const task of tasks) {
    byPriority[task.priority]++;
    if (task.completedAt !== null) {
      durations.push(Math.max(0, task.completedAt.getTime() - task.createdAt.getTime()) / HOUR_MS);
    }
    if (isOverdue(task, now)) overdue++;
  }
  const total = tasks.length;
  const completed = durations.length;
  const sum = durations.reduce((acc, h) => acc + h, 0);
  durations.sort((a, b) => a - b);
  return {
    total,
    completed,
    open: total - completed,
    overdue,
    completionRate: total === 0 ? 0 : completed / total,
    byPriority,
    averageHoursToComplete: completed === 0 ? 0 : sum / completed,
    medianHoursToComplete: median(durations),
  };
}
