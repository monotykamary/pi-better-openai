import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import betterOpenAI from "../index.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;

type Harness = {
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
  return { provider, id } as ExtensionContext["model"];
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

  return { ctx, handlers, commands };
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

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
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
