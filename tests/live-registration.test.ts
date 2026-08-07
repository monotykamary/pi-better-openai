import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, test, vi, type Mock } from "vitest";
import {
  LIVE_COMMAND,
  LIVE_DELEGATION_MESSAGE_TYPE,
  registerOpenAILive,
} from "../src/live/index.ts";
import type { LiveSessionControllerOptions } from "../src/live/controller.ts";
import type {
  LiveFloorArbiterCallbacks,
  LiveFloorArbiterLike,
  LiveFloorArbiterOptions,
} from "../src/live/queue.ts";
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

type FakeTui = {
  requestRender: ReturnType<typeof vi.fn>;
  terminal: { write: ReturnType<typeof vi.fn> };
  addInputListener: ReturnType<typeof vi.fn>;
};

function makeFakeTui(): FakeTui {
  return {
    requestRender: vi.fn(),
    terminal: { write: vi.fn() },
    addInputListener: vi.fn(() => vi.fn()),
  };
}

type FakeArbiter = {
  id: string;
  label: string;
  policy: LiveFloorArbiterLike["policy"];
  hasFloor: boolean;
  join: Mock<() => void>;
  leave: Mock<() => void>;
  tick: Mock<() => void>;
  setFocused: Mock<(focused: boolean) => void>;
};

type FakeArbiterControl = {
  options?: LiveFloorArbiterOptions;
  callbacks?: LiveFloorArbiterCallbacks;
  arbiter: FakeArbiter;
  createArbiter: (
    options: LiveFloorArbiterOptions,
    callbacks: LiveFloorArbiterCallbacks,
  ) => LiveFloorArbiterLike;
};

function requireCallbacks(control: FakeArbiterControl): LiveFloorArbiterCallbacks {
  if (!control.callbacks) throw new Error("arbiter not enrolled yet");
  return control.callbacks;
}

function makeFakeArbiter(): FakeArbiterControl {
  const control: FakeArbiterControl = {
    arbiter: undefined as unknown as FakeArbiterControl["arbiter"],
    createArbiter: (options, callbacks) => {
      control.options = options;
      control.callbacks = callbacks;
      control.arbiter = {
        id: "fake-arbiter",
        label: "project · session-7",
        policy: options.policy,
        hasFloor: false,
        join: vi.fn<() => void>(),
        leave: vi.fn<() => void>(),
        tick: vi.fn<() => void>(),
        setFocused: vi.fn<(focused: boolean) => void>(),
      };
      return control.arbiter;
    },
  };
  return control;
}

type CapturedCustom = {
  component: (Component & { dispose?(): void }) | undefined;
  tui: FakeTui;
};

function makeCustomMock(captured: CapturedCustom) {
  return vi.fn(async (factory: unknown) => {
    const tui = makeFakeTui();
    captured.tui = tui;
    const result = await new Promise<unknown>((resolve) => {
      captured.component = (
        factory as (
          tui: FakeTui,
          theme: Theme,
          keybindings: object,
          done: (value: unknown) => void,
        ) => Component & { dispose?(): void }
      )(tui, theme, {}, resolve);
    });
    captured.component?.dispose?.();
    return result;
  });
}

function makeContext(custom: unknown, notify = vi.fn()) {
  return {
    mode: "tui",
    cwd: "/project",
    ui: { custom, notify },
    sessionManager: { getSessionId: () => "session-7" },
    modelRegistry: {},
  } as unknown as ExtensionCommandContext;
}

