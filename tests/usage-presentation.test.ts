import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import betterOpenAI, { _test } from "../index.ts";

// Test through registered commands/events and the host UI/network boundaries.
type EventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionContext) => void | Promise<void>;
type WidgetContent = Parameters<ExtensionContext["ui"]["setWidget"]>[1];

const tempDirs: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];

function createTempProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-presentation-"));
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
  const configPath = join(configDir, "pi-better-openai.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        persistState: false,
        active: false,
        desiredActive: false,
        supportedModels: [],
        usage: { enabled: false },
        footer: { mode: footerMode },
        image: { enabled: false },
        websearch: { enabled: false },
        live: { enabled: false },
        pets: { enabled: false },
        ...overrides,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return configPath;
}

function createHarness(cwd: string, mode: "tui" | "rpc" = "tui") {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const statuses = new Map<string, string>();
  const widgets = new Map<string, WidgetContent>();
  const notify = vi.fn();
  type FooterFactory = Parameters<ExtensionContext["ui"]["setFooter"]>[0];
  let footer: ReturnType<NonNullable<FooterFactory>> | undefined;
  const unsubscribeBranch = vi.fn();
  const setFooter = vi.fn((factory: FooterFactory) => {
    footer?.dispose?.();
    // SAFETY: The factory only uses requestRender and onBranchChange at installation.
    footer = factory?.(
      { requestRender: vi.fn() } as never,
      { fg: (_color: string, text: string) => text } as never,
      { onBranchChange: () => unsubscribeBranch } as never,
    );
  });
  const setStatus = vi.fn((key: string, text: string | undefined) => {
    if (text === undefined) statuses.delete(key);
    else statuses.set(key, text);
  });
  const setWidget = vi.fn((key: string, content: WidgetContent) => {
    if (content === undefined) widgets.delete(key);
    else widgets.set(key, content);
  });
  // SAFETY: The harness implements the registration surfaces used by this extension;
  // unrelated host APIs are not invoked by these command/event scenarios.
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
  // SAFETY: Only these context members are used by the real extension paths exercised here.
  const ctx = {
    cwd,
    mode,
    hasUI: true,
    signal: undefined,
    model: { provider: "openai-codex", id: "gpt-5.5", contextWindow: 100_000 },
    ui: { custom: vi.fn(), notify, setFooter, setStatus, setWidget },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getCwd: vi.fn(() => cwd),
      getBranch: vi.fn(() => []),
      getSessionName: vi.fn(() => ""),
    },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => true),
      // Return synthetic credentials at the public auth boundary; never read real auth.json.
      getApiKeyForProvider: vi.fn(async () =>
        JSON.stringify({ access: "test-access", accountId: "test-account" }),
      ),
    },
    getContextUsage: vi.fn(() => ({ contextWindow: 100_000, percent: 12.5 })),
  } as unknown as ExtensionContext;
  betterOpenAI(pi);
  const h = {
    ctx,
    handlers,
    commands,
    notify,
    setFooter,
    setStatus,
    setWidget,
    unsubscribeBranch,
    presentationText() {
      if (mode === "rpc") return statuses.get("better-openai") ?? "";
      const widget = widgets.get("better-openai");
      if (!widget) return "";
      if (Array.isArray(widget)) return widget.join("\n");
      // SAFETY: The status widget uses only theme.fg and does not access the TUI.
      const component = widget(
        {} as never,
        { fg: (_color: string, text: string) => text } as never,
      );
      return component.render(120).join("\n");
    },
  };
  shutdowns.push(async () => {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
  });
  return h;
}

async function emit(h: ReturnType<typeof createHarness>, event: string, payload: unknown = {}) {
  for (const handler of h.handlers.get(event) ?? []) await handler(payload, h.ctx);
}

