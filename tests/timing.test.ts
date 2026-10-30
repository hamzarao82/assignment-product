import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortError, errorMessage, isAbortError, sleep } from "../src/timing";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("abortError / isAbortError", () => {
  it("creates an AbortError that isAbortError recognises", () => {
    expect(isAbortError(abortError())).toBe(true);
    expect(abortError().name).toBe("AbortError");
  });

  it("does not mistake other errors and values for an abort", () => {
    expect(isAbortError(new Error("x"))).toBe(false);
    expect(isAbortError(new DOMException("x", "NotFoundError"))).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe("errorMessage", () => {
  it("returns an Error's message and a safe fallback for anything else", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("a string")).toBe("Unknown error");
    expect(errorMessage(undefined)).toBe("Unknown error");
    expect(errorMessage({ message: "not an Error" })).toBe("Unknown error");
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    const p = sleep(100);
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at once, without starting a timer, when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sleep(1000, ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer when aborted mid-wait", async () => {
    const ctrl = new AbortController();
    const p = sleep(1000, ctrl.signal);
    const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
    ctrl.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes its abort listener once it has finished, so a later abort is harmless", async () => {
    const ctrl = new AbortController();
    const p = sleep(10, ctrl.signal);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(() => ctrl.abort()).not.toThrow();
  });
});
