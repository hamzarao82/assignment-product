import type { Conflict, TaskSummary } from "./conflict";
import type { ImportPreview } from "./importExport";
import { computeStats, isOverdue } from "./stats";
import { type AsyncState, type Result, type Task, type TaskListState, assertNever } from "./types";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Every piece of user-supplied text (titles, tags, ids, error messages, imported and
 * conflict text) must pass through here before entering HTML, in text AND attributes.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

export interface Labels {
  loading?: string;
  empty?: string;
  emptyHint?: string;
  retryHint?: string;
  retryLabel?: string;
}

const BUTTON = "btn focus-ring";

/**
 * Generic, exhaustive renderer. Every state tells the user something: progress (loading,
 * refreshing), guidance (empty), a way out (error + Retry) or the data itself. If a new
 * AsyncState variant is ever added, `assertNever` stops compiling until it is handled.
 */
export function renderAsyncState<T>(
  state: AsyncState<T>,
  renderData: (data: T) => string,
  labels: Labels = {},
): string {
  switch (state.status) {
    case "loading":
      return (
        `<div class="state state--loading" aria-busy="true">` +
        `<span class="spinner" aria-hidden="true"></span>` +
        `<p>${escapeHtml(labels.loading ?? "Loading…")}</p></div>`
      );
    case "empty":
      return (
        `<div class="state state--empty">` +
        `<p class="state__title">${escapeHtml(labels.empty ?? "Nothing to show yet.")}</p>` +
        `<p class="state__hint">${escapeHtml(labels.emptyHint ?? "New items will appear here.")}</p>` +
        `</div>`
      );
    case "error":
      return (
        `<div class="state state--error" role="alert">` +
        `<p class="state__message">${escapeHtml(state.message)}</p>` +
        `<p class="state__hint">${escapeHtml(labels.retryHint ?? "Please try again.")}</p>` +
        `<button type="button" class="${BUTTON}" data-action="retry">` +
        `${escapeHtml(labels.retryLabel ?? "Retry")}</button></div>`
      );
    case "success":
      return renderData(state.data);
    case "refreshing":
      return (
        `<div class="state state--refreshing" aria-busy="true">` +
        `<p>${escapeHtml(labels.loading ?? "Loading…")}</p></div>` +
        renderData(state.data)
      );
    default:
      return assertNever(state);
  }
}

export interface RenderContext {
  now: Date;
  /** Per-task count of unconfirmed mutations (from the store). */
  pending?: Readonly<Record<string, number>>;
}

/** YYYY-MM-DD, tolerant of an invalid Date instead of throwing. */
function isoDay(date: Date): string {
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 10);
}

export function renderTask(task: Task, ctx: RenderContext): string {
  const done = task.completedAt !== null;
  const overdue = isOverdue(task, ctx.now);
  const pending = (ctx.pending?.[task.id] ?? 0) > 0;
  const classes = [
    "task",
    `task--${task.priority}`,
    done ? "task--done" : "task--open",
    ...(overdue ? ["task--overdue"] : []),
    ...(pending ? ["task--pending"] : []),
  ].join(" ");
  const id = escapeHtml(task.id);
  const title = escapeHtml(task.title);
  const tags = task.tags.map((t) => `<li class="task__tag">${escapeHtml(t)}</li>`).join("");
  return (
    `<li class="${escapeHtml(classes)}" data-task-id="${id}"${pending ? ' aria-busy="true"' : ""}>` +
    `<span class="task__title">${title}</span> ` +
    `<span class="task__priority">${escapeHtml(task.priority)}</span> ` +
    `<span class="task__status">${done ? "Done" : "Open"}</span>` +
    (task.dueAt === null
      ? ""
      : ` <time class="task__due" datetime="${escapeHtml(isoDay(task.dueAt))}">Due ${escapeHtml(isoDay(task.dueAt))}</time>`) +
    (overdue ? ` <span class="task__overdue">Overdue</span>` : "") +
    (pending ? ` <span class="task__pending" role="status">Saving…</span>` : "") +
    (tags ? `<ul class="task__tags" aria-label="Tags">${tags}</ul>` : "") +
    `<span class="task__actions">` +
    `<button type="button" class="${BUTTON}" data-action="toggle" data-task-id="${id}" ` +
    `aria-label="${done ? "Reopen" : "Complete"} task: ${title}">${done ? "Reopen" : "Complete"}</button>` +
    `<button type="button" class="${BUTTON}" data-action="delete" data-task-id="${id}" ` +
    `aria-label="Delete task: ${title}">Delete</button>` +
    `</span></li>`
  );
}

