import {
  type DataSource,
  type ParseResult,
  type Priority,
  type Result,
  type Task,
  type TaskPatch,
  toTaskId,
} from "./types";

const PRIORITIES: readonly Priority[] = ["low", "medium", "high"];
const MAX_TITLE = 120;
const PATCH_KEYS: readonly string[] = ["title", "priority", "completedAt", "dueAt", "tags"];

/** YYYY-MM-DD, optionally followed by T hh:mm[:ss[.fraction]] and a mandatory zone. */
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

type Check<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isPriority(x: unknown): x is Priority {
  return PRIORITIES.some((p) => p === x);
}

/**
 * Strict ISO-8601 only. `new Date("March 5, 2024")` happily parses, so the Date
 * constructor alone is not a validator; the shape is checked first and the calendar
 * day is round-tripped so "2024-02-30" cannot roll over into March.
 */
export function parseIsoDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const match = ISO_DATE.exec(value);
  if (match === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const [, y, m, d] = match;
  const calendar = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const sameDay =
    calendar.getUTCFullYear() === Number(y) &&
    calendar.getUTCMonth() === Number(m) - 1 &&
    calendar.getUTCDate() === Number(d);
  return sameDay ? date : null;
}

function checkId(x: unknown): Check<string> {
  return typeof x === "string" && x.trim() !== ""
    ? { ok: true, value: x }
    : { ok: false, error: "id must be a non-empty string" };
}

function checkTitle(x: unknown): Check<string> {
  if (typeof x !== "string" || x.trim() === "") {
    return { ok: false, error: "title must be a non-empty string" };
  }
  if (x.length > MAX_TITLE) {
    return { ok: false, error: `title must be at most ${MAX_TITLE} characters` };
  }
  return { ok: true, value: x };
}

function checkPriority(x: unknown): Check<Priority> {
  return isPriority(x)
    ? { ok: true, value: x }
    : { ok: false, error: "priority must be one of low, medium, high" };
}

function checkTags(x: unknown): Check<string[]> {
  if (!Array.isArray(x) || !x.every((t): t is string => typeof t === "string")) {
    return { ok: false, error: "tags must be an array of strings" };
  }
  if (x.some((t) => t.trim() === "")) {
    return { ok: false, error: "tags must not contain empty strings" };
  }
  if (new Set(x).size !== x.length) {
    return { ok: false, error: "tags must not contain duplicates" };
  }
  return { ok: true, value: [...x] };
}

function checkRequiredDate(x: unknown, name: string): Check<Date> {
  const date = parseIsoDate(x);
  return date === null
    ? { ok: false, error: `${name} must be a valid ISO date` }
    : { ok: true, value: date };
}

/** A missing or null value means "not set"; anything else must be a valid ISO date. */
function checkNullableDate(x: unknown, name: string): Check<Date | null> {
  if (x === null || x === undefined) return { ok: true, value: null };
  const date = parseIsoDate(x);
  return date === null
    ? { ok: false, error: `${name} must be null or a valid ISO date` }
    : { ok: true, value: date };
}

function checkVersion(x: unknown): Check<number> {
  return typeof x === "number" && Number.isInteger(x) && x >= 0
    ? { ok: true, value: x }
    : { ok: false, error: "version must be a non-negative integer" };
}

/** Unwraps a successful check, or records its error and returns undefined. */
function take<T>(check: Check<T>, errors: string[]): T | undefined {
  if (check.ok) return check.value;
  errors.push(check.error);
  return undefined;
}

/** Validates untrusted data; reports every problem in one pass and never throws. */
export function parseTask(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, errors: ["task must be an object"] };
  const errors: string[] = [];

  const id = take(checkId(raw["id"]), errors);
  const title = take(checkTitle(raw["title"]), errors);
  const priority = take(checkPriority(raw["priority"]), errors);
  const tags = take(checkTags(raw["tags"]), errors);
  const createdAt = take(checkRequiredDate(raw["createdAt"], "createdAt"), errors);
  const updatedAt = take(checkRequiredDate(raw["updatedAt"], "updatedAt"), errors);
  const completedAt = take(checkNullableDate(raw["completedAt"], "completedAt"), errors);
  const dueAt = take(checkNullableDate(raw["dueAt"], "dueAt"), errors);
  const version = take(checkVersion(raw["version"]), errors);

  if (createdAt !== undefined && dueAt !== undefined && dueAt !== null && dueAt < createdAt) {
    errors.push("dueAt must not be before createdAt");
  }

  if (
    errors.length > 0 ||
    id === undefined ||
    title === undefined ||
    priority === undefined ||
    tags === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    completedAt === undefined ||
    dueAt === undefined ||
    version === undefined
  ) {
    return { ok: false, errors };
  }

  const task: Task = {
    id: toTaskId(id),
    title,
    priority,
    completedAt,
    createdAt,
    updatedAt,
    dueAt,
    tags,
    version,
  };
  return { ok: true, task };
}

export interface ParsedTaskList {
  source: DataSource;
  tasks: Task[];
  rejected: { index: number; errors: string[] }[];
}

/** One bad record never discards the good ones; the source label travels with the report. */
export function parseTaskList(raw: unknown, source: DataSource = "api"): ParsedTaskList {
  const tasks: Task[] = [];
  const rejected: { index: number; errors: string[] }[] = [];
  if (!Array.isArray(raw)) {
    return { source, tasks, rejected: [{ index: -1, errors: ["input must be an array"] }] };
  }
  raw.forEach((item: unknown, index) => {
    const result = parseTask(item);
    if (result.ok) tasks.push(result.task);
    else rejected.push({ index, errors: result.errors });
  });
  return { source, tasks, rejected };
}

type MutablePatch = { -readonly [K in keyof TaskPatch]: TaskPatch[K] };

/**
 * Validates an edit. Unknown keys are rejected so a typo ("tittle") can never be a
 * silent no-op, and an empty patch is rejected because it could not change anything.
 */
export function parseTaskPatch(raw: unknown): Result<TaskPatch> {
  if (!isRecord(raw)) return { ok: false, errors: ["patch must be an object"] };
  const errors: string[] = [];
  const keys = Object.keys(raw);
  if (keys.length === 0) return { ok: false, errors: ["patch must change at least one field"] };
  for (const key of keys) {
    if (!PATCH_KEYS.includes(key)) {
      errors.push(`unknown key ${JSON.stringify(key.slice(0, 40))}`);
    }
  }

  const patch: MutablePatch = {};
  if ("title" in raw) {
    const title = take(checkTitle(raw["title"]), errors);
    if (title !== undefined) patch.title = title;
  }
  if ("priority" in raw) {
    const priority = take(checkPriority(raw["priority"]), errors);
    if (priority !== undefined) patch.priority = priority;
  }
  if ("tags" in raw) {
    const tags = take(checkTags(raw["tags"]), errors);
    if (tags !== undefined) patch.tags = tags;
  }
  if ("completedAt" in raw) {
    const completedAt = take(checkNullableDate(raw["completedAt"], "completedAt"), errors);
    if (completedAt !== undefined) patch.completedAt = completedAt;
  }
  if ("dueAt" in raw) {
    const dueAt = take(checkNullableDate(raw["dueAt"], "dueAt"), errors);
    if (dueAt !== undefined) patch.dueAt = dueAt;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: patch };
}

/** Rules that need the target task: a patch must not move the due date before creation. */
export function checkPatchAgainstTask(task: Task, patch: TaskPatch): string | null {
  if (patch.dueAt !== undefined && patch.dueAt !== null && patch.dueAt < task.createdAt) {
    return "dueAt must not be before createdAt";
  }
  return null;
}
