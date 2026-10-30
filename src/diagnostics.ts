import type { Clock } from "./api";
import type { MetricsSnapshot } from "./metrics";
import type { QueueState } from "./offlineQueue";
import { isOverdue } from "./stats";
import type { StoreState } from "./store";
import type { Priority, TaskListState } from "./types";

const REDACTED = "[redacted]";
const MAX_TASK_ROWS = 200;

/** One task reduced to statuses. Titles and tags are replaced, ids are not included. */
export interface RedactedTask {
  /** Position in the list, not the id (ids can be sensitive too). */
  readonly ref: number;
  readonly priority: Priority;
  readonly completed: boolean;
  readonly overdue: boolean;
  readonly pending: boolean;
  readonly version: number;
  readonly tagCount: number;
  readonly title: typeof REDACTED;
  readonly tags: typeof REDACTED;
}

export interface DiagnosticSnapshot {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly redacted: true;
  readonly tasks: {
    readonly total: number;
    readonly completed: number;
    readonly open: number;
    readonly overdue: number;
    readonly byPriority: Readonly<Record<Priority, number>>;
    readonly withPendingChanges: number;
    readonly listed: readonly RedactedTask[];
    readonly truncated: boolean;
  };
  readonly store: {
    /** Whether an error is showing. The message itself is never included. */
    readonly hasError: boolean;
    readonly error: typeof REDACTED | null;
    readonly conflictCount: number;
    readonly conflicts: readonly {
      readonly intent: "update" | "delete";
      readonly localVersion: number;
      readonly serverVersion: number;
    }[];
  };
  readonly list: {
    readonly status: TaskListState["status"];
    readonly itemCount: number | null;
    readonly hasError: boolean;
  } | null;
  readonly queue: {
    readonly online: boolean;
    readonly depth: number;
    readonly status: QueueState["status"];
    readonly failedKind: string | null;
    readonly failedReason: string | null;
  } | null;
  readonly metrics: MetricsSnapshot | null;
}

export interface DiagnosticInput {
  store: StoreState;
  list?: TaskListState;
  queue?: QueueState;
  metrics?: MetricsSnapshot;
}

/**
 * A snapshot that is safe to paste into a bug report: counts, statuses and versions are
 * included; titles, tags, ids and error messages are never copied, only replaced by a
 * marker. It is plain data (no Dates, no references to live state).
 */
export function createDiagnosticSnapshot(
  input: DiagnosticInput,
  now: Clock = () => new Date(),
): DiagnosticSnapshot {
  const at = now();
  const { store, list, queue, metrics } = input;
  const byPriority: Record<Priority, number> = { low: 0, medium: 0, high: 0 };
  let completed = 0;
  let overdue = 0;
  let withPendingChanges = 0;
  const listed: RedactedTask[] = [];
  store.tasks.forEach((task, ref) => {
    byPriority[task.priority]++;
    const done = task.completedAt !== null;
    const late = isOverdue(task, at);
    const pending = (store.pending[task.id] ?? 0) > 0;
    if (done) completed++;
    if (late) overdue++;
    if (pending) withPendingChanges++;
    if (listed.length < MAX_TASK_ROWS) {
      listed.push({
        ref,
        priority: task.priority,
        completed: done,
        overdue: late,
        pending,
        version: task.version,
        tagCount: task.tags.length,
        title: REDACTED,
        tags: REDACTED,
      });
    }
  });

  let itemCount: number | null = null;
  if (list !== undefined && (list.status === "success" || list.status === "refreshing")) {
    itemCount = list.data.length;
  }

  return {
    schemaVersion: 1,
    generatedAt: at.toISOString(),
    redacted: true,
    tasks: {
      total: store.tasks.length,
      completed,
      open: store.tasks.length - completed,
      overdue,
      byPriority,
      withPendingChanges,
      listed,
      truncated: store.tasks.length > MAX_TASK_ROWS,
    },
    store: {
      hasError: store.error !== null,
      error: store.error === null ? null : REDACTED,
      conflictCount: store.conflicts.length,
      conflicts: store.conflicts.map((c) => ({
        intent: c.intent,
        localVersion: c.local.version,
        serverVersion: c.server.version,
      })),
    },
    list:
      list === undefined
        ? null
        : { status: list.status, itemCount, hasError: list.status === "error" },
    queue:
      queue === undefined
        ? null
        : {
            online: queue.online,
            depth: queue.depth,
            status: queue.status,
            failedKind: queue.failed?.kind ?? null,
            failedReason: queue.failed?.reason ?? null,
          },
    metrics: metrics === undefined ? null : { ...metrics, cache: { ...metrics.cache } },
  };
}

/** The snapshot as pretty JSON text, ready to attach to a bug report. */
export function formatDiagnostics(snapshot: DiagnosticSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}