function stubUsageFetch(usedPercent: () => number = () => 10) {
  const fetch = vi.fn(async () =>
    Response.json({
      rate_limit: {
        primary_window: { used_percent: usedPercent(), reset_after_seconds: 60 },
        secondary_window: { used_percent: 20, reset_after_seconds: 3600 },
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  vi.stubEnv("PI_CODING_AGENT_DIR", createTempProject());
  vi.stubEnv("CODEX_HOME", createTempProject());
});

afterEach(async () => {
  try {
    for (const shutdown of shutdowns.splice(0)) await shutdown();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  }
});

const CMD = _test.USAGE_PRESENTATION_COMMAND;

describe("openai-usage-presentation command", () => {
  test.each(["tui", "rpc"] as const)(
    "hide/show restores the configured %s status surface",
    async (mode) => {
      vi.useFakeTimers();
      stubUsageFetch();
      const cwd = createTempProject();
      writeProjectConfig(cwd, "status", { usage: { enabled: true, refreshIntervalMs: 60000 } });
      const h = createHarness(cwd, mode);
      await emit(h, "session_start");
      await vi.advanceTimersByTimeAsync(0);
      const visible = h.presentationText();
      expect(visible).not.toBe("");

      await h.commands.get(CMD)!("hide", h.ctx);
      expect(h.presentationText()).toBe("");
      await h.commands.get(CMD)!("show", h.ctx);
      expect(h.presentationText()).toBe(visible);
    },
  );

  test("polls while hidden and shows the latest snapshot without refetching", async () => {
    vi.useFakeTimers();
    let used = 10;
    const fetch = stubUsageFetch(() => used);
    const cwd = createTempProject();
    writeProjectConfig(cwd, "status", { usage: { enabled: true, refreshIntervalMs: 60000 } });
    const h = createHarness(cwd);
    await emit(h, "session_start");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.presentationText()).toContain("5h: 90%");
    expect(fetch).toHaveBeenCalledTimes(1);

    await h.commands.get(CMD)!("hide", h.ctx);
    used = 25;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(h.presentationText()).toBe("");

    await h.commands.get(CMD)!("show", h.ctx);
    expect(h.presentationText()).toContain("5h: 75%");
    expect(fetch).toHaveBeenCalledTimes(2);
    await emit(h, "session_shutdown");
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("failed polling and later recovery cannot reveal hidden presentation", async () => {
    vi.useFakeTimers();
    const fetch = stubUsageFetch();
    const cwd = createTempProject();
    writeProjectConfig(cwd, "status", { usage: { enabled: true, refreshIntervalMs: 60000 } });
    const h = createHarness(cwd);
    await emit(h, "session_start");
    await vi.advanceTimersByTimeAsync(0);
    await h.commands.get(CMD)!("hide", h.ctx);
    fetch.mockRejectedValueOnce(new Error("test network failure"));
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.presentationText()).toBe("");
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(h.presentationText()).toBe("");
    await h.commands.get(CMD)!("show", h.ctx);
    expect(h.presentationText()).toContain("5h: 90%");
  });

  test("presentation commands never persist, even when state persistence is enabled", async () => {
    const cwd = createTempProject();
    const path = writeProjectConfig(cwd, "status", {
      persistState: true,
      custom: { untouched: true },
    });
    const h = createHarness(cwd);
    await emit(h, "session_start");
    const before = readFileSync(path, "utf8");
    for (const action of ["hide", "hide", "show", "show", "toggle"]) {
      await h.commands.get(CMD)!(action, h.ctx);
    }
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("show does not enable configured-off presentation", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "off");
    const h = createHarness(cwd);
    await emit(h, "session_start");
    await h.commands.get(CMD)!("hide", h.ctx);
    await h.commands.get(CMD)!("show", h.ctx);
    expect(h.setFooter).not.toHaveBeenCalled();
    expect(h.presentationText()).toBe("");
  });

  test("hides a pet-forced footer and disposes it through the normal host lifecycle", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "status", { pets: { enabled: true } });
    const h = createHarness(cwd);
    await emit(h, "session_start");
    expect(h.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
    await h.commands.get(CMD)!("hide", h.ctx);
    expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
    expect(h.unsubscribeBranch).toHaveBeenCalledTimes(1);
    h.setFooter.mockClear();
    await emit(h, "turn_end", { message: undefined, toolResults: [] });
    // Let asynchronous pet discovery finish as well: it must respect the same gate.
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.setFooter).not.toHaveBeenCalled();
    await h.commands.get(CMD)!("show", h.ctx);
    expect(h.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
  });

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
