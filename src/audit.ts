import type { Clock } from "./api";

export type AuditType = "add" | "edit" | "complete" | "delete" | "import" | "rollback" | "retry";

/** Immutable: every field is a primitive, so a stored event can never change afterwards. */
export interface AuditEvent {
  readonly seq: number;
  /** ISO timestamp (a string, because a Date would be mutable). */
  readonly at: string;
  readonly type: AuditType;
  readonly taskId: string | null;
  /** Safe text only: see toSafeText. */
  readonly summary: string;
}

export interface AuditLog {
  record(type: AuditType, summary: string, taskId?: string | null): AuditEvent;
  list(): readonly AuditEvent[];
  size(): number;
}

/** Code point ranges (inclusive) of control, zero-width and bidirectional-override characters. */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];
const MARKUP = /[<>&"'`]/g;

export function isInvisibleChar(codePoint: number): boolean {
  return INVISIBLE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/**
 * Makes untrusted text safe to store and show in logs: strips control and invisible
 * characters, removes markup-significant characters, collapses whitespace and truncates.
 * Applied inside the audit log itself so no caller can bypass it.
 */
export function toSafeText(input: string, maxLength = 80): string {
  const spaced = Array.from(input, (ch) => (isInvisibleChar(ch.codePointAt(0) ?? 0) ? " " : ch));
  const cleaned = spaced.join("").replace(MARKUP, "").replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, Math.max(0, maxLength - 1))}…` : cleaned;
}

/** Bounded in-memory audit trail: the oldest events are dropped beyond `maxEntries`. */
export function createAuditLog(now: Clock = () => new Date(), maxEntries = 1000): AuditLog {
  const events: AuditEvent[] = [];
  let seq = 0;
  const limit = Math.max(1, Math.floor(maxEntries));
  return {
    record(type, summary, taskId = null) {
      const event: AuditEvent = Object.freeze({
        seq: ++seq,
        at: now().toISOString(),
        type,
        taskId: taskId === null ? null : toSafeText(taskId, 60),
        summary: toSafeText(summary, 120),
      });
      events.push(event);
      if (events.length > limit) events.shift();
      return event;
    },
    list: () => [...events],
    size: () => events.length,
  };
}