function summaryLine(tasks: readonly Task[], ctx: RenderContext): string {
  const s = computeStats(tasks, ctx.now);
  return `${s.total} ${s.total === 1 ? "task" : "tasks"}, ${s.completed} completed, ${s.overdue} overdue`;
}

const TASK_LABELS: Labels = {
  loading: "Loading tasks…",
  empty: "No tasks yet",
  emptyHint: "Add your first task to get started.",
  retryHint: "Could not load your tasks. Check your connection and try again.",
  retryLabel: "Retry",
};

/**
 * A success or refreshing state holding no tasks is the same thing as empty to the user,
 * so it is shown as empty (never as a blank list); refreshing with nothing to keep is
 * just loading.
 */
function normalize(state: TaskListState): TaskListState {
  if (state.status === "success" && state.data.length === 0) return { status: "empty" };
  if (state.status === "refreshing" && state.data.length === 0) return { status: "loading" };
  return state;
}

function renderList(tasks: readonly Task[], ctx: RenderContext): string {
  return (
    `<p class="task-summary">${escapeHtml(summaryLine(tasks, ctx))}</p>` +
    `<ul class="task-list">${tasks.map((t) => renderTask(t, ctx)).join("")}</ul>`
  );
}

export function renderTaskList(state: TaskListState, ctx: RenderContext): string {
  return renderAsyncState(normalize(state), (tasks) => renderList(tasks, ctx), TASK_LABELS);
}

/** Plain-text announcement for the polite live region. */
export function describeState(state: TaskListState, ctx: RenderContext): string {
  const s = normalize(state);
  switch (s.status) {
    case "loading":
      return "Loading tasks…";
    case "refreshing":
      return `Refreshing tasks. ${summaryLine(s.data, ctx)}`;
    case "empty":
      return "No tasks yet.";
    case "error":
      return "Could not load tasks.";
    case "success":
      return summaryLine(s.data, ctx);
    default:
      return assertNever(s);
  }
}

function summaryText(label: string, s: TaskSummary): string {
  return (
    `<dt>${label}</dt><dd>${escapeHtml(s.title)}, ${escapeHtml(s.priority)}, ` +
    `${s.completed ? "done" : "open"}, version ${s.version}</dd>`
  );
}

export function renderConflict(conflict: Conflict): string {
  const id = escapeHtml(conflict.taskId);
  const verb = conflict.intent === "delete" ? "delete" : "change";
  return (
    `<div class="conflict" data-task-id="${id}">` +
    `<p>Your ${verb} to “${escapeHtml(conflict.server.title)}” was based on an older version.</p>` +
    `<dl>${summaryText("Yours", conflict.local)}${summaryText("Server", conflict.server)}</dl>` +
    `<button type="button" class="${BUTTON}" data-action="resolve-conflict" data-choice="local" data-task-id="${id}">Keep mine</button>` +
    `<button type="button" class="${BUTTON}" data-action="resolve-conflict" data-choice="server" data-task-id="${id}">Keep theirs</button>` +
    `</div>`
  );
}

export interface AppView {
  state: TaskListState;
  ctx: RenderContext;
  /** Latest mutation failure from the store. */
  error?: string | null;
  conflicts?: readonly Conflict[];
  /** A pending import: the dry-run preview, or why the file could not be read. */
  importResult?: Result<ImportPreview>;
}

