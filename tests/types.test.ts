import { describe, expect, it } from "vitest";
import { type AsyncState, type TaskId, mapAsyncState, toTaskId } from "../src/types";

describe("mapAsyncState", () => {
  it("maps only the success branch (string)", () => {
    const s: AsyncState<string> = { status: "success", data: "abc" };
    expect(mapAsyncState(s, (d) => d.length)).toEqual({ status: "success", data: 3 });
  });

  it("maps a number state", () => {
    const s: AsyncState<number> = { status: "success", data: 2 };
    expect(mapAsyncState(s, (n) => n * 10)).toEqual({ status: "success", data: 20 });
  });

  it("maps the data kept by a refreshing state without dropping the refreshing status", () => {
    const s: AsyncState<number> = { status: "refreshing", data: 5 };
    expect(mapAsyncState(s, (n) => String(n + 1))).toEqual({ status: "refreshing", data: "6" });
  });

  it("leaves loading, empty and error untouched and never calls fn", () => {
    let calls = 0;
    const fn = (n: number): number => {
      calls += 1;
      return n;
    };
    expect(mapAsyncState<number, number>({ status: "loading" }, fn)).toEqual({ status: "loading" });
    expect(mapAsyncState<number, number>({ status: "empty" }, fn)).toEqual({ status: "empty" });
    expect(mapAsyncState<number, number>({ status: "error", message: "x" }, fn)).toEqual({
      status: "error",
      message: "x",
    });
    expect(calls).toBe(0);
  });
});

describe("TaskId brand", () => {
  it("rejects a plain string at compile time", () => {
    const takesId = (id: TaskId): string => id;
    // @ts-expect-error a raw string is not a TaskId
    takesId("abc");
    expect(takesId(toTaskId("abc"))).toBe("abc");
  });
});
