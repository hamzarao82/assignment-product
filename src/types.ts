export type TaskId = string & { readonly __brand: "TaskId" };

export type Priority = "low" | "medium" | "high";

/**
 * completedAt is `Date | null` rather than a boolean `isDone` because it carries
 * *when* the task was finished (needed for time-to-complete stats) while `null`
 * still says "not done". A boolean would lose the timestamp, and the two fields
 * could disagree. It is never `undefined`: the key is always present, so a
 * forgotten field is a compile error instead of a silent "not done".
 */
export interface Task {
  readonly id: TaskId;
  readonly title: string;
  readonly priority: Priority;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly tags: readonly string[];
}

export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty" }
  | { status: "success"; data: T };

export type TaskListState = AsyncState<readonly Task[]>;

export type ParseResult = { ok: true; task: Task } | { ok: false; errors: string[] };

export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

/** Applies `fn` to the success branch only; other states pass through untouched. */
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
    default:
      return assertNever(state);
  }
}

/** The only place a plain string becomes a TaskId (brands cannot be built without a cast). */
export function toTaskId(value: string): TaskId {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- brand constructor
  return value as TaskId;
}
