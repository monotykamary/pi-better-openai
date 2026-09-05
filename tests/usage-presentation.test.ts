import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import betterOpenAI, { _test } from "../index.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionContext) => void | Promise<void>;

const tempDirs: string[] = [];

function createTempProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-presentation-"));
  tempDirs.push(cwd);
  return cwd;
}

function writeProjectConfig(cwd: string, footerMode: "replace" | "status" | "off") {
  const configDir = join(cwd, ".pi", "extensions");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "pi-better-openai.json"),
    JSON.stringify(
      {
        persistState: false,
        active: false,
        desiredActive: false,
        supportedModels: [],
        usage: { enabled: false },
        footer: { mode: footerMode },
        image: { enabled: false },
        pets: { enabled: false },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function createHarness(cwd: string) {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const notify = vi.fn();
  const setFooter = vi.fn();
  const setStatus = vi.fn();
  const setWidget = vi.fn();
  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
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
    ui: { custom: vi.fn(), notify, setFooter, setStatus, setWidget },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getLeafId: vi.fn(() => "leaf-1"),
      getCwd: vi.fn(() => cwd),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: { isUsingOAuth: vi.fn(() => false) },
    getContextUsage: vi.fn(() => ({ contextWindow: 100_000, percent: 12.5 })),
  } as unknown as ExtensionContext;
  betterOpenAI(pi);
  return { ctx, handlers, commands, notify, setFooter, setStatus, setWidget };
}

async function emit(h: ReturnType<typeof createHarness>, event: string, payload: unknown = {}) {
  for (const handler of h.handlers.get(event) ?? []) await handler(payload, h.ctx);
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CMD = (_test as { USAGE_PRESENTATION_COMMAND: string }).USAGE_PRESENTATION_COMMAND;

describe("openai-usage-presentation command", () => {
  test("registers the presentation command", () => {
    const h = createHarness(createTempProject());
    expect(h.commands.has(CMD)).toBe(true);
  });

  test("hide clears replace footer, show reinstalls it", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const h = createHarness(cwd);
    await emit(h, "session_start");
    expect(h.setFooter).toHaveBeenCalled();
    const installs = h.setFooter.mock.calls.length;

    await h.commands.get(CMD)!("hide", h.ctx);
    expect(h.notify).toHaveBeenLastCalledWith("Better OpenAI footer hidden.", "info");
    expect(h.setFooter).toHaveBeenLastCalledWith(undefined);

    await h.commands.get(CMD)!("show", h.ctx);
    expect(h.notify).toHaveBeenLastCalledWith("Better OpenAI footer shown.", "info");
    expect(h.setFooter.mock.calls.length).toBeGreaterThan(installs + 1);
  });

  test("hide suppresses re-render from turn_end while hidden", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const h = createHarness(cwd);
    await emit(h, "session_start");
    await h.commands.get(CMD)!("hide", h.ctx);
    h.setFooter.mockClear();
    await emit(h, "turn_end", { message: undefined, toolResults: [] });
    // turn_end while hidden must not reinstall the footer
    expect(h.setFooter).not.toHaveBeenCalled();
  });

  test("double hide is idempotent with already-hidden notice", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const h = createHarness(cwd);
    await emit(h, "session_start");
    await h.commands.get(CMD)!("hide", h.ctx);
    h.setFooter.mockClear();
    h.notify.mockClear();
    await h.commands.get(CMD)!("hide", h.ctx);
    expect(h.notify).toHaveBeenLastCalledWith("Better OpenAI footer already hidden.", "info");
    expect(h.setFooter).not.toHaveBeenCalled();
  });

  test("typo toggles and appends hint", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const h = createHarness(cwd);
    await emit(h, "session_start");
    await h.commands.get(CMD)!("please", h.ctx);
    expect(h.notify).toHaveBeenLastCalledWith(
      "Better OpenAI footer hidden. (use hide|show)",
      "info",
    );
  });

  test("session_start resets to visible", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const h = createHarness(cwd);
    await emit(h, "session_start");
    await h.commands.get(CMD)!("hide", h.ctx);
    await emit(h, "session_start");
    // after reset, footer is installed again by session_start
    expect(h.setFooter.mock.calls.at(-1)?.[0]).toEqual(expect.any(Function));
  });
});
