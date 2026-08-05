import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LiveVisualizer } from "../src/live/visualizer.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveVisualizer", () => {
  test("renders a fixed five-row panel at every supplied width", () => {
    const visualizer = new LiveVisualizer({
      theme,
      requestRender: vi.fn(),
      onStop: vi.fn(),
      onToggleMute: vi.fn(),
    });
    try {
      for (const width of [0, 1, 2, 40, 80, 140, 200]) {
        const lines = visualizer.render(width);
        expect(lines).toHaveLength(5);
        for (const line of lines) expect(visibleWidth(line)).toBe(width);
      }
    } finally {
      visualizer.dispose();
    }
  });

  test("sanitizes transcript control sequences and handles mute/end keys", () => {
    const onStop = vi.fn();
    const onToggleMute = vi.fn();
    const visualizer = new LiveVisualizer({
      theme,
      requestRender: vi.fn(),
      onStop,
      onToggleMute,
    });
    try {
      visualizer.setTranscript({
        role: "assistant",
        text: "\u001b[31mhello\u001b[0m\tthere",
        turn: 1,
        final: false,
      });
      const rendered = visualizer.render(50).join("\n");
      expect(rendered).toContain("live › hello there");
      expect(rendered).not.toContain("\u001b[31m");

      visualizer.handleInput(" ");
      visualizer.handleInput("\u001b");
      visualizer.handleInput("\u001b[108;6u");
      expect(onToggleMute).toHaveBeenCalledOnce();
      expect(onStop).toHaveBeenCalledTimes(2);
    } finally {
      visualizer.dispose();
    }
  });

  test("animates through requestRender and stops its timer on dispose", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const visualizer = new LiveVisualizer({
      theme,
      requestRender,
      onStop: vi.fn(),
      onToggleMute: vi.fn(),
    });
    const initialConnectingFrame = visualizer.render(80);
    requestRender.mockClear();
    vi.advanceTimersByTime(80);
    expect(visualizer.render(80)).not.toEqual(initialConnectingFrame);
    visualizer.setInputLevel(0.5);
    vi.advanceTimersByTime(160);
    expect(requestRender).toHaveBeenCalledTimes(4);
    visualizer.dispose();
    vi.advanceTimersByTime(240);
    expect(requestRender).toHaveBeenCalledTimes(4);
  });
});
