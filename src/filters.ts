import { type Priority, type Task, assertNever } from "./types";

export interface TaskFilter {
  priority?: Priority;
  completed?: boolean;
  /** Any-of: a task matches if it carries at least one of these tags. */
  tags?: readonly string[];
  /** Inclusive range on createdAt. */
  createdRange?: { from?: Date; to?: Date };
}

/** All supplied criteria combine with AND. An empty filter returns everything. */
export function filterTasks(tasks: readonly Task[], filter: TaskFilter): Task[] {
  const { priority, completed, tags, createdRange } = filter;
  return tasks.filter((task) => {
    if (priority !== undefined && task.priority !== priority) return false;
    if (completed !== undefined && (task.completedAt !== null) !== completed) return false;
    if (tags !== undefined && !task.tags.some((t) => tags.includes(t))) return false;
    if (createdRange?.from !== undefined && task.createdAt < createdRange.from) return false;
    if (createdRange?.to !== undefined && task.createdAt > createdRange.to) return false;
    return true;
  });
}

export type SortDirection = "asc" | "desc";
export interface SortKey {
  by: keyof Task;
  direction: SortDirection;
}

const PRIORITY_RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2 };

function compareText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Ascending comparison of one field. Nulls are handled by the caller. */
function compareField(a: Task, b: Task, by: keyof Task): number {
  switch (by) {
    case "title":
      return compareText(a.title, b.title);
    case "id":
      return compareText(a.id, b.id);
    case "priority":
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    case "createdAt":
      return a.createdAt.getTime() - b.createdAt.getTime();
    case "completedAt":
      // Both non-null here: sortTasksBy handles null ordering first.
      return (a.completedAt?.getTime() ?? 0) - (b.completedAt?.getTime() ?? 0);
    case "tags":
      return compareText(a.tags.join(","), b.tags.join(","));
    default:
      return assertNever(by);
  }
}

function compareTasks(a: Task, b: Task, key: SortKey): number {
  if (key.by === "completedAt") {
    // Nulls last in BOTH directions, so "not done yet" never floats to the top.
    if (a.completedAt === null && b.completedAt === null) return 0;
    if (a.completedAt === null) return 1;
    if (b.completedAt === null) return -1;
  }
  const result = compareField(a, b, key.by);
  return key.direction === "asc" ? result : -result;
}

/**
 * Multi-key sort: later keys break ties. Works on a copy and is stable
 * (equal elements keep their input order; Array.prototype.sort is stable since ES2019).
 */
export function sortTasksBy(tasks: readonly Task[], keys: readonly SortKey[]): Task[] {
  return [...tasks].sort((a, b) => {
    for (const key of keys) {
      const result = compareTasks(a, b, key);
      if (result !== 0) return result;
    }
    return 0;
  });
}

export function sortTasks(
  tasks: readonly Task[],
  by: keyof Task,
  direction: SortDirection,
): Task[] {
  return sortTasksBy(tasks, [{ by, direction }]);
}

export function groupBy<T, K extends PropertyKey>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  const out: Record<K, T[]> = Object.create(null);
  for (const item of items) {
    const key = keyFn(item);
    const bucket = out[key];
    if (bucket) bucket.push(item);
    else out[key] = [item];
  }
  return out;
}

/** Always returns all three priority buckets, even empty ones. */
export function groupTasksByPriority(tasks: readonly Task[]): Record<Priority, Task[]> {
  const grouped: Partial<Record<Priority, Task[]>> = groupBy(tasks, (t) => t.priority);
  return { low: grouped.low ?? [], medium: grouped.medium ?? [], high: grouped.high ?? [] };
}
