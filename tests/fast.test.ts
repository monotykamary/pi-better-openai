import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import betterOpenAI from "../index.ts";
import { configPaths, readRawConfig } from "../src/config.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;

type Harness = {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, { handler: CommandHandler }>;
};

const tempDirs: string[] = [];

function createTempProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-fast-"));
  tempDirs.push(cwd);
  return cwd;
}

function writeProjectConfig(cwd: string, overrides: Record<string, unknown> = {}): void {
  const configDir = join(cwd, ".pi", "extensions");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "pi-better-openai.json"),
    `${JSON.stringify(
      {
        persistState: true,
        active: false,
        desiredActive: false,
        supportedModels: ["openai/gpt-5.5"],
        usage: { enabled: false },
        footer: { mode: "off" },
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

function createModel(provider: string, id: string) {
  return {
    provider,
    id,
    api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
    baseUrl:
      provider === "openai-codex" ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1",
  } as ExtensionContext["model"];
}

function createHarness(cwd: string, model = createModel("openai", "gpt-5.5")): Harness {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, { handler: CommandHandler }>();

  const pi = {
    on(event: string, handler: EventHandler) {
      const currentHandlers = handlers.get(event) ?? [];
      currentHandlers.push(handler);
      handlers.set(event, currentHandlers);
    },
    registerFlag: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn((name: string, command: { handler: CommandHandler }) => {
      commands.set(name, command);
    }),
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerShortcut: vi.fn(),
    sendMessage: vi.fn(),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "off"),
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd,
    hasUI: false,
    signal: undefined,
    model,
    ui: {
      notify: vi.fn(),
      setFooter: vi.fn(),
      setStatus: vi.fn(),
    },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getCwd: vi.fn(() => cwd),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => false),
    },
    getContextUsage: vi.fn(() => ({ contextWindow: 0, percent: 0 })),
  } as unknown as ExtensionContext;

  betterOpenAI(pi);

  return { pi, ctx, handlers, commands };
}

async function emit(harness: Harness, event: string, payload: unknown = {}): Promise<unknown[]> {
  const results: unknown[] = [];
  const handlers = harness.handlers.get(event) ?? [];
  for (const handler of handlers) {
    results.push(await handler(payload, harness.ctx));
  }
  return results;
}

async function beforeProviderRequest(
  harness: Harness,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const results = await emit(harness, "before_provider_request", { payload });
  return results.find((result) => result !== undefined);
}

beforeEach(() => {
  vi.stubEnv("PI_CODING_AGENT_DIR", createTempProject());
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("service tiers", () => {
  test.each(["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"])(
    "enables Fast by default for Codex %s",
    async (id) => {
      const cwd = createTempProject();
      writeProjectConfig(cwd, { desiredActive: true, supportedModels: undefined });
      const h = createHarness(cwd, createModel("openai-codex", id));
      await emit(h, "session_start");
      expect(await beforeProviderRequest(h, { model: id })).toEqual({
        model: id,
        service_tier: "priority",
      });
    },
  );

  test("keeps Ultrafast API-only when OpenAI switches to ChatGPT OAuth", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, { serviceTier: "ultrafast", supportedModels: undefined });
    const h = createHarness(cwd, createModel("openai", "gpt-6-astra"));
    await emit(h, "session_start");
    const payload = { model: "gpt-6-astra" };
    expect(await beforeProviderRequest(h, payload)).toMatchObject({ service_tier: "ultrafast" });

    vi.mocked(h.ctx.modelRegistry.isUsingOAuth).mockReturnValue(true);
    expect(await beforeProviderRequest(h, payload)).toBeUndefined();
    expect(readRawConfig(configPaths(cwd).project).serviceTier).toBe("ultrafast");
    await h.commands.get("openai-tier")!.handler("ultrafast", h.ctx);
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("inactive"),
      "warning",
    );
    await h.commands.get("openai-tier")!.handler("fast", h.ctx);
    expect(await beforeProviderRequest(h, payload)).toMatchObject({ service_tier: "priority" });
    await h.commands.get("openai-tier")!.handler("standard", h.ctx);
    expect(await beforeProviderRequest(h, payload)).toMatchObject({ service_tier: "default" });

    vi.mocked(h.ctx.modelRegistry.isUsingOAuth).mockReturnValue(false);
    await h.commands.get("openai-tier")!.handler("ultrafast", h.ctx);
    expect(await beforeProviderRequest(h, payload)).toMatchObject({ service_tier: "ultrafast" });
  });

  test("selects and persists Ultrafast, discloses cost, and explicitly restores Standard", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, { unknown: "keep", serviceTier: "standard" });
    const h = createHarness(cwd, createModel("openai", "gpt-6-astra"));
    await emit(h, "session_start");
    await h.commands.get("openai-tier")!.handler("ultrafast", h.ctx);
    const payload = { model: "gpt-6-astra", service_tier: "priority", input: [] };
    expect(await beforeProviderRequest(h, payload)).toEqual({
      ...payload,
      service_tier: "ultrafast",
    });
    expect(payload.service_tier).toBe("priority");
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("6x Standard"), "warning");
    expect(readRawConfig(configPaths(cwd).project)).toMatchObject({
      serviceTier: "ultrafast",
      unknown: "keep",
    });
    const resumed = createHarness(cwd, h.ctx.model);
    await emit(resumed, "session_start");
    expect(await beforeProviderRequest(resumed, payload)).toMatchObject({
      service_tier: "ultrafast",
    });
    await h.commands.get("openai-tier")!.handler("standard", h.ctx);
    expect(await beforeProviderRequest(h, payload)).toMatchObject({ service_tier: "default" });
    expect(readRawConfig(configPaths(cwd).project)).toMatchObject({
      serviceTier: "standard",
      desiredActive: false,
    });
  });

  test.each([
    { provider: "openai-codex", id: "gpt-6-astra" },
    { provider: "openai", id: "gpt-6.1-sol" },
    { provider: "openai", id: "gpt-6-astra", baseUrl: "https://eu.api.openai.com/v1" },
    { provider: "openai", id: "gpt-6-astra", baseUrl: "https://proxy.example/v1" },
    { provider: "openai", id: "gpt-6-astra", baseUrl: "http://api.openai.com/v1" },
    { provider: "openai", id: "gpt-6-astra", api: "openai-completions" },
  ])(
    "does not inject an unverified Ultrafast tier or silently downgrade: %j",
    async (overrides) => {
      const cwd = createTempProject();
      writeProjectConfig(cwd, {
        serviceTier: "ultrafast",
        supportedModels: ["openai/gpt-6-astra", "openai-codex/gpt-6-astra", "openai/gpt-6.1-sol"],
      });
      const model = {
        ...createModel(overrides.provider, overrides.id)!,
        ...overrides,
      } as NonNullable<ExtensionContext["model"]>;
      const h = createHarness(cwd, model);
      await emit(h, "session_start");
      expect(await beforeProviderRequest(h, { model: model.id })).toBeUndefined();
      expect(readRawConfig(configPaths(cwd).project).serviceTier).toBe("ultrafast");
    },
  );

  test("rechecks capability on model switches and never injects into a different payload model", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, { serviceTier: "ultrafast" });
    const h = createHarness(cwd, createModel("openai", "gpt-6-astra"));
    await emit(h, "session_start");
    expect(await beforeProviderRequest(h, { model: "gpt-6.1-sol" })).toBeUndefined();
    h.ctx.model = createModel("openai-codex", "gpt-6-astra");
    await emit(h, "model_select", { model: h.ctx.model });
    expect(await beforeProviderRequest(h, { model: "gpt-6-astra" })).toBeUndefined();
    h.ctx.model = {
      ...createModel("openai", "gpt-6-astra")!,
      baseUrl: "https://us.api.openai.com/v1/",
    };
    await emit(h, "model_select", { model: h.ctx.model });
    expect(await beforeProviderRequest(h, { model: "gpt-6-astra" })).toMatchObject({
      service_tier: "ultrafast",
    });
  });

  test("persists a Fast flag override even when both old and new tiers are active", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, {
      serviceTier: "ultrafast",
      active: true,
      desiredActive: true,
      supportedModels: undefined,
    });
    const h = createHarness(cwd, createModel("openai", "gpt-6-astra"));
    vi.mocked(h.pi.getFlag).mockReturnValue(true);
    await emit(h, "session_start");
    expect(await beforeProviderRequest(h, { model: "gpt-6-astra" })).toMatchObject({
      service_tier: "priority",
    });
    expect(readRawConfig(configPaths(cwd).project).serviceTier).toBe("fast");
  });

  test("nonpersistent selection stays session-only and the Fast flag never selects Ultrafast", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, {
      persistState: false,
      serviceTier: "ultrafast",
      supportedModels: undefined,
    });
    const h = createHarness(cwd, createModel("openai", "gpt-6-astra"));
    await emit(h, "session_start");
    expect(await beforeProviderRequest(h, { model: "gpt-6-astra" })).toBeUndefined();
    await h.commands.get("openai-tier")!.handler("fast", h.ctx);
    expect(await beforeProviderRequest(h, { model: "gpt-6-astra" })).toMatchObject({
      service_tier: "priority",
    });
    expect(readRawConfig(configPaths(cwd).project).serviceTier).toBe("ultrafast");
    const flagged = createHarness(cwd, h.ctx.model);
    vi.mocked(flagged.pi.getFlag).mockReturnValue(true);
    await emit(flagged, "session_start");
    expect(await beforeProviderRequest(flagged, { model: "gpt-6-astra" })).toMatchObject({
      service_tier: "priority",
    });
  });

  test("/fast disables Ultrafast, then enables only Fast; invalid tiers do not change state", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, { serviceTier: "ultrafast", supportedModels: undefined });
    const h = createHarness(cwd, createModel("openai", "gpt-6-astra"));
    await emit(h, "session_start");
    await h.commands.get("fast")!.handler("", h.ctx);
    expect(await beforeProviderRequest(h, { model: "gpt-6-astra" })).toMatchObject({
      service_tier: "default",
    });
    await h.commands.get("fast")!.handler("", h.ctx);
    await h.commands.get("openai-tier")!.handler("turbo", h.ctx);
    expect(await beforeProviderRequest(h, { model: "gpt-6-astra" })).toMatchObject({
      service_tier: "priority",
    });
  });
});

describe("fast mode provider injection", () => {
  test("injects priority service tier when persisted fast mode is active for a supported model", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, {
      active: true,
      desiredActive: true,
      supportedModels: ["openai/gpt-5.5"],
    });
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const payload = { model: "gpt-5.5", messages: [] };
    const result = await beforeProviderRequest(harness, payload);

    expect(result).toEqual({ model: "gpt-5.5", messages: [], service_tier: "priority" });
    expect(payload).toEqual({ model: "gpt-5.5", messages: [] });
  });

  test("does not inject for unsupported models and leaves the payload unchanged", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, {
      active: true,
      desiredActive: true,
      supportedModels: ["openai/gpt-5.5"],
    });
    const harness = createHarness(cwd, createModel("openai", "gpt-4.1"));

    await emit(harness, "session_start");
    const payload = { model: "gpt-4.1" };

    await expect(beforeProviderRequest(harness, payload)).resolves.toBeUndefined();
    expect(payload).toEqual({ model: "gpt-4.1" });
  });

  test("does not warn on session start when desired fast mode is inactive for an unsupported model", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, {
      active: false,
      desiredActive: true,
      supportedModels: ["openai/gpt-5.5"],
    });
    const harness = createHarness(cwd, createModel("runinfra", "glm-5-3-flash"));

    await emit(harness, "session_start");

    expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
  });

  test("does not inject when fast mode is disabled and leaves the payload unchanged", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, {
      active: false,
      desiredActive: false,
      supportedModels: ["openai/gpt-5.5"],
    });
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const payload = { model: "gpt-5.5" };

    await expect(beforeProviderRequest(harness, payload)).resolves.toBeUndefined();
    expect(payload).toEqual({ model: "gpt-5.5" });
  });

  test("/fast toggles injection on for the current supported model", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, {
      active: false,
      desiredActive: false,
      supportedModels: ["openai/gpt-5.5"],
    });
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    await harness.commands.get("fast")?.handler("", harness.ctx);

    await expect(beforeProviderRequest(harness, { model: "gpt-5.5" })).resolves.toMatchObject({
      service_tier: "priority",
    });
  });

  test("model selection notifies by default when fast mode turns off", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, {
      active: true,
      desiredActive: true,
      supportedModels: ["openai/gpt-5.5"],
    });
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    harness.ctx.model = createModel("openai", "gpt-4.1");
    await emit(harness, "model_select", { model: harness.ctx.model });

    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Fast mode inactive"),
      "warning",
    );
  });

  test("notifyOnModelSwitch=false keeps model switches quiet while still toggling injection", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, {
      active: true,
      desiredActive: true,
      notifyOnModelSwitch: false,
      supportedModels: ["openai/gpt-5.5"],
    });
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    vi.mocked(harness.ctx.ui.notify).mockClear();
    harness.ctx.model = createModel("openai", "gpt-4.1");
    await emit(harness, "model_select", { model: harness.ctx.model });
    await expect(beforeProviderRequest(harness, { model: "gpt-4.1" })).resolves.toBeUndefined();

    harness.ctx.model = createModel("openai", "gpt-5.5");
    await emit(harness, "model_select", { model: harness.ctx.model });
    await expect(beforeProviderRequest(harness, { model: "gpt-5.5" })).resolves.toMatchObject({
      service_tier: "priority",
    });

    expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
  });

  test("model selection deactivates injection for unsupported models and reactivates for supported models", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, {
      active: true,
      desiredActive: true,
      supportedModels: ["openai/gpt-5.5"],
    });
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    await expect(beforeProviderRequest(harness, { model: "gpt-5.5" })).resolves.toMatchObject({
      service_tier: "priority",
    });

    harness.ctx.model = createModel("openai", "gpt-4.1");
    await emit(harness, "model_select", { model: harness.ctx.model });
    const unsupportedPayload = { model: "gpt-4.1" };
    await expect(beforeProviderRequest(harness, unsupportedPayload)).resolves.toBeUndefined();
    expect(unsupportedPayload).toEqual({ model: "gpt-4.1" });

    harness.ctx.model = createModel("openai", "gpt-5.5");
    await emit(harness, "model_select", { model: harness.ctx.model });
    await expect(beforeProviderRequest(harness, { model: "gpt-5.5" })).resolves.toMatchObject({
      service_tier: "priority",
    });
  });
});
