import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { exportTasks, previewImport, type ImportPreview } from "../src/importExport";
import {
  APP_STYLES,
  renderImportError,
  renderImportPreview,
  renderImportResult,
  renderTaskApp,
} from "../src/render";
import { expectSafeMarkup, tokenize } from "./htmlSafety";
import { makeTask } from "./helpers";

const ctx = { now: new Date("2024-03-10T00:00:00Z") };

function previewOf(over: Partial<ImportPreview> = {}): ImportPreview {
  return {
    summary: { accepted: 4, rejected: 1, created: 2, updated: 1, unchanged: 1 },
    rejected: [],
    merged: [],
    baseline: [],
    ...over,
  };
}

describe("renderImportPreview", () => {
  it("shows all five summary figures and says it is a dry run", () => {
    const html = renderImportPreview(previewOf());
    for (const [label, n] of [
      ["Accepted", 4],
      ["Rejected", 1],
      ["Created", 2],
      ["Updated", 1],
      ["Unchanged", 1],
    ] as const) {
      expect(html).toContain(`<dt>${label}</dt><dd>${n}</dd>`);
    }
    expect(html).toContain("This is a dry run. Nothing has changed yet.");
  });

  it("offers labelled confirm and cancel buttons with the focus hook", () => {
    const buttons = tokenize(renderImportPreview(previewOf())).tags.filter(
      (t) => t.name === "button",
    );
    expect(buttons.map((b) => b.attrs["data-action"])).toEqual(["confirm-import", "cancel-import"]);
    for (const b of buttons) {
      expect(b.attrs["type"]).toBe("button");
      expect(b.attrs["class"]).toContain("focus-ring");
    }
  });

  it("lists rejected records, numbered from 1, only when there are some", () => {
    expect(renderImportPreview(previewOf())).not.toContain("import-rejected");
    const html = renderImportPreview(
      previewOf({ rejected: [{ index: 1, errors: ["title must be a non-empty string", "x"] }] }),
    );
    expect(html).toContain('aria-label="Rejected records"');
    expect(html).toContain("Record 2: title must be a non-empty string; x");
  });

  it("is a labelled region", () => {
    const { tags } = tokenize(renderImportPreview(previewOf()));
    const section = tags.find((t) => t.name === "section");
    expect(tags.some((t) => t.attrs["id"] === section?.attrs["aria-labelledby"])).toBe(true);
  });

  it("escapes hostile text in rejection messages (import text)", () => {
    const html = renderImportPreview(
      previewOf({
        rejected: [{ index: 0, errors: [`<script>alert(1)</script>`, `" onmouseover="alert(1)`] }],
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expectSafeMarkup(html);
  });

  it("works on a real preview produced from a file with a bad record", () => {
    const base: { tasks: unknown[] } = JSON.parse(
      exportTasks([makeTask("a"), makeTask("b")], () => new Date("2024-01-01")),
    );
    base.tasks.splice(1, 0, { id: "", title: "" });
    const result = previewImport([], JSON.stringify(base));
    if (!result.ok) throw new Error("preview failed");
    const html = renderImportPreview(result.value);
    expect(html).toContain("<dt>Created</dt><dd>2</dd>");
    expect(html).toContain("Record 2:");
    expectSafeMarkup(html);
  });
});

describe("renderImportError and renderImportResult", () => {
  it("announces an unreadable file as an alert, with escaped reasons and a way out", () => {
    const html = renderImportError(["import is not valid JSON", "<b>bad</b>"]);
    const { tags } = tokenize(html);
    expect(tags.find((t) => t.name === "section")?.attrs["role"]).toBe("alert");
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    expect(tags.find((t) => t.name === "button")?.attrs["data-action"]).toBe("cancel-import");
    expectSafeMarkup(html);
  });

  it("dispatches on the result", () => {
    expect(renderImportResult({ ok: true, value: previewOf() })).toContain("Import preview");
    expect(renderImportResult({ ok: false, errors: ["nope"] })).toContain(
      "Could not read the import file",
    );
  });

  it("is part of the app when a result is supplied, inside the single main landmark", () => {
    const html = renderTaskApp({
      state: { status: "empty" },
      ctx,
      importResult: { ok: true, value: previewOf() },
    });
    const { tags } = tokenize(html);
    expect(tags.filter((t) => t.name === "main")).toHaveLength(1);
    expect(html).toContain("Import preview");
    expectSafeMarkup(html);
    expect(renderTaskApp({ state: { status: "empty" }, ctx })).not.toContain("Import preview");
  });

  it("property: hostile rejection text can never become markup", () => {
    const hostile = fc
      .array(fc.constantFrom("<", ">", '"', "'", "&", "/", "=", " ", "o", "n", "script"), {
        maxLength: 14,
      })
      .map((parts) => parts.join(""));
    fc.assert(
      fc.property(hostile, hostile, (a, b) => {
        expectSafeMarkup(
          renderImportPreview(previewOf({ rejected: [{ index: 0, errors: [a, b] }] })),
        );
        expectSafeMarkup(renderImportError([a, b]));
      }),
      { numRuns: 300 },
    );
  });
});

describe("APP_STYLES (visible focus)", () => {
  it("makes keyboard focus visible on the hook class", () => {
    expect(APP_STYLES).toContain(".focus-ring:focus-visible");
    expect(APP_STYLES).toMatch(/\.focus-ring:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  });

  it("never removes the focus outline", () => {
    expect(APP_STYLES).not.toMatch(/outline:\s*(none|0)\b/);
  });

  it("styles every focus-related hook the markup emits", () => {
    const html = renderTaskApp({ state: { status: "success", data: [makeTask("a")] }, ctx });
    const classes = new Set(
      tokenize(html).tags.flatMap((t) => (t.attrs["class"] ?? "").split(/\s+/)),
    );
    for (const hook of ["focus-ring", "skip-link", "visually-hidden"]) {
      expect(classes.has(hook)).toBe(true);
      expect(APP_STYLES).toContain(`.${hook}`);
    }
  });

  it("reveals the skip link on focus and respects reduced motion", () => {
    expect(APP_STYLES).toContain(".skip-link:focus-visible");
    expect(APP_STYLES).toMatch(/prefers-reduced-motion:\s*reduce/);
  });
});
