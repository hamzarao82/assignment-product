import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Conflict, summarizeTask } from "../src/conflict";
import {
  describeState,
  escapeHtml,
  renderAsyncState,
  renderConflict,
  renderTask,
  renderTaskApp,
  renderTaskList,
} from "../src/render";
import { type AsyncState, toTaskId } from "../src/types";
import { expectSafeMarkup, tokenize } from "./htmlSafety";
import { makeTask } from "./helpers";

const now = new Date("2024-03-10T00:00:00Z");
const ctx = { now };

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

describe("renderTask: escaping", () => {
  it("neutralises a script tag in the title", () => {
    const html = renderTask(makeTask("a", { title: "<script>alert(1)</script>" }), ctx);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expectSafeMarkup(html);
  });

  it("neutralises an attribute-breaking payload in title, tag and id", () => {
    const payload = `" onmouseover="alert(1)" x="`;
    const html = renderTask(
      makeTask(payload, { title: payload, tags: [payload, `'><img src=x onerror=alert(1)>`] }),
      ctx,
    );
    expectSafeMarkup(html);
    expect(tokenize(html).tags.filter((t) => t.name === "img")).toHaveLength(0);
  });

  it("escapes tags too", () => {
    const html = renderTask(makeTask("a", { tags: ['"><img src=x onerror=alert(1)>'] }), ctx);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("renderTask: content and hooks", () => {
  it("shows priority and open status with styling hooks", () => {
    const html = renderTask(makeTask("a", { priority: "high" }), ctx);
    expect(html).toContain("task--high");
    expect(html).toContain("task--open");
    expect(html).toContain(">high<");
    expect(html).toContain(">Open<");
    expect(html).not.toContain("task--overdue");
  });

  it("marks completed tasks and never flags them overdue, even past their due date", () => {
    const html = renderTask(
      makeTask("a", { dueAt: new Date("2024-01-01"), completedAt: new Date("2024-01-02") }),
      ctx,
    );
    expect(html).toContain("task--done");
    expect(html).toContain(">Done<");
    expect(html).not.toContain("task--overdue");
  });

  it("marks an open task overdue only once its due date has passed", () => {
    const late = renderTask(makeTask("a", { dueAt: new Date("2024-03-09T00:00:00Z") }), ctx);
    const future = renderTask(makeTask("a", { dueAt: new Date("2024-03-11T00:00:00Z") }), ctx);
    const none = renderTask(makeTask("a"), ctx);
    expect(late).toContain("task--overdue");
    expect(late).toContain(">Overdue<");
    expect(future).not.toContain("task--overdue");
    expect(none).not.toContain("task--overdue");
  });

  it("shows the due date in a time element", () => {
    const html = renderTask(makeTask("a", { dueAt: new Date("2024-05-06T12:00:00Z") }), ctx);
    expect(html).toContain('<time class="task__due" datetime="2024-05-06">Due 2024-05-06</time>');
  });

  it("renders tags as a labelled list only when present", () => {
    expect(renderTask(makeTask("a"), ctx)).not.toContain("task__tags");
    const html = renderTask(makeTask("a", { tags: ["x", "y"] }), ctx);
    expect(html).toContain('<ul class="task__tags" aria-label="Tags">');
    expect(html).toContain('<li class="task__tag">y</li>');
  });

  it("marks a task with unconfirmed changes as pending and busy", () => {
    const html = renderTask(makeTask("a"), { now, pending: { a: 2 } });
    expect(html).toContain("task--pending");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Saving…");
    expect(renderTask(makeTask("a"), { now, pending: { b: 1 } })).not.toContain("task--pending");
  });
});

describe("renderTask: accessible controls", () => {
  it("gives every button a type, a label naming the task, and the focus hook class", () => {
    const html = renderTask(makeTask("a", { title: "Pay rent" }), ctx);
    const buttons = tokenize(html).tags.filter((t) => t.name === "button");
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b.attrs["type"]).toBe("button");
      expect(b.attrs["class"]).toContain("focus-ring");
      expect(b.attrs["aria-label"]).toContain("Pay rent");
      expect(b.attrs["data-task-id"]).toBe("a");
    }
    expect(buttons.map((b) => b.attrs["aria-label"])).toEqual([
      "Complete task: Pay rent",
      "Delete task: Pay rent",
    ]);
  });

  it("changes the toggle label to Reopen for a completed task", () => {
    const html = renderTask(
      makeTask("a", { title: "T", completedAt: new Date("2024-01-02") }),
      ctx,
    );
    expect(html).toContain('aria-label="Reopen task: T"');
  });
});

describe("renderTaskList: every state says something different", () => {
  const states = {
    loading: renderTaskList({ status: "loading" }, ctx),
    empty: renderTaskList({ status: "empty" }, ctx),
    error: renderTaskList({ status: "error", message: "boom" }, ctx),
    success: renderTaskList({ status: "success", data: [makeTask("a")] }, ctx),
    refreshing: renderTaskList({ status: "refreshing", data: [makeTask("a")] }, ctx),
  };

  it("renders five distinct outputs", () => {
    expect(new Set(Object.values(states)).size).toBe(5);
  });

  it("loading communicates progress", () => {
    expect(states.loading).toContain("Loading tasks…");
    expect(states.loading).toContain('aria-busy="true"');
    expect(states.loading).toContain("state--loading");
  });

  it("empty gives clear guidance", () => {
    expect(states.empty).toContain("No tasks yet");
    expect(states.empty).toContain("Add your first task");
  });

  it("error shows the message, a retry hint and a Retry button", () => {
    expect(states.error).toContain("boom");
    expect(states.error).toContain("try again");
    expect(states.error).toContain('role="alert"');
    const retry = tokenize(states.error).tags.find((t) => t.name === "button");
    expect(retry?.attrs["data-action"]).toBe("retry");
    expect(retry?.attrs["class"]).toContain("focus-ring");
  });

  it("success summarises the data and lists it", () => {
    expect(states.success).toContain("1 task, 0 completed, 0 overdue");
    expect(states.success).toContain('<ul class="task-list">');
  });

  it("refreshing keeps the old data visible and says it is refreshing", () => {
    expect(states.refreshing).toContain("state--refreshing");
    expect(states.refreshing).toContain('<ul class="task-list">');
    expect(states.refreshing).toContain("Task a");
  });

  it("escapes the error message", () => {
    const html = renderTaskList({ status: "error", message: "<b>bad</b>" }, ctx);
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
  });

  it("pluralises the summary", () => {
    const html = renderTaskList(
      { status: "success", data: [makeTask("a"), makeTask("b", { completedAt: now })] },
      ctx,
    );
    expect(html).toContain("2 tasks, 1 completed, 0 overdue");
  });
});

describe("regression R1: an empty success is never a blank list", () => {
  it("shows the empty guidance for success with no tasks", () => {
    const html = renderTaskList({ status: "success", data: [] }, ctx);
    expect(html).toContain("No tasks yet");
    expect(html).not.toContain("task-list");
  });

  it("shows plain loading for refreshing with nothing to keep", () => {
    const html = renderTaskList({ status: "refreshing", data: [] }, ctx);
    expect(html).toContain("state--loading");
    expect(html).not.toContain("task-list");
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

  it("uses default labels and never calls renderData for non-data states", () => {
    const never = (): string => {
      throw new Error("should not render data");
    };
    expect(renderAsyncState<number>({ status: "empty" }, never)).toContain("Nothing to show yet.");
    expect(renderAsyncState<number>({ status: "loading" }, never)).toContain("Loading…");
    expect(renderAsyncState<number>({ status: "error", message: "x" }, never)).toContain(
      "Please try again.",
    );
  });

  it("throws on a state it does not know (the runtime face of the exhaustive switch)", () => {
    const unknownState: AsyncState<number> = JSON.parse('{"status":"zzz"}');
    expect(() => renderAsyncState(unknownState, String)).toThrow("Unexpected value");
  });
});

describe("describeState (the live announcement)", () => {
  it("has a sentence for every state", () => {
    expect(describeState({ status: "loading" }, ctx)).toBe("Loading tasks…");
    expect(describeState({ status: "empty" }, ctx)).toBe("No tasks yet.");
    expect(describeState({ status: "error", message: "x" }, ctx)).toBe("Could not load tasks.");
    expect(describeState({ status: "success", data: [makeTask("a")] }, ctx)).toBe(
      "1 task, 0 completed, 0 overdue",
    );
    expect(describeState({ status: "refreshing", data: [makeTask("a")] }, ctx)).toBe(
      "Refreshing tasks. 1 task, 0 completed, 0 overdue",
    );
  });

  it("treats an empty success as empty, like the renderer", () => {
    expect(describeState({ status: "success", data: [] }, ctx)).toBe("No tasks yet.");
    expect(describeState({ status: "refreshing", data: [] }, ctx)).toBe("Loading tasks…");
  });
});

describe("renderTaskApp: landmarks and live regions", () => {
  const view = { state: { status: "success", data: [makeTask("a")] } as const, ctx };

  it("has exactly one main landmark labelled by the page heading", () => {
    const { tags } = tokenize(renderTaskApp(view));
    const mains = tags.filter((t) => t.name === "main");
    expect(mains).toHaveLength(1);
    const labelledBy = mains[0]?.attrs["aria-labelledby"];
    expect(tags.some((t) => t.name === "h1" && t.attrs["id"] === labelledBy)).toBe(true);
  });

  it("labels the task section by a heading that exists", () => {
    const { tags } = tokenize(renderTaskApp(view));
    const section = tags.find((t) => t.name === "section");
    expect(
      tags.some((t) => t.name === "h2" && t.attrs["id"] === section?.attrs["aria-labelledby"]),
    ).toBe(true);
  });

  it("provides a skip link whose target exists", () => {
    const { tags } = tokenize(renderTaskApp(view));
    const skip = tags.find((t) => t.name === "a");
    expect(skip?.attrs["href"]).toBe("#task-list-title");
    expect(skip?.attrs["class"]).toContain("focus-ring");
    expect(tags.some((t) => t.attrs["id"] === "task-list-title")).toBe(true);
  });

  it("announces progress and summaries through a polite live region", () => {
    const html = renderTaskApp({ state: { status: "loading" }, ctx });
    const status = tokenize(html).tags.find(
      (t) => t.attrs["role"] === "status" && t.attrs["aria-live"] === "polite",
    );
    expect(status).toBeDefined();
    expect(html).toContain("Loading tasks…</p>");
  });

  it("always renders the alert region, empty when there is nothing to announce", () => {
    const html = renderTaskApp(view);
    expect(html).toContain('<div class="app__alerts" role="alert" aria-atomic="true"></div>');
  });

  it("puts a mutation error in the alert region, escaped", () => {
    const html = renderTaskApp({ ...view, error: "Could not update task: <b>x</b>" });
    expect(html).toContain('role="alert" aria-atomic="true"><p class="alert__message">');
    expect(html).not.toContain("<b>x</b>");
    expectSafeMarkup(html);
  });

  it("renders the loading, empty and error screens inside the same landmark", () => {
    for (const state of [
      { status: "loading" },
      { status: "empty" },
      { status: "error", message: "m" },
    ] as const) {
      expect(renderTaskApp({ state, ctx })).toContain('<main class="app"');
    }
  });
});

describe("renderConflict", () => {
  const local = summarizeTask(makeTask("a", { title: `mine "<i>"`, version: 1 }));
  const server = summarizeTask(makeTask("a", { title: `theirs <u>`, version: 4 }));
  const conflict: Conflict = {
    taskId: toTaskId(`a"><x`),
    intent: "update",
    patch: { title: "x" },
    local,
    server,
  };

  it("shows both sides and offers labelled choices", () => {
    const html = renderConflict(conflict);
    expect(html).toContain("Yours");
    expect(html).toContain("Server");
    expect(html).toContain("version 4");
    const buttons = tokenize(html).tags.filter((t) => t.name === "button");
    expect(buttons.map((b) => b.attrs["data-choice"])).toEqual(["local", "server"]);
    for (const b of buttons) expect(b.attrs["class"]).toContain("focus-ring");
  });

  it("escapes every piece of text on both sides and the task id", () => {
    expectSafeMarkup(renderConflict(conflict));
  });

  it("words a delete conflict differently", () => {
    expect(renderConflict({ ...conflict, intent: "delete", patch: null })).toContain(
      "Your delete to",
    );
  });

  it("is included in the app's alert region", () => {
    const html = renderTaskApp({
      state: { status: "success", data: [makeTask("a")] },
      ctx,
      conflicts: [conflict],
    });
    expect(html).toContain("Keep mine");
    expectSafeMarkup(html);
  });
});

describe("property: hostile text can never become markup", () => {
  it("whatever the title, tag, id and error contain, only generated tags and allowed attributes appear", () => {
    // Random binary text almost never contains markup characters, so bias heavily towards them.
    const hostile = fc
      .array(fc.constantFrom("<", ">", '"', "'", "&", "/", "=", " ", "o", "n", "x", "script"), {
        maxLength: 14,
      })
      .map((parts) => parts.join(""));
    const text = fc.oneof(hostile, hostile, fc.string({ unit: "binary", maxLength: 40 }));
    fc.assert(
      fc.property(text, text, text, text, (title, tag, id, error) => {
        const task = makeTask(id === "" ? "x" : id, {
          title: title === "" ? "t" : title,
          tags: [tag],
        });
        expectSafeMarkup(
          renderTaskApp({
            state: { status: "success", data: [task] },
            ctx: { now, pending: { [task.id]: 1 } },
            error,
          }),
        );
      }),
      { numRuns: 300 },
    );
  });
});
