export type TaskId = string & { readonly __brand: "TaskId" };

export type Priority = "low" | "medium" | "high";

/**
 * Date fields: `completedAt` and `dueAt` are `Date | null`, never `undefined`.
 * - `completedAt` is a timestamp, not a boolean `isDone`, because we need to know WHEN a
 *   task finished (time-to-complete statistics, audit trail) while `null` still means
 *   "not done". A boolean could not carry the time and could disagree with it.
 * - `dueAt: null` means "no deadline". It is an explicit value so a forgotten field is a
 *   compile error instead of silently reading as "no deadline" via `undefined`.
 * `version` is a server-assigned counter, bumped on every accepted change; it is how a
 * stale mutation is detected (optimistic concurrency).
 */
export interface Task {
  readonly id: TaskId;
  readonly title: string;
  readonly priority: Priority;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly dueAt: Date | null;
  readonly tags: readonly string[];
  readonly version: number;
}

/** The only fields a user may edit. id, createdAt, updatedAt and version are system-owned. */
export type EditableField = "title" | "priority" | "completedAt" | "dueAt" | "tags";
export type TaskPatch = Readonly<Partial<Pick<Task, EditableField>>>;

/** Where untrusted data came from; carried through validation reports. */
export type DataSource = "api" | "import" | "cache";

/**
 * `refreshing` keeps the previous data visible while a newer load is in flight, so a
 * reload never blanks the screen.
 */
export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty" }
  | { status: "success"; data: T }
  | { status: "refreshing"; data: T };

export type TaskListState = AsyncState<readonly Task[]>;

export type ParseResult = { ok: true; task: Task } | { ok: false; errors: string[] };

/** Generic typed result: callers cannot read `value` without checking `ok`. */
export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

/** Applies `fn` to the data-carrying branches only; other states pass through untouched. */
export function mapAsyncState<T, U>(state: AsyncState<T>, fn: (data: T) => U): AsyncState<U> {
  switch (state.status) {
    case "loading":
      return { status: "loading" };
    case "error":
      return { status: "error", message: state.message };
    case "empty":
      return { status: "empty" };
    case "success":
      return { status: "success", data: fn(state.data) };
    case "refreshing":
      return { status: "refreshing", data: fn(state.data) };
    default:
      return assertNever(state);
  }
}

/** The only place a plain string becomes a TaskId (brands cannot be built without a cast). */
export function toTaskId(value: string): TaskId {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- brand constructor
  return value as TaskId;
}
