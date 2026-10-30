import { describe, expect, it } from "vitest";
import { exportTasks, previewImport } from "../src/importExport";
import { createOfflineQueue } from "../src/offlineQueue";
import { makeTask } from "./helpers";

/** An object whose every field comes from its prototype, as a class instance could. */
function inheritedOnly(fields: object): unknown {
  return Object.create(fields);
}

describe("import boundary ignores inherited data", () => {
  const document: object = JSON.parse(exportTasks([makeTask("a")], () => new Date("2024-01-01")));

  it("rejects a document whose schemaVersion, generatedAt and tasks are all inherited", () => {
    const r = previewImport([], inheritedOnly(document));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("still accepts the same document when the fields are its own", () => {
    expect(previewImport([], document).ok).toBe(true);
  });

  it("drops a task record whose fields are inherited", () => {
    const real = JSON.parse(exportTasks([makeTask("a")], () => new Date("2024-01-01")));
    real.tasks = [inheritedOnly(real.tasks[0])];
    const r = previewImport([], real);
    expect(r.ok && r.value.summary).toMatchObject({ accepted: 0, rejected: 1 });
  });
});

describe("offline queue restore ignores inherited data", () => {
  const queue = () => createOfflineQueue({ execute: () => Promise.resolve(), online: false });
  const good = { kind: "delete", taskId: "a", expectedVersion: 0 };

  it("refuses a queue document whose version and ops are inherited", () => {
    expect(queue().restore(inheritedOnly({ schemaVersion: 1, ops: [{ op: good }] })).ok).toBe(
      false,
    );
  });

  it("rejects an operation whose kind and fields are inherited", () => {
    const q = queue();
    const result = q.restore({ schemaVersion: 1, ops: [{ op: inheritedOnly(good) }] });
    expect(result).toEqual({ ok: true, value: { restored: 0, rejected: 1 } });
    expect(q.getState().depth).toBe(0);
  });

  it("restores the same operation when its fields are its own", () => {
    const q = queue();
    expect(q.restore({ schemaVersion: 1, ops: [{ op: good }] })).toEqual({
      ok: true,
      value: { restored: 1, rejected: 0 },
    });
  });
});
