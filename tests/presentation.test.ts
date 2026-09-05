import { describe, expect, test } from "vitest";
import {
  createPresentationState,
  parsePresentationAction,
  resolvePresentationVisible,
} from "../src/presentation.ts";

describe("usage presentation arg parsing", () => {
  test("parses hide/show variants", () => {
    expect(parsePresentationAction("hide")).toEqual({ action: "hide", valid: true });
    expect(parsePresentationAction("  HIDE  ")).toEqual({ action: "hide", valid: true });
    expect(parsePresentationAction("off")).toEqual({ action: "hide", valid: true });
    expect(parsePresentationAction("show")).toEqual({ action: "show", valid: true });
    expect(parsePresentationAction("on")).toEqual({ action: "show", valid: true });
  });

  test("empty input toggles without hint penalty", () => {
    expect(parsePresentationAction("")).toEqual({ action: "toggle", valid: true });
    expect(parsePresentationAction("toggle")).toEqual({ action: "toggle", valid: true });
  });

  test("unknown input falls back to toggle with hint flag", () => {
    expect(parsePresentationAction("please")).toEqual({ action: "toggle", valid: false });
    expect(parsePresentationAction(42)).toEqual({ action: "toggle", valid: false });
  });
});

describe("usage presentation resolution", () => {
  test("hide/show win over current state, toggle flips", () => {
    expect(resolvePresentationVisible("hide", true)).toBe(false);
    expect(resolvePresentationVisible("hide", false)).toBe(false);
    expect(resolvePresentationVisible("show", false)).toBe(true);
    expect(resolvePresentationVisible("show", true)).toBe(true);
    expect(resolvePresentationVisible("toggle", true)).toBe(false);
    expect(resolvePresentationVisible("toggle", false)).toBe(true);
  });

  test("fresh state starts visible", () => {
    expect(createPresentationState().visible).toBe(true);
  });
});
