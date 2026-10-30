import { toSafeText } from "./audit";
import type { Priority, Task, TaskId, TaskPatch } from "./types";

/** A side of a conflict, reduced to what a person needs to choose between the two. */
export interface TaskSummary {
  readonly title: string;
  readonly priority: Priority;
  readonly completed: boolean;
  readonly dueAt: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

/**
 * Typed conflict state. The local change is never applied over a newer server version;
 * both sides are kept so the user decides.
 */
export interface Conflict {
  readonly taskId: TaskId;
  readonly intent: "update" | "delete";
  /** The edit that was refused, kept so "keep mine" can replay it. Null for a delete. */
  readonly patch: TaskPatch | null;
  /** What the task would have looked like had the local change been accepted. */
  readonly local: TaskSummary;
  /** What the server currently has. */
  readonly server: TaskSummary;
}

export function summarizeTask(task: Task): TaskSummary {
  return {
    title: task.title,
    priority: task.priority,
    completed: task.completedAt !== null,
    dueAt: task.dueAt === null ? null : task.dueAt.toISOString(),
    version: task.version,
    updatedAt: task.updatedAt.toISOString(),
  };
}

/** One safe sentence for logs and diagnostics: ids and versions only, no user text. */
export function describeConflict(conflict: Conflict): string {
  return toSafeText(
    `Conflict on ${conflict.taskId}: ${conflict.intent} based on an older version; ` +
      `server is at version ${conflict.server.version}`,
    160,
  );
}
