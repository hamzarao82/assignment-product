import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createAuditLog } from "../src/audit";
import {
  SCHEMA_VERSION,
  applyImport,
  exportTasks,
  previewImport,
  type ImportPreview,
} from "../src/importExport";
import { type Task } from "../src/types";
import { makeTask } from "./helpers";

const NOW = new Date("2024-07-01T08:00:00.000Z");
const d = (day: number): Date => new Date(Date.UTC(2024, 4, day));

function preview(existing: readonly Task[], raw: unknown): ImportPreview {
  const result = previewImport(existing, raw);
  if (!result.ok) throw new Error(`preview failed: ${result.errors.join("; ")}`);
  return result.value;
}

function doc(tasks: readonly Task[], extra: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = JSON.parse(exportTasks(tasks, () => NOW));
  return JSON.stringify({ ...base, ...extra });
}

describe("exportTasks", () => {
  const tasks = [
    makeTask("a", { title: 'He said "hi" <b>', tags: ["x"], dueAt: d(10), version: 3 }),
    makeTask("b", { completedAt: d(2) }),
  ];

  it("writes versioned JSON with a generated timestamp from the injected clock", () => {
    const parsed: Record<string, unknown> = JSON.parse(exportTasks(tasks, () => NOW));
    expect(parsed["schemaVersion"]).toBe(SCHEMA_VERSION);
    expect(parsed["generatedAt"]).toBe("2024-07-01T08:00:00.000Z");
    expect(Array.isArray(parsed["tasks"]) && parsed["tasks"]).toHaveLength(2);
  });

  it("serialises dates as ISO strings and keeps null dates null", () => {
    const parsed: { tasks: Record<string, unknown>[] } = JSON.parse(exportTasks(tasks, () => NOW));
    expect(parsed.tasks[0]?.["dueAt"]).toBe(d(10).toISOString());
    expect(parsed.tasks[0]?.["completedAt"]).toBeNull();
    expect(parsed.tasks[1]?.["completedAt"]).toBe(d(2).toISOString());
  });

  it("preserves awkward text exactly and does not mutate its input", () => {
    const frozen = Object.freeze([...tasks]);
    const parsed: { tasks: { title: string }[] } = JSON.parse(exportTasks(frozen, () => NOW));
    expect(parsed.tasks[0]?.title).toBe('He said "hi" <b>');
    expect(frozen).toHaveLength(2);
  });

  it("exports an empty list as a valid document", () => {
    const result = previewImport(
      [],
      exportTasks([], () => NOW),
    );
    expect(result.ok && result.value.summary.accepted).toBe(0);
  });

  it("falls back to the wall clock when none is injected", () => {
    const parsed: Record<string, unknown> = JSON.parse(exportTasks([]));
    expect(Number.isNaN(Date.parse(String(parsed["generatedAt"])))).toBe(false);
  });
});