/**
 * The whole screen as an HTML string: a skip link, one <main> landmark, a polite
 * status region announcing load progress and summaries, an assertive alert region for
 * mutation errors and conflicts (always present, so changes are announced), and the
 * labelled task list. Interactive elements carry the `focus-ring` hook class.
 */
export function renderTaskApp(view: AppView): string {
  const alerts =
    (view.error ? `<p class="alert__message">${escapeHtml(view.error)}</p>` : "") +
    (view.conflicts ?? []).map(renderConflict).join("");
  return (
    `<a class="skip-link focus-ring" href="#task-list-title">Skip to task list</a>` +
    `<main class="app" aria-labelledby="app-title">` +
    `<header class="app__header"><h1 id="app-title">Tasks</h1></header>` +
    `<p class="app__status" role="status" aria-live="polite" aria-atomic="true">` +
    `${escapeHtml(describeState(view.state, view.ctx))}</p>` +
    `<div class="app__alerts" role="alert" aria-atomic="true">${alerts}</div>` +
    `<section class="tasks" aria-labelledby="task-list-title">` +
    `<h2 id="task-list-title" class="visually-hidden">Task list</h2>` +
    `${renderTaskList(view.state, view.ctx)}</section>` +
    (view.importResult === undefined ? "" : renderImportResult(view.importResult)) +
    `</main>`
  );
}

/** Dry-run import summary. Every number is plain; every piece of text is escaped. */
export function renderImportPreview(preview: ImportPreview): string {
  const { accepted, rejected, created, updated, unchanged } = preview.summary;
  const rows: readonly (readonly [string, number])[] = [
    ["Accepted", accepted],
    ["Rejected", rejected],
    ["Created", created],
    ["Updated", updated],
    ["Unchanged", unchanged],
  ];
  const problems = preview.rejected
    .map((r) => `<li>Record ${r.index + 1}: ${r.errors.map(escapeHtml).join("; ")}</li>`)
    .join("");
  return (
    `<section class="import-preview" aria-labelledby="import-title">` +
    `<h2 id="import-title">Import preview</h2>` +
    `<p class="import-preview__note">This is a dry run. Nothing has changed yet.</p>` +
    `<dl class="import-summary">${rows.map(([k, n]) => `<dt>${k}</dt><dd>${n}</dd>`).join("")}</dl>` +
    (problems ? `<ul class="import-rejected" aria-label="Rejected records">${problems}</ul>` : "") +
    `<button type="button" class="${BUTTON}" data-action="confirm-import">Apply import</button>` +
    `<button type="button" class="${BUTTON}" data-action="cancel-import">Cancel</button>` +
    `</section>`
  );
}

/** Shown instead of a preview when the file itself could not be read. */
export function renderImportError(errors: readonly string[]): string {
  return (
    `<section class="import-preview import-preview--error" role="alert" aria-labelledby="import-title">` +
    `<h2 id="import-title">Could not read the import file</h2>` +
    `<ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` +
    `<button type="button" class="${BUTTON}" data-action="cancel-import">Close</button>` +
    `</section>`
  );
}

export function renderImportResult(result: Result<ImportPreview>): string {
  return result.ok ? renderImportPreview(result.value) : renderImportError(result.errors);
}

/**
 * Minimal styles for the hooks the markup emits. Focus is made visible with a strong
 * outline on :focus-visible and is never removed; motion respects the user preference.
 */
export const APP_STYLES = `
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.skip-link { position: absolute; left: -9999px; top: 0; }
.skip-link:focus-visible { left: 0; z-index: 10; background: #fff; padding: 0.5rem 1rem; }
.focus-ring:focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; }
.task--done .task__title { text-decoration: line-through; }
.task--overdue .task__overdue { color: #b00020; font-weight: 600; }
.task--pending { opacity: 0.7; }
.spinner { display: inline-block; width: 1em; height: 1em; border: 2px solid currentColor;
  border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`;
