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
import { OriginCancelled, OriginError, type MediaTarget } from "../src/live/remote/origin.ts";
import type { ChooseComputer } from "../src/live/remote/origin.ts";
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

function makeContext(custom: unknown, notify = vi.fn(), select = vi.fn()) {
  return {
    mode: "tui",
    cwd: "/project",
    ui: { custom, notify, select },
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

describe("live voice with audioHost auto", () => {
  const LAPTOP: MediaTarget = { kind: "remote", host: "laptop", node: "nLAPTOP" };
  const OFFERED = ["laptop", "this computer (omarchy)"];
  const TITLE = "Which computer are you at?";

  /** A lookup that finds several computers attached and returns the one that was chosen, as the real one does. */
  const severalAttached = (notes: string[] = []) =>
    vi.fn(async (choose?: ChooseComputer): Promise<MediaTarget> => {
      const picked = await choose!(OFFERED, notes);
      if (picked === undefined || !OFFERED.includes(picked)) throw new OriginCancelled();
      return picked === "laptop" ? LAPTOP : { kind: "local" };
    });

  function setup(resolveTarget: (choose?: ChooseComputer) => Promise<MediaTarget>) {
    const harness = createRegistrationHarness();
    const sessions: Array<ReturnType<typeof makeSessionStub>> = [];
    const arbiter = makeFakeArbiter();
    const createArbiter = vi.fn(arbiter.createArbiter);
    registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { enabled: true, voice: "sol", audioHost: "auto" } }),
      {
        createSession: (options) => {
          const stub = makeSessionStub(options);
          sessions.push(stub);
          return stub;
        },
        createArbiter,
        probeFocusReporting: vi.fn(async () => true),
        attachFocusReporting: vi.fn(() => vi.fn()),
        notifyActivatedUnfocused: vi.fn(),
        tickMs: 60_000,
        resolveTarget,
      },
    );
    const captured: CapturedCustom = { component: undefined, tui: makeFakeTui() };
    const custom = makeCustomMock(captured);
    const notify = vi.fn();
    const select = vi.fn();
    return { harness, sessions, arbiter, createArbiter, custom, notify, select, captured };
  }

  test("asks which computer you are at, with the attached ones, before anything starts", async () => {
    const t = setup(severalAttached(["100.96.150.42: Remote live voice does not support macOS."]));
    t.select.mockResolvedValue("laptop");
    const ctx = makeContext(t.custom, t.notify, t.select);
    const run = commandFrom(t.harness).handler("", ctx);
    await vi.waitFor(() => requireCallbacks(t.arbiter));

    expect(t.select).toHaveBeenCalledOnce();
    expect(t.select).toHaveBeenCalledWith(TITLE, OFFERED);
    expect(t.notify).toHaveBeenCalledWith(
      expect.stringContaining("Not offered: 100.96.150.42"),
      "info",
    );
    // The prompt came before the voice UI and before any session or microphone.
    expect(t.select.mock.invocationCallOrder[0]).toBeLessThan(
      t.custom.mock.invocationCallOrder[0]!,
    );
    expect(t.sessions).toHaveLength(0);

    requireCallbacks(t.arbiter).onActivated("focus");
    await run;
    await expect(t.sessions[0]!.options.resolveMedia!()).resolves.toBeTypeOf("function");
  });

  test("choosing this computer keeps the local media", async () => {
    const t = setup(severalAttached());
    t.select.mockResolvedValue("this computer (omarchy)");
    const run = commandFrom(t.harness).handler("", makeContext(t.custom, t.notify, t.select));
    await vi.waitFor(() => requireCallbacks(t.arbiter));
    requireCallbacks(t.arbiter).onActivated("focus");
    await run;
    await expect(t.sessions[0]!.options.resolveMedia!()).resolves.toBeUndefined();
  });

  test("Escape opens nothing: no voice UI, no floor, no session, and a short notice", async () => {
    const t = setup(severalAttached());
    t.select.mockResolvedValue(undefined);
    await commandFrom(t.harness).handler("", makeContext(t.custom, t.notify, t.select));

    expect(t.custom).not.toHaveBeenCalled();
    expect(t.createArbiter).not.toHaveBeenCalled();
    expect(t.sessions).toHaveLength(0);
    expect(t.notify).toHaveBeenCalledWith(expect.stringMatching(/No computer was chosen/), "info");
  });

  test("a refusal opens nothing either, and says why", async () => {
    const t = setup(async () => {
      throw new OriginError(
        "Pi can't tell. Set live.audioHost to the SSH host of the computer to use.",
      );
    });
    await commandFrom(t.harness).handler("", makeContext(t.custom, t.notify, t.select));
    expect(t.select).not.toHaveBeenCalled();
    expect(t.custom).not.toHaveBeenCalled();
    expect(t.notify).toHaveBeenCalledWith(expect.stringMatching(/live\.audioHost/), "error");
  });

  test("one computer found asks nothing", async () => {
    const t = setup(async () => LAPTOP);
    const run = commandFrom(t.harness).handler("", makeContext(t.custom, t.notify, t.select));
    await vi.waitFor(() => requireCallbacks(t.arbiter));
    requireCallbacks(t.arbiter).onActivated("focus");
    await run;
    expect(t.select).not.toHaveBeenCalled();
    await expect(t.sessions[0]!.options.resolveMedia!()).resolves.toBeTypeOf("function");
  });

  test("a start that waits for the floor keeps the choice, and is not asked again", async () => {
    const resolveTarget = severalAttached();
    const t = setup(resolveTarget);
    t.select.mockResolvedValue("laptop");
    const ctx = makeContext(t.custom, t.notify, t.select);
    const run = commandFrom(t.harness).handler("", ctx);
    await vi.waitFor(() => requireCallbacks(t.arbiter));
    // Queued: the prompt is already behind us, and nothing has started.
    expect(t.sessions).toHaveLength(0);
    expect(t.select).toHaveBeenCalledOnce();

    requireCallbacks(t.arbiter).onActivated("fifo");
    await vi.waitFor(() => {
      if (t.sessions.length !== 1) throw new Error("not activated yet");
    });
    requireCallbacks(t.arbiter).onDeactivated();
    await vi.waitFor(() => {
      if (t.sessions[0]!.stop.mock.calls.length !== 1) throw new Error("not parked yet");
    });
    requireCallbacks(t.arbiter).onActivated("fifo");
    await vi.waitFor(() => {
      if (t.sessions.length !== 2) throw new Error("not activated again yet");
    });

    for (const session of t.sessions) {
      await expect(session.options.resolveMedia!()).resolves.toBeTypeOf("function");
    }
    expect(resolveTarget).toHaveBeenCalledOnce();
    expect(t.select).toHaveBeenCalledOnce();
    commandFrom(t.harness)
      .handler("", ctx)
      .catch(() => undefined);
    await run;
  });

  test("a second /live while the question is open does not ask it twice", async () => {
    let answer!: (label: string) => void;
    const t = setup(severalAttached());
    t.select.mockImplementation(() => new Promise<string>((resolve) => (answer = resolve)));
    const ctx = makeContext(t.custom, t.notify, t.select);
    const first = commandFrom(t.harness).handler("", ctx);
    await vi.waitFor(() => expect(t.select).toHaveBeenCalledOnce());
    await commandFrom(t.harness).handler("", ctx);
    expect(t.select).toHaveBeenCalledOnce();

    answer("laptop");
    await vi.waitFor(() => requireCallbacks(t.arbiter));
    requireCallbacks(t.arbiter).onActivated("focus");
    await first;
  });

  test("an explicit host or no host never asks", async () => {
    for (const audioHost of ["", "me@audio-pc"]) {
      const harness = createRegistrationHarness();
      const resolveTarget = vi.fn(async () => LAPTOP);
      const arbiter = makeFakeArbiter();
      registerOpenAILive(
        harness.pi,
        () => makeResolvedConfig({ live: { enabled: true, voice: "sol", audioHost } }),
        {
          createSession: (options) => makeSessionStub(options),
          createArbiter: arbiter.createArbiter,
          probeFocusReporting: vi.fn(async () => true),
          attachFocusReporting: vi.fn(() => vi.fn()),
          tickMs: 60_000,
          resolveTarget,
        },
      );
      const select = vi.fn();
      const captured: CapturedCustom = { component: undefined, tui: makeFakeTui() };
      const run = commandFrom(harness).handler(
        "",
        makeContext(makeCustomMock(captured), vi.fn(), select),
      );
      await vi.waitFor(() => requireCallbacks(arbiter));
      requireCallbacks(arbiter).onActivated("focus");
      await run;
      expect(select).not.toHaveBeenCalled();
      expect(resolveTarget).not.toHaveBeenCalled();
    }
  });
});

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

  test("keeps the media host launcher fresh at registration, and survives that failing", () => {
    const harness = createRegistrationHarness();
    const registerLauncher = vi.fn(() => {
      throw new Error("read-only home");
    });
    expect(() =>
      registerOpenAILive(
        harness.pi,
        () => makeResolvedConfig({ live: { enabled: true, voice: "vale", audioHost: "" } }),
        {
          registerLauncher,
        },
      ),
    ).not.toThrow();
    expect(registerLauncher).toHaveBeenCalledOnce();
    expect(registerLauncher).toHaveBeenCalledWith({
      entry: expect.stringMatching(/media-host\.mjs$/),
    });
  });

  test("rejects non-TUI and disabled invocations before opening custom UI", async () => {
    const harness = createRegistrationHarness();
    registerOpenAILive(harness.pi, () =>
      makeResolvedConfig({ live: { enabled: false, voice: "sol", audioHost: "" } }),
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
      () => makeResolvedConfig({ live: { enabled: true, voice: "vale", audioHost: "" } }),
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
    expect(sessions[0]!.options.resolveMedia).toBeTypeOf("function");
    expect(sessions[0]!.start).toHaveBeenCalledOnce();
    expect(sessions[0]!.stop).toHaveBeenCalledOnce();
    expect(arbiter.arbiter.leave).toHaveBeenCalledOnce();
    expect(disposeFocus).toHaveBeenCalledOnce();
    expect(notifyUnfocused).not.toHaveBeenCalled();
  });

  test("hands the chosen audio host to the session, so it is reached over ssh", async () => {
    const harness = createRegistrationHarness();
    const sessions: Array<ReturnType<typeof makeSessionStub>> = [];
    const arbiter = makeFakeArbiter();
    registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { enabled: true, voice: "sol", audioHost: "me@audio-pc" } }),
      {
        createSession: (options) => {
          const stub = makeSessionStub(options);
          sessions.push(stub);
          return stub;
        },
        createArbiter: arbiter.createArbiter,
        probeFocusReporting: vi.fn(async () => true),
        attachFocusReporting: vi.fn(() => vi.fn()),
        notifyActivatedUnfocused: vi.fn(),
        tickMs: 60_000,
      },
    );
    const captured: CapturedCustom = { component: undefined, tui: makeFakeTui() };
    const run = commandFrom(harness).handler("", makeContext(makeCustomMock(captured)));
    await vi.waitFor(() => {
      requireCallbacks(arbiter);
    });
    requireCallbacks(arbiter).onActivated("focus");
    await run;

    await expect(sessions[0]!.options.resolveMedia!()).resolves.toBeTypeOf("function");
  });

  test("parks the session back to standby on floor loss without closing the enrollment", async () => {
    const harness = createRegistrationHarness();
    const sessions: Array<ReturnType<typeof makeSessionStub>> = [];
    const arbiter = makeFakeArbiter();
    registerOpenAILive(
      harness.pi,
      () => makeResolvedConfig({ live: { enabled: true, voice: "sol", audioHost: "" } }),
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
      () => makeResolvedConfig({ live: { enabled: true, voice: "sol", audioHost: "" } }),
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
