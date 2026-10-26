import { type ParseResult, type Priority, type Task, toTaskId } from "./types";

const PRIORITIES: readonly Priority[] = ["low", "medium", "high"];
const MAX_TITLE = 120;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isPriority(x: unknown): x is Priority {
  return PRIORITIES.some((p) => p === x);
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Validates untrusted data; reports every problem in one pass and never throws. */
export function parseTask(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, errors: ["task must be an object"] };
  const errors: string[] = [];

  const { id, title, priority, tags, completedAt, createdAt } = raw;

  if (typeof id !== "string" || id.trim() === "") errors.push("id must be a non-empty string");

  if (typeof title !== "string" || title.trim() === "") {
    errors.push("title must be a non-empty string");
  } else if (title.length > MAX_TITLE) {
    errors.push(`title must be at most ${MAX_TITLE} characters`);
  }

  if (!isPriority(priority)) errors.push("priority must be one of low, medium, high");

  const cleanTags: string[] = [];
  if (!Array.isArray(tags) || !tags.every((t): t is string => typeof t === "string")) {
    errors.push("tags must be an array of strings");
  } else {
    cleanTags.push(...tags);
  }

  const created = toDate(createdAt);
  if (created === null) errors.push("createdAt must be a valid date");

  // A missing completedAt means "not completed"; a present-but-bad one is an error.
  let completed: Date | null = null;
  if (completedAt !== null && completedAt !== undefined) {
    completed = toDate(completedAt);
    if (completed === null) errors.push("completedAt must be null or a valid date");
  }

  if (
    errors.length > 0 ||
    typeof id !== "string" ||
    typeof title !== "string" ||
    !isPriority(priority) ||
    created === null
  ) {
    return { ok: false, errors };
  }

  const task: Task = {
    id: toTaskId(id),
    title,
    priority,
    completedAt: completed,
    createdAt: created,
    tags: cleanTags,
  };
  return { ok: true, task };
}

export function parseTaskList(raw: unknown): {
  tasks: Task[];
  rejected: { index: number; errors: string[] }[];
} {
  const tasks: Task[] = [];
  const rejected: { index: number; errors: string[] }[] = [];
  if (!Array.isArray(raw)) {
    return { tasks, rejected: [{ index: -1, errors: ["input must be an array"] }] };
  }
  raw.forEach((item: unknown, index) => {
    const result = parseTask(item);
    if (result.ok) tasks.push(result.task);
    else rejected.push({ index, errors: result.errors });
  });
  return { tasks, rejected };
}
