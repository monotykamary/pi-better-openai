import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import betterOpenAI, { _test } from "../index.ts";
import { stripAnsi } from "../src/format.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionContext) => void | Promise<void>;

type Harness = {
  ctx: ExtensionContext;
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, CommandHandler>;
  custom: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  getEntries: ReturnType<typeof vi.fn>;
  getLeafId: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
  getSessionName: ReturnType<typeof vi.fn>;
  setFooter: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  setWidget: ReturnType<typeof vi.fn>;
};

const tempDirs: string[] = [];

function createTempProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-footer-"));
  tempDirs.push(cwd);
  return cwd;
}

function writeProjectConfig(
  cwd: string,
  footerMode: "replace" | "status" | "off",
  overrides: Record<string, unknown> = {},
) {
  const configDir = join(cwd, ".pi", "extensions");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "pi-better-openai.json"),
    `${JSON.stringify(
      {
        persistState: false,
        active: false,
        desiredActive: false,
        supportedModels: [],
        usage: { enabled: false },
        footer: { mode: footerMode },
        image: { enabled: false },
        pets: { enabled: false },
        ...overrides,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function createHarness(cwd: string): Harness {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const custom = vi.fn();
  const notify = vi.fn();
  const getEntries = vi.fn(() => []);
  const getLeafId = vi.fn(() => "leaf-1");
  const getContextUsage = vi.fn(() => ({ contextWindow: 100_000, percent: 12.5 }));
  const getSessionName = vi.fn(() => undefined);
  const setFooter = vi.fn();
  const setStatus = vi.fn();
  const setWidget = vi.fn();

  const pi = {
    on(event: string, handler: EventHandler) {
      const currentHandlers = handlers.get(event) ?? [];
      currentHandlers.push(handler);
      handlers.set(event, currentHandlers);
    },
    registerFlag: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commands.set(name, command.handler);
    },
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerShortcut: vi.fn(),
    sendMessage: vi.fn(),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "off"),
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    signal: undefined,
    model: undefined,
    ui: {
      custom,
      notify,
      setFooter,
      setStatus,
      setWidget,
    },
    sessionManager: {
      getEntries,
      getLeafId,
      getCwd: vi.fn(() => cwd),
      getSessionName,
    },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => false),
    },
    getContextUsage,
  } as unknown as ExtensionContext;

  betterOpenAI(pi);

  return {
    ctx,
    handlers,
    commands,
    custom,
    notify,
    getEntries,
    getLeafId,
    getContextUsage,
    getSessionName,
    setFooter,
    setStatus,
    setWidget,
  };
}

async function emit(harness: Harness, event: string, payload: unknown = {}) {
  const handlers = harness.handlers.get(event) ?? [];
  for (const handler of handlers) {
    await handler(payload, harness.ctx);
  }
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("footer path formatting", () => {
  test("abbreviates only exact home and child paths", () => {
    expect(_test.abbreviateHomePath("/Users/alice/project", "/Users/alice")).toBe("~/project");
    expect(_test.abbreviateHomePath("/Users/alice", "/Users/alice")).toBe("~");
    expect(_test.abbreviateHomePath("/Users/alice2/project", "/Users/alice")).toBe(
      "/Users/alice2/project",
    );
    expect(_test.abbreviateHomePath("/Users/alice/project", undefined)).toBe(
      "/Users/alice/project",
    );
  });
});

describe("diagnostic text panel", () => {
  test("closes only for explicit close keys, not arrow escape sequences", () => {
    const done = vi.fn();
    const panel = _test.textPanel("Diagnostics", ["line"], done);

    panel.handleInput("\x1b[A");
    expect(done).not.toHaveBeenCalled();

    panel.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("footer pet layout", () => {
  test("keeps terminal-image pets on the left for inline-left placement", () => {
    const imageLine = "\x1b[1A\x1b_Ga=p,i=1\x1b\\\x1b[1B";

    const lines = _test.combineInlinePetFooter(
      ["", imageLine],
      ["path", "stats"],
      20,
      "inline-left",
      4,
    );

    expect(lines[0]).toBe("      path");
    expect(lines[1]).toMatch(/^ {6}stats/);
    expect(lines[1]).toContain("\x1b[0m\r\x1b[1A\x1b_Ga=p,i=1\x1b\\\x1b[1B");
    expect(lines[1]).not.toContain("\x1b[1A\x1b[1A");
    expect(lines[1]).not.toContain("\x1b[1B\x1b[1B");
  });
});

describe("footer mode ownership", () => {
  test("reuses context usage between renders and invalidates it on message changes", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      { fg: (_color: string, value: string) => value },
      {},
    );

    footer.render(100);
    footer.render(100);
    expect(harness.getContextUsage).toHaveBeenCalledTimes(1);
    expect(harness.getSessionName).toHaveBeenCalledTimes(1);

    await emit(harness, "message_update");
    footer.render(100);
    expect(harness.getContextUsage).toHaveBeenCalledTimes(2);

    harness.getLeafId.mockReturnValue("leaf-2");
    footer.render(100);
    expect(harness.getContextUsage).toHaveBeenCalledTimes(3);
    expect(harness.getSessionName).toHaveBeenCalledTimes(2);
    footer.dispose();
  });

  test("renders each extension status dimmed on its own line", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      {
        fg: (color: string, value: string) =>
          color === "dim" ? `\x1b[90m${value}\x1b[39m` : value,
      },
      {
        getExtensionStatuses: () =>
          new Map([
            ["z-status", "version 2"],
            ["a-status", "version 1"],
          ]),
      },
    );

    const lines = footer.render(100);
    expect(lines.slice(2).map(stripAnsi)).toEqual(["version 1", "version 2"]);
    expect(lines[2]?.startsWith("\x1b[90m")).toBe(true);
    expect(lines[3]?.startsWith("\x1b[90m")).toBe(true);
    footer.dispose();
  });

  test("adds completed-turn usage without rescanning the full session", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    await emit(harness, "turn_end", {
      message: {
        role: "assistant",
        usage: {
          input: 1_200,
          output: 300,
          cacheRead: 400,
          cacheWrite: 50,
          cost: { total: 0.25 },
        },
      },
      toolResults: [],
    });

    expect(harness.getEntries).toHaveBeenCalledTimes(1);
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      { fg: (_color: string, value: string) => value },
      {},
    );
    expect(footer.render(100).join("\n")).toContain("↑1.2k ↓300 R400 W50 $0.250");
    footer.dispose();
  });

  test("does not install terminal-only UI in RPC mode", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);
    Object.assign(harness.ctx, { mode: "rpc", hasUI: true });

    await emit(harness, "session_start");

    expect(harness.setFooter).not.toHaveBeenCalled();
  });

  test("does not open the custom settings component in RPC mode", async () => {
    const cwd = createTempProject();
    const harness = createHarness(cwd);
    Object.assign(harness.ctx, { mode: "rpc", hasUI: true });

    await harness.commands.get("openai-settings")?.("", harness.ctx);

    expect(harness.custom).not.toHaveBeenCalled();
    expect(harness.notify).toHaveBeenCalledWith(
      "Better OpenAI settings require interactive TUI mode.",
      "warning",
    );
  });

  test("off mode leaves existing footer customizations untouched on session start", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "off");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");

    expect(harness.setFooter).not.toHaveBeenCalled();
    expect(harness.setStatus).not.toHaveBeenCalled();
  });

  test("status mode renders dimmed text on its own line without replacing the footer", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "status", {
      persistState: true,
      active: true,
      desiredActive: true,
      supportedModels: ["openai-codex/gpt-5.6"],
    });
    const harness = createHarness(cwd);
    harness.ctx.model = {
      provider: "openai-codex",
      id: "gpt-5.6",
      reasoning: true,
    } as ExtensionContext["model"];

    await emit(harness, "session_start");

    expect(harness.setFooter).not.toHaveBeenCalled();
    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(harness.setWidget).toHaveBeenCalledTimes(1);
    expect(harness.setWidget.mock.calls[0]?.[2]).toEqual({ placement: "belowEditor" });

    const widgetFactory = harness.setWidget.mock.calls[0]?.[1];
    const widget = widgetFactory(
      {},
      {
        fg: (color: string, value: string) => (color === "dim" ? `\x1b[2m${value}\x1b[22m` : value),
      },
    );
    const lines = widget.render(100);
    expect(lines.map(stripAnsi)).toEqual(["gpt-5.6 fast"]);
    expect(lines[0]?.startsWith("\x1b[2m")).toBe(true);
  });

  test("off mode clears the Better OpenAI footer only after Better OpenAI installed it", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    expect(harness.setFooter).toHaveBeenCalledTimes(1);
    expect(harness.setFooter).toHaveBeenLastCalledWith(expect.any(Function));

    writeProjectConfig(cwd, "off");
    await emit(harness, "session_start");

    expect(harness.setFooter).toHaveBeenCalledTimes(2);
    expect(harness.setFooter).toHaveBeenLastCalledWith(undefined);
  });

  test("off mode does not clear a footer after Better OpenAI's footer was disposed", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    expect(footerFactory).toEqual(expect.any(Function));

    const footer = footerFactory(
      { requestRender: vi.fn() },
      {},
      { onBranchChange: vi.fn(() => vi.fn()) },
    );
    footer.dispose();

    writeProjectConfig(cwd, "off");
    await emit(harness, "session_start");

    expect(harness.setFooter).toHaveBeenCalledTimes(1);
  });
});
