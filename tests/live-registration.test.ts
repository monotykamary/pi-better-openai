import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
  LIVE_COMMAND,
  LIVE_DELEGATION_MESSAGE_TYPE,
  registerOpenAILive,
} from "../src/live/index.ts";
import type { LiveSessionControllerOptions } from "../src/live/controller.ts";
import { LIVE_VISUALIZER_TOGGLE_KEY } from "../src/live/visualizer.ts";
import { makeResolvedConfig } from "./helpers.ts";

type CommandOptions = {
  description?: string;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};

type ShortcutOptions = {
  description?: string;
  handler(ctx: ExtensionContext): Promise<void> | void;
};

function createRegistrationHarness() {
  const commands = new Map<string, CommandOptions>();
  const shortcuts = new Map<string, ShortcutOptions>();
  const events: string[] = [];
  const renderers: string[] = [];
  const pi = {
    registerCommand: vi.fn((name: string, options: CommandOptions) => commands.set(name, options)),
    registerShortcut: vi.fn((key: string, options: ShortcutOptions) => shortcuts.set(key, options)),
    registerMessageRenderer: vi.fn((type: string) => renderers.push(type)),
    on: vi.fn((event: string) => events.push(event)),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, commands, shortcuts, events, renderers };
}

function commandFrom(harness: ReturnType<typeof createRegistrationHarness>): CommandOptions {
  const command = harness.commands.get(LIVE_COMMAND);
  if (!command) throw new Error("live command was not registered");
  return command;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

describe("registerOpenAILive", () => {
  test("registers the public command, non-conflicting toggle, renderer, and agent hooks", () => {
    const harness = createRegistrationHarness();
    registerOpenAILive(harness.pi, () => makeResolvedConfig());

    expect(harness.commands.has("live")).toBe(true);
    expect(harness.shortcuts.has(LIVE_VISUALIZER_TOGGLE_KEY)).toBe(true);
    expect(LIVE_VISUALIZER_TOGGLE_KEY).toBe("ctrl+shift+l");
    expect(harness.renderers).toContain(LIVE_DELEGATION_MESSAGE_TYPE);
    expect(harness.events).toEqual(["message_end", "agent_settled", "session_shutdown"]);
  });

  test("rejects non-TUI and disabled invocations before opening custom UI", async () => {
    const harness = createRegistrationHarness();
    registerOpenAILive(harness.pi, () =>
      makeResolvedConfig({ live: { enabled: false, voice: "sol" } }),
    );
    const notify = vi.fn();
    const custom = vi.fn();
    const ctx = {
      mode: "rpc",
      ui: { notify, custom },
    } as unknown as ExtensionCommandContext;

    await commandFrom(harness).handler("", ctx);
    expect(notify).toHaveBeenCalledWith("Live voice requires interactive TUI mode.", "warning");
    expect(custom).not.toHaveBeenCalled();

    const tuiCtx = { mode: "tui", ui: { notify, custom } } as unknown as ExtensionCommandContext;
    await commandFrom(harness).handler("", tuiCtx);
    expect(notify).toHaveBeenLastCalledWith(
      "Live voice is disabled. Enable it in /openai-settings.",
      "warning",
    );
    expect(custom).not.toHaveBeenCalled();
  });

  test("forwards the selected voice into a session and cleans it up when the UI closes", async () => {
    const harness = createRegistrationHarness();
    let receivedOptions: LiveSessionControllerOptions | undefined;
    const stop = vi.fn(async () => undefined);
    registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { enabled: true, voice: "vale" } }),
      {
        createSession: (options) => {
          receivedOptions = options;
          return {
            start: vi.fn(async () => options.callbacks.onTerminal()),
            stop,
            toggleMute: vi.fn(),
            handleAgentMessage: vi.fn(),
            handleAgentSettled: vi.fn(),
          };
        },
      },
    );

    const custom = vi.fn(async (factory: unknown) => {
      let component: (Component & { dispose?(): void }) | undefined;
      const result = await new Promise<unknown>((resolve) => {
        component = (
          factory as (
            tui: { requestRender(): void },
            theme: Theme,
            keybindings: object,
            done: (value: unknown) => void,
          ) => Component & { dispose?(): void }
        )({ requestRender: vi.fn() }, theme, {}, resolve);
      });
      component?.dispose?.();
      return result;
    });
    const ctx = {
      mode: "tui",
      cwd: "/project",
      ui: { custom, notify: vi.fn() },
      sessionManager: { getSessionId: () => "session-7" },
      modelRegistry: {},
    } as unknown as ExtensionCommandContext;

    await commandFrom(harness).handler("", ctx);
    expect(custom).toHaveBeenCalledOnce();
    expect(receivedOptions?.voice).toBe("vale");
    expect(receivedOptions?.sessionId).toBe("session-7");
    expect(stop).toHaveBeenCalledOnce();
  });
});
