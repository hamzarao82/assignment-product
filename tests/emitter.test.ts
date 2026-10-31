import { describe, expect, it, vi } from "vitest";
import { createEmitter, reportToConsole } from "../src/emitter";

describe("createEmitter", () => {
  it("delivers each value to every subscriber exactly once, in order", () => {
    const emitter = createEmitter<number>();
    const a: number[] = [];
    const b: number[] = [];
    emitter.subscribe((v) => a.push(v));
    emitter.subscribe((v) => b.push(v));
    emitter.emit(1);
    emitter.emit(2);
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  it("queues an emit made from inside a listener instead of re-entering", () => {
    const emitter = createEmitter<string>();
    const seenA: string[] = [];
    const seenB: string[] = [];
    let triggered = false;
    emitter.subscribe((v) => {
      seenA.push(v);
      if (!triggered) {
        triggered = true;
        emitter.emit("nested");
      }
    });
    emitter.subscribe((v) => seenB.push(v));
    emitter.emit("outer");
    expect(seenA).toEqual(["outer", "nested"]);
    expect(seenB).toEqual(["outer", "nested"]); // not ["nested", "nested"]
  });

  it("treats every subscribe call as its own subscription, even for the same function", () => {
    const emitter = createEmitter<number>();
    const listener = vi.fn();
    const off1 = emitter.subscribe(listener);
    emitter.subscribe(listener);
    expect(emitter.size()).toBe(2);
    off1();
    expect(emitter.size()).toBe(1);
    emitter.emit(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("makes unsubscribe idempotent so a second call cannot remove another subscription", () => {
    const emitter = createEmitter<number>();
    const listener = vi.fn();
    const off1 = emitter.subscribe(listener);
    emitter.subscribe(listener);
    off1();
    off1();
    emitter.emit(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("never calls a listener unsubscribed by an earlier listener during delivery", () => {
    const emitter = createEmitter<number>();
    const second = vi.fn();
    let offSecond: () => void = () => undefined;
    emitter.subscribe(() => offSecond());
    offSecond = emitter.subscribe(second);
    emitter.emit(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("reports a throwing listener and keeps delivering to the others", () => {
    const errors: unknown[] = [];
    const emitter = createEmitter<number>((e) => errors.push(e));
    const after = vi.fn();
    emitter.subscribe(() => {
      throw new Error("listener bug");
    });
    emitter.subscribe(after);
    expect(() => emitter.emit(1)).not.toThrow();
    expect(after).toHaveBeenCalledWith(1);
    expect(errors).toHaveLength(1);
    emitter.emit(2); // the emitter is still healthy afterwards
    expect(after).toHaveBeenCalledTimes(2);
  });

  it("survives a reporter that throws", () => {
    const emitter = createEmitter<number>(() => {
      throw new Error("reporter bug");
    });
    emitter.subscribe(() => {
      throw new Error("listener bug");
    });
    const after = vi.fn();
    emitter.subscribe(after);
    expect(() => emitter.emit(1)).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("still delivers queued values after a listener throws mid-queue", () => {
    const emitter = createEmitter<number>(() => undefined);
    const seen: number[] = [];
    let first = true;
    emitter.subscribe((v) => {
      if (first) {
        first = false;
        emitter.emit(2);
        throw new Error("bug");
      }
      seen.push(v);
    });
    emitter.emit(1);
    expect(seen).toEqual([2]);
  });

  it("the default reporter writes to the console without throwing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reportToConsole(new Error("x"));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
