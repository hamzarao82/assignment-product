import type { Priority, Task } from "./types";

export interface TaskStats {
  total: number;
  completed: number;
  open: number;
  /** completed / total, or 0 when there are no tasks (never NaN). */
  completionRate: number;
  byPriority: Record<Priority, number>;
  /** Mean hours from createdAt to completedAt over completed tasks; 0 if none. */
  averageHoursToComplete: number;
}

const HOUR_MS = 60 * 60 * 1000;

export function computeStats(tasks: readonly Task[]): TaskStats {
  const byPriority: Record<Priority, number> = { low: 0, medium: 0, high: 0 };
  let completed = 0;
  let totalMs = 0;
  for (const task of tasks) {
    byPriority[task.priority]++;
    if (task.completedAt !== null) {
      completed++;
      totalMs += Math.max(0, task.completedAt.getTime() - task.createdAt.getTime());
    }
  }
  const total = tasks.length;
  return {
    total,
    completed,
    open: total - completed,
    completionRate: total === 0 ? 0 : completed / total,
    byPriority,
    averageHoursToComplete: completed === 0 ? 0 : totalMs / completed / HOUR_MS,
  };
}
