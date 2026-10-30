import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkPatchAgainstTask,
  parseIsoDate,
  parseTask,
  parseTaskList,
  parseTaskPatch,
} from "../src/validation";
import type { Task } from "../src/types";
import { makeTask } from "./helpers";

const valid = {
  id: "t1",
  title: "Write tests",
  priority: "high",
  completedAt: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-02T00:00:00.000Z",
  dueAt: "2024-02-01T00:00:00.000Z",
  tags: ["a", "b"],
  version: 3,
};

describe("parseIsoDate", () => {
  it.each([
    "2024-01-05",
    "2024-01-05T10:30:00Z",
    "2024-01-05T10:30:00.123Z",
    "2024-01-05T10:30:00+05:00",
    "2024-01-05T10:30Z",
    "2024-02-29T00:00:00Z",
  ])("accepts %s", (s) => {
    expect(parseIsoDate(s)).toBeInstanceOf(Date);
  });

  it.each([
    "March 5, 2024",
    "2024-02-30",
    "2023-02-29",
    "2024-13-01",
    "2024-01-05T10:30:00",
    "2024-1-5",
    "",
    "not-a-date",
    "2024-01-05T25:00:00Z",
  ])("rejects %j", (s) => {
    expect(parseIsoDate(s)).toBeNull();
  });

  it("accepts a valid Date and rejects Invalid Date and non-strings", () => {
    const d = new Date("2024-01-01T00:00:00Z");
    expect(parseIsoDate(d)).toBe(d);
    expect(parseIsoDate(new Date("nope"))).toBeNull();
    expect(parseIsoDate(1704067200000)).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
  });
});

describe("parseTask", () => {
  it("accepts a valid record and converts every date", () => {
    const r = parseTask({ ...valid, completedAt: "2024-01-03T00:00:00.000Z" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.task.createdAt).toBeInstanceOf(Date);
      expect(r.task.updatedAt.toISOString()).toBe("2024-01-02T00:00:00.000Z");
      expect(r.task.dueAt?.toISOString()).toBe("2024-02-01T00:00:00.000Z");
      expect(r.task.completedAt?.toISOString()).toBe("2024-01-03T00:00:00.000Z");
      expect(r.task.version).toBe(3);
    }
  });

  it("treats missing completedAt and dueAt as null", () => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest["completedAt"];
    delete rest["dueAt"];
    const r = parseTask(rest);
    expect(r.ok && r.task.completedAt).toBe(null);
    expect(r.ok && r.task.dueAt).toBe(null);
  });

  it("copies tags so later mutation of the raw input cannot leak in", () => {
    const rawTags = ["a"];
    const r = parseTask({ ...valid, tags: rawTags });
    rawTags.push("b");
    expect(r.ok && r.task.tags).toEqual(["a"]);
  });

  it.each([
    ["empty title", { title: "" }, "title"],
    ["whitespace title", { title: "   " }, "title"],
    ["title over 120", { title: "x".repeat(121) }, "title"],
    ["bad priority", { priority: "urgent" }, "priority"],
    ["missing id", { id: undefined }, "id"],
    ["empty id", { id: "" }, "id"],
    ["non-string tags", { tags: ["a", 1] }, "tags"],
    ["tags not an array", { tags: "a" }, "tags"],
    ["duplicate tags", { tags: ["a", "a"] }, "tags"],
    ["blank tag", { tags: ["a", " "] }, "tags"],
    ["invalid date string", { createdAt: "not-a-date" }, "createdAt"],
    ["non-ISO date string", { createdAt: "March 5, 2024" }, "createdAt"],
    ["impossible calendar day", { createdAt: "2024-02-30" }, "createdAt"],
    ["missing updatedAt", { updatedAt: undefined }, "updatedAt"],
    ["Invalid Date object", { completedAt: new Date("nope") }, "completedAt"],
    ["bad dueAt", { dueAt: "tomorrow" }, "dueAt"],
    ["dueAt before createdAt", { dueAt: "2023-12-31T00:00:00.000Z" }, "dueAt"],
    ["negative version", { version: -1 }, "version"],
    ["fractional version", { version: 1.5 }, "version"],
    ["string version", { version: "2" }, "version"],
    ["missing version", { version: undefined }, "version"],
  ])("rejects %s", (_name, patch, field) => {
    const r = parseTask({ ...valid, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith(field))).toBe(true);
  });

  it("accepts a title of exactly 120 characters and a dueAt equal to createdAt", () => {
    expect(parseTask({ ...valid, title: "x".repeat(120) }).ok).toBe(true);
    expect(parseTask({ ...valid, dueAt: valid.createdAt }).ok).toBe(true);
  });

  it("collects every error in one pass", () => {
    const r = parseTask({
      id: "",
      title: "",
      priority: "x",
      tags: 5,
      createdAt: "bad",
      updatedAt: "bad",
      version: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(7);
  });

  it.each([null, undefined, 42, "str", []])("rejects non-object input %j", (raw) => {
    expect(parseTask(raw).ok).toBe(false);
  });
});

describe("parseTaskList", () => {
  it("keeps good items and reports bad ones with their index", () => {
    const { tasks, rejected } = parseTaskList([valid, { ...valid, title: "" }, valid]);
    expect(tasks).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.index).toBe(1);
  });

  it("handles non-array input gracefully", () => {
    const out = parseTaskList({ nope: true });
    expect(out.tasks).toEqual([]);
    expect(out.rejected).toHaveLength(1);
  });

  it("labels the report with its data source", () => {
    expect(parseTaskList([valid]).source).toBe("api");
    expect(parseTaskList([valid], "import").source).toBe("import");
    expect(parseTaskList("oops", "cache").source).toBe("cache");
  });
});