function makeSessionStub(options: LiveSessionControllerOptions) {
  return {
    options,
    start: vi.fn(async () => options.callbacks.onTerminal()),
    stop: vi.fn(async () => undefined),
    toggleMute: vi.fn(),
    handleAgentMessage: vi.fn(),
    handleAgentSettled: vi.fn(),
  };
}

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

  test("activates on the floor grant and cleans up session and queue on close", async () => {
    const harness = createRegistrationHarness();
    const sessions: Array<ReturnType<typeof makeSessionStub>> = [];
    const arbiter = makeFakeArbiter();
    const disposeFocus = vi.fn();
    const notifyUnfocused = vi.fn();
    registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { enabled: true, voice: "vale" } }),
      {
        createSession: (options) => {
          const stub = makeSessionStub(options);
          sessions.push(stub);
          return stub;
        },
        createArbiter: arbiter.createArbiter,
        probeFocusReporting: vi.fn(async () => true),
        attachFocusReporting: vi.fn(() => disposeFocus),
        notifyActivatedUnfocused: notifyUnfocused,
        tickMs: 60_000,
      },
    );

    const captured: CapturedCustom = { component: undefined, tui: makeFakeTui() };
    const custom = makeCustomMock(captured);
    const ctx = makeContext(custom);

    const run = commandFrom(harness).handler("", ctx);
    await vi.waitFor(() => {
      requireCallbacks(arbiter);
    });
    expect(arbiter.options?.policy).toBe("focus");
    requireCallbacks(arbiter).onActivated("focus");
    await run;

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.options.voice).toBe("vale");
    expect(sessions[0]!.options.sessionId).toBe("session-7");
    expect(sessions[0]!.start).toHaveBeenCalledOnce();
    expect(sessions[0]!.stop).toHaveBeenCalledOnce();
    expect(arbiter.arbiter.leave).toHaveBeenCalledOnce();
    expect(disposeFocus).toHaveBeenCalledOnce();
    expect(notifyUnfocused).not.toHaveBeenCalled();
  });

  test("parks the session back to standby on floor loss without closing the enrollment", async () => {
    const harness = createRegistrationHarness();
    const sessions: Array<ReturnType<typeof makeSessionStub>> = [];
    const arbiter = makeFakeArbiter();
    registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { enabled: true, voice: "sol" } }),
      {
        createSession: (options) => {
          const stub = makeSessionStub(options);
          sessions.push(stub);
          return stub;
        },
        createArbiter: arbiter.createArbiter,
        probeFocusReporting: vi.fn(async () => false),
        attachFocusReporting: vi.fn(() => vi.fn()),
        tickMs: 60_000,
      },
    );

    const captured: CapturedCustom = { component: undefined, tui: makeFakeTui() };
    const custom = makeCustomMock(captured);
    const ctx = makeContext(custom);

    const run = commandFrom(harness).handler("", ctx);
    await vi.waitFor(() => {
      requireCallbacks(arbiter);
    });
    expect(arbiter.options?.policy).toBe("fifo");
    const rendered = captured.component!.render(60).join("\n");
    expect(rendered).toContain("standby");

    requireCallbacks(arbiter).onActivated("fifo");
    await vi.waitFor(() => {
      if (sessions.length !== 1) throw new Error("session not activated yet");
    });
    requireCallbacks(arbiter).onDeactivated();
    await vi.waitFor(() => {
      if (sessions[0]!.stop.mock.calls.length !== 1) throw new Error("session not parked yet");
    });
    expect(captured.component!.render(60).join("\n")).toContain("standby");

    captured.tui.requestRender.mockClear();
    commandFrom(harness)
      .handler("", ctx)
      .catch(() => undefined);
    await run;
    expect(sessions).toHaveLength(1);
    expect(arbiter.arbiter.leave).toHaveBeenCalledOnce();
  });

  test("notifies through the terminal when the floor is granted unfocused", async () => {
    const harness = createRegistrationHarness();
    const sessions: Array<ReturnType<typeof makeSessionStub>> = [];
    const arbiter = makeFakeArbiter();
    const notifyUnfocused = vi.fn();
    registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { enabled: true, voice: "sol" } }),
      {
        createSession: (options) => {
          const stub = makeSessionStub(options);
          sessions.push(stub);
          return stub;
        },
        createArbiter: arbiter.createArbiter,
        probeFocusReporting: vi.fn(async () => true),
        attachFocusReporting: vi.fn(() => vi.fn()),
        notifyActivatedUnfocused: notifyUnfocused,
        tickMs: 60_000,
      },
    );

    const captured: CapturedCustom = { component: undefined, tui: makeFakeTui() };
    const custom = makeCustomMock(captured);
    const ctx = makeContext(custom);

    const run = commandFrom(harness).handler("", ctx);
    await vi.waitFor(() => {
      requireCallbacks(arbiter);
    });
    requireCallbacks(arbiter).onActivated("background");
    await vi.waitFor(() => {
      if (sessions.length !== 1) throw new Error("session not activated yet");
    });
    expect(notifyUnfocused).toHaveBeenCalledOnce();
    expect(notifyUnfocused.mock.calls[0]?.[1]).toBe("project · session-7");

    await run;
  });
});
