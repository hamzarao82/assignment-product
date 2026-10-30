import type { Clock } from "./api";
import type { AuditLog } from "./audit";
import { tasksEqual } from "./equality";
import { mergeTasks, reconcileTask } from "./pagination";
import type { Result, Task } from "./types";
import { ownProp, parseIsoDate, parseTaskList } from "./validation";

export const SCHEMA_VERSION = 1;

export interface SerializedTask {
  id: string;
  title: string;
  priority: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  dueAt: string | null;
  tags: string[];
  version: number;
}

export function serializeTask(task: Task): SerializedTask {
  return {
    id: task.id,
    title: task.title,
    priority: task.priority,
    completedAt: task.completedAt === null ? null : task.completedAt.toISOString(),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    dueAt: task.dueAt === null ? null : task.dueAt.toISOString(),
    tags: [...task.tags],
    version: task.version,
  };
}

/** Versioned JSON export. `now` is injected so the timestamp is testable. */
export function exportTasks(tasks: readonly Task[], now: Clock = () => new Date()): string {
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: now().toISOString(),
      tasks: tasks.map(serializeTask),
    },
    null,
    2,
  );
}

export interface ImportSummary {
  /** Records that passed validation (duplicates inside the file included). */
  accepted: number;
  rejected: number;
  /** The three below count distinct task ids after in-file duplicates were reconciled. */
  created: number;
  updated: number;
  unchanged: number;
}

export interface ImportPreview {
  readonly summary: ImportSummary;
  readonly rejected: readonly { index: number; errors: string[] }[];
  /** The task list as it would be after applying the import. */
  readonly merged: readonly Task[];
  /** The exact list this preview was computed against; apply refuses a different one. */
  readonly baseline: readonly Task[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Dry run. Accepts JSON text or an already-parsed value (always treated as `unknown`),
 * validates the document and every record, and reports what WOULD happen. Nothing is
 * changed. Duplicate ids use the pagination reconciliation rule (later updatedAt, then
 * higher version, then the copy already held).
 */
export function previewImport(existing: readonly Task[], raw: unknown): Result<ImportPreview> {
  let doc: unknown = raw;
  if (typeof raw === "string") {
    try {
      doc = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ["import is not valid JSON"] };
    }
  }
  if (!isRecord(doc)) return { ok: false, errors: ["import must be a JSON object"] };

  const errors: string[] = [];
  if (ownProp(doc, "schemaVersion") !== SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion (expected ${SCHEMA_VERSION})`);
  }
  if (parseIsoDate(ownProp(doc, "generatedAt")) === null) {
    errors.push("generatedAt must be a valid ISO date");
  }
  if (!Array.isArray(ownProp(doc, "tasks"))) errors.push("tasks must be an array");
  if (errors.length > 0) return { ok: false, errors };

  const { tasks: accepted, rejected } = parseTaskList(ownProp(doc, "tasks"), "import");
  const incoming = mergeTasks([], accepted); // reconcile duplicates inside the file

  const byId = new Map(existing.map((t) => [t.id, t]));
  const winners = new Map<string, Task>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const task of incoming) {
    const current = byId.get(task.id);
    if (current === undefined) {
      created++;
      winners.set(task.id, task);
      continue;
    }
    const winner = reconcileTask(current, task);
    if (winner === task && !tasksEqual(current, task)) {
      updated++;
      winners.set(task.id, task);
    } else {
      unchanged++;
    }
  }

  const merged = [
    ...existing.map((t) => winners.get(t.id) ?? t),
    ...incoming.filter((t) => !byId.has(t.id)),
  ];
  return {
    ok: true,
    value: {
      summary: {
        accepted: accepted.length,
        rejected: rejected.length,
        created,
        updated,
        unchanged,
      },
      rejected,
      merged,
      baseline: existing,
    },
  };
}

export type ApplyResult =
  | { applied: true; tasks: readonly Task[] }
  | { applied: false; reason: "not confirmed" | "stale preview"; tasks: readonly Task[] };

/**
 * Applies a previewed import only after an explicit `confirmed: true`, and only to the
 * very list the preview was computed against: if anything changed since, the caller must
 * preview again instead of applying an outdated plan.
 */
export function applyImport(
  existing: readonly Task[],
  preview: ImportPreview,
  decision: { confirmed: boolean },
  audit?: AuditLog,
): ApplyResult {
  if (!decision.confirmed) return { applied: false, reason: "not confirmed", tasks: existing };
  if (preview.baseline !== existing) {
    return { applied: false, reason: "stale preview", tasks: existing };
  }
  const { created, updated, unchanged, rejected } = preview.summary;
  // Counts only: imported text never reaches the audit trail.
  audit?.record(
    "import",
    `Imported ${created} created, ${updated} updated, ${unchanged} unchanged, ${rejected} rejected`,
  );
  return { applied: true, tasks: preview.merged };
}
