import { describe, expect, it } from "vitest";
import { escapeHtml, renderAsyncState, renderTask, renderTaskList } from "../src/render";
import type { AsyncState } from "../src/types";
import { makeTask } from "./helpers";

const now = new Date("2024-03-01T00:00:00Z");

describe("escapeHtml", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("leaves safe text untouched", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
  });
});

describe("renderTask", () => {
  it("neutralises a script tag in the title", () => {
    const html = renderTask(makeTask("a", { title: "<script>alert(1)</script>" }), { now });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes tags too", () => {
    const html = renderTask(makeTask("a", { tags: ['"><img src=x onerror=alert(1)>'] }), { now });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("shows priority and open status with styling hooks", () => {
    const html = renderTask(
      makeTask("a", { priority: "high", createdAt: new Date("2024-02-29") }),
      { now },
    );
    expect(html).toContain("task--high");
    expect(html).toContain("task--open");
    expect(html).toContain(">high<");
    expect(html).toContain(">Open<");
    expect(html).not.toContain("task--overdue");
  });

  it("marks completed tasks and never flags them overdue", () => {
    const html = renderTask(
      makeTask("a", { createdAt: new Date("2023-01-01"), completedAt: new Date("2023-01-02") }),
      { now },
    );
    expect(html).toContain("task--done");
    expect(html).toContain(">Done<");
    expect(html).not.toContain("task--overdue");
  });

  it("marks old open tasks overdue, respecting the threshold", () => {
    const old = makeTask("a", { createdAt: new Date("2024-02-01") });
    expect(renderTask(old, { now })).toContain("task--overdue");
    expect(renderTask(old, { now, overdueAfterDays: 60 })).not.toContain("task--overdue");
  });

  it("renders tags as a list only when present", () => {
    expect(renderTask(makeTask("a"), { now })).not.toContain("task__tags");
    expect(renderTask(makeTask("a", { tags: ["x", "y"] }), { now })).toContain(
      '<li class="task__tag">y</li>',
    );
  });
});

describe("renderTaskList", () => {
  it("renders loading, empty, error and success distinctly", () => {
    const outputs = [
      renderTaskList({ status: "loading" }, { now }),
      renderTaskList({ status: "empty" }, { now }),
      renderTaskList({ status: "error", message: "boom" }, { now }),
      renderTaskList({ status: "success", data: [makeTask("a")] }, { now }),
    ];
    expect(new Set(outputs).size).toBe(4);
    expect(outputs[0]).toContain("state--loading");
    expect(outputs[1]).toContain("No tasks yet");
    expect(outputs[2]).toContain("state--error");
    expect(outputs[2]).toContain("try again");
    expect(outputs[3]).toContain('<ul class="task-list">');
  });

  it("escapes the error message", () => {
    const html = renderTaskList({ status: "error", message: "<b>bad</b>" }, { now });
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
  });
});

describe("renderAsyncState is generic", () => {
  it("renders AsyncState<string>", () => {
    const s: AsyncState<string> = { status: "success", data: "hello <world>" };
    expect(renderAsyncState(s, (d) => `<p>${escapeHtml(d)}</p>`)).toBe(
      "<p>hello &lt;world&gt;</p>",
    );
  });

  it("renders AsyncState<number>", () => {
    const s: AsyncState<number> = { status: "success", data: 42 };
    expect(renderAsyncState(s, (n) => `<b>${n * 2}</b>`)).toBe("<b>84</b>");
  });

  it("uses default labels for non-success states and never calls renderData", () => {
    const s: AsyncState<number> = { status: "empty" };
    const html = renderAsyncState(s, () => {
      throw new Error("should not render data");
    });
    expect(html).toContain("Nothing to show yet.");
    expect(renderAsyncState<number>({ status: "loading" }, String)).toContain("Loading…");
    expect(renderAsyncState<number>({ status: "error", message: "x" }, String)).toContain(
      "Please try again.",
    );
  });
});
