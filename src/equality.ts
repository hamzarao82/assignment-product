import type { Task } from "./types";

/** Structural equality over every Task field (Dates compared by instant). */
export function tasksEqual(a: Task, b: Task): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.title === b.title &&
      a.priority === b.priority &&
      a.completedAt?.getTime() === b.completedAt?.getTime() &&
      a.createdAt.getTime() === b.createdAt.getTime() &&
      a.updatedAt.getTime() === b.updatedAt.getTime() &&
      a.dueAt?.getTime() === b.dueAt?.getTime() &&
      a.version === b.version &&
      a.tags.length === b.tags.length &&
      a.tags.every((tag, i) => tag === b.tags[i]))
  );
}