describe("parseTaskPatch", () => {
  it("accepts every editable field and converts dates", () => {
    const r = parseTaskPatch({
      title: "New",
      priority: "low",
      tags: ["x"],
      completedAt: "2024-03-01T00:00:00Z",
      dueAt: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("New");
      expect(r.value.completedAt).toBeInstanceOf(Date);
      expect(r.value.dueAt).toBeNull();
    }
  });

  it("rejects an unknown key so a typo cannot silently do nothing", () => {
    const r = parseTaskPatch({ tittle: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("unknown key");
  });

  it.each([["id"], ["version"], ["createdAt"], ["updatedAt"]])(
    "does not let a patch touch system-owned field %s",
    (key) => {
      expect(parseTaskPatch({ [key]: "x" }).ok).toBe(false);
    },
  );

  it("rejects a JSON-supplied __proto__ key", () => {
    expect(parseTaskPatch(JSON.parse('{"__proto__": {"title": "x"}}')).ok).toBe(false);
  });

  it("rejects an empty patch and non-objects", () => {
    expect(parseTaskPatch({}).ok).toBe(false);
    expect(parseTaskPatch(null).ok).toBe(false);
    expect(parseTaskPatch([]).ok).toBe(false);
  });

  it("validates values and reports every problem", () => {
    const r = parseTaskPatch({ title: "", priority: "x", tags: ["a", "a"], dueAt: "soon", foo: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(5);
  });
});

describe("checkPatchAgainstTask", () => {
  const task = makeTask("a", { createdAt: new Date("2024-01-10T00:00:00Z") });

  it("rejects a due date before creation and allows the rest", () => {
    expect(checkPatchAgainstTask(task, { dueAt: new Date("2024-01-09T00:00:00Z") })).toContain(
      "dueAt",
    );
    expect(checkPatchAgainstTask(task, { dueAt: new Date("2024-01-10T00:00:00Z") })).toBeNull();
    expect(checkPatchAgainstTask(task, { dueAt: null })).toBeNull();
    expect(checkPatchAgainstTask(task, { title: "x" })).toBeNull();
  });
});

function invariantsHold(task: Task): boolean {
  const unique = new Set(task.tags).size === task.tags.length;
  return (
    task.id.trim() !== "" &&
    task.title.trim() !== "" &&
    task.title.length <= 120 &&
    ["low", "medium", "high"].includes(task.priority) &&
    unique &&
    task.tags.every((t) => t.trim() !== "") &&
    Number.isInteger(task.version) &&
    task.version >= 0 &&
    !Number.isNaN(task.createdAt.getTime()) &&
    !Number.isNaN(task.updatedAt.getTime()) &&
    (task.dueAt === null || task.dueAt >= task.createdAt) &&
    (task.completedAt === null || !Number.isNaN(task.completedAt.getTime()))
  );
}

describe("properties", () => {
  const maybe = <T>(good: fc.Arbitrary<T>): fc.Arbitrary<unknown> =>
    fc.oneof(good, fc.anything(), fc.constant(undefined));
  const isoArb = fc
    .date({ min: new Date("2000-01-01"), max: new Date("2030-01-01"), noInvalidDate: true })
    .map((d) => d.toISOString());
  const rawArb = fc.record({
    id: maybe(fc.string({ minLength: 1 })),
    title: maybe(fc.string({ maxLength: 130 })),
    priority: maybe(fc.constantFrom("low", "medium", "high")),
    tags: maybe(fc.array(fc.string({ maxLength: 5 }), { maxLength: 4 })),
    createdAt: maybe(isoArb),
    updatedAt: maybe(isoArb),
    completedAt: maybe(isoArb),
    dueAt: maybe(isoArb),
    version: maybe(fc.integer({ min: -3, max: 50 })),
  });

  it("every successfully parsed task satisfies the domain invariants", () => {
    fc.assert(
      fc.property(rawArb, (raw) => {
        const r = parseTask(raw);
        if (r.ok) expect(invariantsHold(r.task)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("the parsers never throw, whatever they are given", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(() => parseTask(raw)).not.toThrow();
        expect(() => parseTaskList(raw)).not.toThrow();
        expect(() => parseTaskPatch(raw)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});

describe("own-property reads only (prototype safety)", () => {
  it("ignores fields supplied only by the prototype chain", () => {
    const inherited: unknown = Object.create(valid);
    const r = parseTask(inherited);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(5);
  });

  it("does not let a prototype supply a missing field next to valid own fields", () => {
    const proto = { id: "from-proto" };
    const own = Object.assign(Object.create(proto), { ...valid });
    delete own.id;
    const r = parseTask(own);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith("id"))).toBe(true);
  });

  it("ignores an inherited editable field in a patch", () => {
    const patch: unknown = Object.assign(Object.create({ title: "inherited" }), {
      priority: "low",
    });
    const r = parseTaskPatch(patch);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ priority: "low" });
  });

  it("survives a polluted Object.prototype and always restores it", () => {
    Object.defineProperty(Object.prototype, "title", {
      value: "polluted",
      configurable: true,
      writable: true,
    });
    try {
      const noTitle: Record<string, unknown> = { ...valid };
      delete noTitle["title"];
      expect(parseTask(noTitle).ok).toBe(false); // the polluted title is not accepted
      const patch = parseTaskPatch({ priority: "high" });
      expect(patch.ok && patch.value).toEqual({ priority: "high" });
    } finally {
      Reflect.deleteProperty(Object.prototype, "title");
    }
    expect(Object.prototype.hasOwnProperty.call({}, "title")).toBe(false);
    expect(parseTask({ ...valid }).ok).toBe(true); // and normal parsing still works
  });
});