describe("previewImport: document validation (from unknown)", () => {
  it.each([
    ["invalid JSON text", "{nope"],
    ["null", null],
    ["an array", []],
    ["a number", 42],
    ["a plain string that is JSON but not an object", '"x"'],
  ])("rejects %s", (_name, raw) => {
    expect(previewImport([], raw).ok).toBe(false);
  });

  it("rejects an unsupported schema version", () => {
    const r = previewImport([], doc([], { schemaVersion: 2 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("schemaVersion");
  });

  it("rejects a missing or malformed generatedAt and a non-array tasks field", () => {
    const r = previewImport([], { schemaVersion: 1, generatedAt: "yesterday", tasks: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(2);
  });

  it("accepts an already-parsed object as well as JSON text", () => {
    const parsed: unknown = JSON.parse(doc([makeTask("a")]));
    expect(previewImport([], parsed).ok).toBe(true);
  });

  it("does not trust hostile keys in the document", () => {
    const hostile = '{"schemaVersion":1,"generatedAt":"2024-01-01","tasks":[],"__proto__":{"x":1}}';
    const r = previewImport([], hostile);
    expect(r.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call({}, "x")).toBe(false);
  });
});

describe("previewImport: dry-run summary", () => {
  it("counts created, updated and unchanged separately", () => {
    const existing = [
      makeTask("same", { title: "same", updatedAt: d(5), version: 2 }),
      makeTask("newer-in-file", { title: "old", updatedAt: d(2), version: 1 }),
      makeTask("newer-here", { title: "mine", updatedAt: d(9), version: 4 }),
    ];
    const incoming = [
      makeTask("same", { title: "same", updatedAt: d(5), version: 2 }),
      makeTask("newer-in-file", { title: "fresh", updatedAt: d(8), version: 2 }),
      makeTask("newer-here", { title: "stale", updatedAt: d(3), version: 1 }),
      makeTask("brand-new"),
    ];
    const p = preview(existing, doc(incoming));
    expect(p.summary).toEqual({
      accepted: 4,
      rejected: 0,
      created: 1,
      updated: 1,
      unchanged: 2,
    });
    expect(p.merged.map((t) => [t.id, t.title])).toEqual([
      ["same", "same"],
      ["newer-in-file", "fresh"],
      ["newer-here", "mine"],
      ["brand-new", "Task brand-new"],
    ]);
  });

  it("uses the higher version when updatedAt ties", () => {
    const existing = [makeTask("a", { title: "v1", updatedAt: d(5), version: 1 })];
    const p = preview(existing, doc([makeTask("a", { title: "v2", updatedAt: d(5), version: 2 })]));
    expect(p.summary.updated).toBe(1);
    expect(p.merged[0]?.title).toBe("v2");
  });

  it("reconciles duplicate ids inside the file itself", () => {
    const p = preview(
      [],
      doc([
        makeTask("a", { title: "older", updatedAt: d(2) }),
        makeTask("a", { title: "newer", updatedAt: d(6) }),
      ]),
    );
    expect(p.summary).toMatchObject({ accepted: 2, created: 1, updated: 0, unchanged: 0 });
    expect(p.merged).toHaveLength(1);
    expect(p.merged[0]?.title).toBe("newer");
  });

  it("rejects invalid records with their index but keeps the valid ones", () => {
    const base: { tasks: unknown[] } = JSON.parse(doc([makeTask("a"), makeTask("b")]));
    base.tasks.splice(1, 0, { id: "", title: "" });
    const p = preview([], JSON.stringify(base));
    expect(p.summary).toMatchObject({ accepted: 2, rejected: 1, created: 2 });
    expect(p.rejected[0]?.index).toBe(1);
  });

  it("changes nothing: the existing list is untouched by a dry run", () => {
    const existing = Object.freeze([makeTask("a", { title: "keep", updatedAt: d(1) })]);
    const p = preview(existing, doc([makeTask("a", { title: "other", updatedAt: d(9) })]));
    expect(existing[0]?.title).toBe("keep");
    expect(p.merged[0]?.title).toBe("other");
    expect(p.baseline).toBe(existing);
  });

  it("treats identical content as unchanged even when ids match and dates round-trip", () => {
    const existing = [makeTask("a", { dueAt: d(10), tags: ["x", "y"] })];
    const p = preview(
      existing,
      exportTasks(existing, () => NOW),
    );
    expect(p.summary).toMatchObject({ unchanged: 1, updated: 0, created: 0 });
  });
});

describe("applyImport", () => {
  const existing = [makeTask("a", { title: "orig", updatedAt: d(1) })];
  const incoming = [
    makeTask("a", { title: "changed", updatedAt: d(9) }),
    makeTask("b", { title: "<img src=x onerror=alert(1)>" }),
  ];

  it("does nothing without an explicit confirmation", () => {
    const p = preview(existing, doc(incoming));
    const result = applyImport(existing, p, { confirmed: false });
    expect(result).toEqual({ applied: false, reason: "not confirmed", tasks: existing });
    expect(result.tasks).toBe(existing);
  });

  it("applies the previewed result once confirmed", () => {
    const p = preview(existing, doc(incoming));
    const result = applyImport(existing, p, { confirmed: true });
    expect(result.applied).toBe(true);
    expect(result.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(result.tasks[0]?.title).toBe("changed");
  });

  it("refuses to apply a preview computed against an older list", () => {
    const p = preview(existing, doc(incoming));
    const changedSince = [...existing, makeTask("late")];
    const result = applyImport(changedSince, p, { confirmed: true });
    expect(result).toEqual({ applied: false, reason: "stale preview", tasks: changedSince });
  });

  it("records an import event with counts only, never imported text", () => {
    const audit = createAuditLog(() => NOW);
    const p = preview(existing, doc(incoming));
    applyImport(existing, p, { confirmed: true }, audit);
    const event = audit.list()[0];
    expect(event?.type).toBe("import");
    expect(event?.summary).toBe("Imported 1 created, 1 updated, 0 unchanged, 0 rejected");
    expect(event?.summary).not.toContain("img");
  });

  it("records nothing in the audit log when the import was not applied", () => {
    const audit = createAuditLog(() => NOW);
    const p = preview(existing, doc(incoming));
    applyImport(existing, p, { confirmed: false }, audit);
    applyImport([...existing], p, { confirmed: true }, audit); // stale
    expect(audit.size()).toBe(0);
  });
});

describe("properties", () => {
  const taskArb = fc
    .record({
      n: fc.nat(1000),
      title: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== ""),
      day: fc.integer({ min: 1, max: 28 }),
      done: fc.boolean(),
      tags: fc.uniqueArray(fc.constantFrom("a", "b", "c", "d"), { maxLength: 3 }),
    })
    .map((r) =>
      makeTask(`t${r.n}`, {
        title: r.title,
        createdAt: d(r.day),
        updatedAt: d(r.day),
        completedAt: r.done ? d(r.day) : null,
        tags: r.tags,
      }),
    );

  it("exporting then importing the same tasks changes nothing", () => {
    fc.assert(
      fc.property(fc.uniqueArray(taskArb, { selector: (t) => t.id }), (tasks) => {
        const result = previewImport(
          tasks,
          exportTasks(tasks, () => NOW),
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.summary).toMatchObject({
            created: 0,
            updated: 0,
            unchanged: tasks.length,
            rejected: 0,
          });
        }
      }),
    );
  });
});
