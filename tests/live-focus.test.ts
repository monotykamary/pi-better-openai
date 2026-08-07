import { describe, expect, test, vi } from "vitest";
import {
  attachFocusReporting,
  DECRQM_FOCUS_QUERY,
  FOCUS_IN_SEQUENCE,
  FOCUS_OUT_SEQUENCE,
  FOCUS_REPORTING_DISABLE,
  FOCUS_REPORTING_ENABLE,
  parseDecrqmFocusResponse,
  parseFocusSequence,
  probeFocusReporting,
  type FocusInputListener,
  type FocusTerminalHandle,
} from "../src/live/focus.ts";

function makeHandle(): FocusTerminalHandle & {
  written: string[];
  emit(data: string): void;
} {
  const written: string[] = [];
  const listeners = new Set<FocusInputListener>();
  return {
    written,
    write(data: string) {
      written.push(data);
    },
    addInputListener(listener: FocusInputListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(data: string) {
      // Snapshot: listeners may unregister themselves mid-dispatch.
      for (const listener of Array.from(listeners)) listener(data);
    },
  };
}

describe("focus sequence parsing", () => {
  test("recognizes mode 1004 focus in/out sequences only", () => {
    expect(parseFocusSequence(FOCUS_IN_SEQUENCE)).toBe(true);
    expect(parseFocusSequence(FOCUS_OUT_SEQUENCE)).toBe(false);
    expect(parseFocusSequence("\x1b[?1004;1$y")).toBeUndefined();
    expect(parseFocusSequence("a")).toBeUndefined();
    expect(parseFocusSequence("")).toBeUndefined();
  });

  test("parses DECRQM focus-reporting responses", () => {
    expect(parseDecrqmFocusResponse("\x1b[?1004;1$y")).toBe(true);
    expect(parseDecrqmFocusResponse("\x1b[?1004;3$y")).toBe(true);
    expect(parseDecrqmFocusResponse("\x1b[?1004;2$y")).toBe(false);
    expect(parseDecrqmFocusResponse("\x1b[?1004;4$y")).toBe(false);
    expect(parseDecrqmFocusResponse("\x1b[?1003;1$y")).toBeUndefined();
    expect(parseDecrqmFocusResponse(FOCUS_IN_SEQUENCE)).toBeUndefined();
  });
});

describe("probeFocusReporting", () => {
  test("resolves supported on any DECRQM response for mode 1004", async () => {
    const handle = makeHandle();
    const probe = probeFocusReporting(handle, 1_000);
    await vi.waitFor(() => {
      if (handle.written.length === 0) throw new Error("probe not written");
    });
    expect(handle.written).toEqual([DECRQM_FOCUS_QUERY]);
    handle.emit("\x1b[?1004;2$y");
    await expect(probe).resolves.toBe(true);
  });

  test("consumes the response so it never reaches the editor", async () => {
    const consumed: unknown[] = [];
    const handle = makeHandle();
    handle.addInputListener = (listener: FocusInputListener) => {
      const seen = listener("\x1b[?1004;1$y");
      consumed.push(seen);
      return () => undefined;
    };
    await expect(probeFocusReporting(handle, 50)).resolves.toBe(true);
    expect(consumed).toEqual([{ consume: true }]);
  });

  test("times out unsupported terminals", async () => {
    const handle = makeHandle();
    await expect(probeFocusReporting(handle, 20)).resolves.toBe(false);
  });
});

describe("attachFocusReporting", () => {
  test("enables mode 1004, forwards focus edges, and restores on dispose", () => {
    const handle = makeHandle();
    const focused: boolean[] = [];
    const dispose = attachFocusReporting(handle, (value) => focused.push(value));

    expect(handle.written).toEqual([FOCUS_REPORTING_ENABLE]);

    handle.emit(FOCUS_IN_SEQUENCE);
    handle.emit(FOCUS_OUT_SEQUENCE);
    handle.emit("typed-letter");
    expect(focused).toEqual([true, false]);

    dispose();
    expect(handle.written).toEqual([FOCUS_REPORTING_ENABLE, FOCUS_REPORTING_DISABLE]);

    handle.emit(FOCUS_IN_SEQUENCE);
    expect(focused).toEqual([true, false]);
  });

  test("consumes focus sequences so they cannot leak into the editor", () => {
    const handle = makeHandle();
    const seen: unknown[] = [];
    const tracked = new Set<FocusInputListener>();
    handle.addInputListener = (listener: FocusInputListener) => {
      tracked.add(listener);
      return () => tracked.delete(listener);
    };
    attachFocusReporting(handle, () => undefined);
    for (const listener of tracked) seen.push(listener(FOCUS_IN_SEQUENCE));
    expect(seen).toEqual([{ consume: true }]);
  });

  test("disposal is idempotent", () => {
    const handle = makeHandle();
    const dispose = attachFocusReporting(handle, () => undefined);
    dispose();
    dispose();
    expect(handle.written.filter((data) => data === FOCUS_REPORTING_DISABLE)).toHaveLength(1);
  });
});
