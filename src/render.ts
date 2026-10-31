import { type AsyncState, type Task, type TaskListState, assertNever } from "./types";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Every piece of user-supplied text must pass through here before entering HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

export interface Labels {
  loading?: string;
  empty?: string;
  retryHint?: string;
}

/**
 * Generic, exhaustive renderer. If a fifth AsyncState variant is ever added, the
 * `assertNever` call stops compiling until it is handled here.
 */
export function renderAsyncState<T>(
  state: AsyncState<T>,
  renderData: (data: T) => string,
  labels: Labels = {},
): string {
  switch (state.status) {
    case "loading":
      return `<div class="state state--loading" role="status">${escapeHtml(labels.loading ?? "Loading…")}</div>`;
    case "empty":
      return `<div class="state state--empty">${escapeHtml(labels.empty ?? "Nothing to show yet.")}</div>`;
    case "error":
      return (
        `<div class="state state--error" role="alert">` +
        `<p class="state__message">${escapeHtml(state.message)}</p>` +
        `<p class="state__hint">${escapeHtml(labels.retryHint ?? "Please try again.")}</p>` +
        `</div>`
      );
    case "success":
      return renderData(state.data);
    case "refreshing":
      return `${renderData(state.data)}<p class="state state--refreshing" role="status">${escapeHtml(labels.loading ?? "Loading…")}</p>`;
    default:
      return assertNever(state);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RenderTaskOptions {
  now: Date;
  /** An open task older than this many days is styled as overdue. */
  overdueAfterDays?: number;
}

export function renderTask(task: Task, options: RenderTaskOptions): string {
  const { now, overdueAfterDays = 7 } = options;
  const done = task.completedAt !== null;
  const overdue = !done && now.getTime() - task.createdAt.getTime() > overdueAfterDays * DAY_MS;
  const classes = [
    "task",
    `task--${task.priority}`,
    done ? "task--done" : "task--open",
    ...(overdue ? ["task--overdue"] : []),
  ].join(" ");
  const tags = task.tags.map((t) => `<li class="task__tag">${escapeHtml(t)}</li>`).join("");
  return (
    `<li class="${classes}">` +
    `<span class="task__title">${escapeHtml(task.title)}</span> ` +
    `<span class="task__priority">${escapeHtml(task.priority)}</span> ` +
    `<span class="task__status">${done ? "Done" : "Open"}</span>` +
    (tags ? `<ul class="task__tags">${tags}</ul>` : "") +
    `</li>`
  );
}

export function renderTaskList(state: TaskListState, options: RenderTaskOptions): string {
  return renderAsyncState(
    state,
    (tasks) => `<ul class="task-list">${tasks.map((t) => renderTask(t, options)).join("")}</ul>`,
    {
      loading: "Loading tasks…",
      empty: "No tasks yet. Add your first task to get started.",
      retryHint: "Could not load your tasks. Check your connection and try again.",
    },
  );
}
