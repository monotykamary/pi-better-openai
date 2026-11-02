import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionUIContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import betterOpenAI from "../index.ts";
import { configPaths, readRawConfig, writeConfig } from "../src/config.ts";
import { registerOptionalTool } from "../src/optional-tool.ts";

const features = {
  image: "openai_image",
  websearch: "openai_websearch",
  decisions: "openai_decide",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("optional registration is hidden-first, immutable, and only changes on transitions", () => {
  const registerTool = vi.fn();
  const definition: ToolDefinition = {
    name: "optional",
    label: "Optional",
    description: "Optional tool",
    promptSnippet: "Optional snippet",
    promptGuidelines: ["Optional guideline"],
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
  };
  const tool = registerOptionalTool({ registerTool } as unknown as ExtensionAPI, definition);
  const hidden = registerTool.mock.calls[0]![0];
  expect(hidden).toEqual({ ...definition, exposure: "hidden" });
  tool.setEnabled(false);
  expect(registerTool).toHaveBeenCalledTimes(1);
  tool.setEnabled(true);
  expect(registerTool).toHaveBeenLastCalledWith({ ...definition, exposure: "direct" });
  tool.setEnabled(true);
  expect(registerTool).toHaveBeenCalledTimes(2);
  tool.setEnabled(false);
  expect(registerTool).toHaveBeenCalledTimes(3);
  expect(registerTool).toHaveBeenLastCalledWith({ ...definition, exposure: "hidden" });
  expect(hidden.exposure).toBe("hidden");
  expect(definition.exposure).toBeUndefined();
});

test("real Pi hides disabled tools and guidance, and settings restore and withdraw them live", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-exposure-"));
  const agentDir = join(cwd, "agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("CODEX_HOME", join(cwd, "codex"));
  vi.stubEnv("PI_OFFLINE", "1");
  const fetch = vi.fn(() => {
    throw new Error("Network forbidden in exposure test");
  });
  vi.stubGlobal("fetch", fetch);
  const configPath = configPaths(cwd).project;
  const baseConfig = {
    usage: { enabled: false },
    pets: { enabled: false },
    footer: { mode: "off" },
  };
  writeConfig(configPath, {
    ...baseConfig,
    unknown: "keep",
    ...Object.fromEntries(
      Object.keys(features).map((feature) => [feature, { enabled: false, unknown: "keep" }]),
    ),
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  let api: ExtensionAPI | undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        api = pi;
        betterOpenAI(pi);
      },
    ],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-cache"),
      allowModelNetwork: false,
    });
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      modelRuntime,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
    }));
    const current = session;
    const errors: unknown[] = [];
    current.extensionRunner!.onError((error) => errors.push(error));
    const assertExposure = (name: string, enabled: boolean, declared = enabled) => {
      const definition = current.getToolDefinition(name)!;
      expect(definition.exposure).toBe(enabled ? "direct" : "hidden");
      expect(current.getActiveToolNames().includes(name)).toBe(enabled);
      expect(current.getCallableToolNames().includes(name)).toBe(enabled);
      for (const guideline of definition.promptGuidelines ?? []) {
        expect(current.systemPrompt.includes(guideline)).toBe(declared);
      }
    };
    // No config has been read in a session yet: factory registration must be safe.
    for (const name of Object.values(features)) assertExposure(name, false);
    await current.bindExtensions({});
    for (const name of Object.values(features)) assertExposure(name, false);
    const unrelated = current.getActiveToolNames();

    initTheme("dark", false);
    for (const [feature, name] of Object.entries(features)) {
      let opened = false;
      const ui = current.extensionRunner!.createContext().ui;
      const custom: ExtensionUIContext["custom"] = async (factory) => {
        opened = true;
        const component = await factory(
          { requestRender: vi.fn() } as unknown as Parameters<typeof factory>[0],
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          } as Parameters<typeof factory>[1],
          undefined as unknown as Parameters<typeof factory>[2],
          vi.fn(),
        );
        for (const char of feature) component.handleInput?.(char);
        component.handleInput?.("\r"); // Enter the matching settings section.
        component.handleInput?.("\r"); // Enable its first setting.
        assertExposure(name, true);
        expect(readRawConfig(configPath)[feature]).toMatchObject({
          enabled: true,
          unknown: "keep",
        });
        for (const other of Object.values(features).filter((value) => value !== name))
          assertExposure(other, false);
        component.handleInput?.("\r"); // Disable again without restarting Pi.
        assertExposure(name, false);
        expect(readRawConfig(configPath)[feature]).toMatchObject({
          enabled: false,
          unknown: "keep",
        });
        return undefined as never;
      };
      current.extensionRunner!.setUIContext({ ...ui, custom }, "tui");
      await current.prompt("/openai-settings");
      expect(errors).toEqual([]);
      expect(opened).toBe(true);
    }
    current.extensionRunner!.setUIContext(undefined, "print");
    expect(current.getActiveToolNames()).toEqual(unrelated);
    expect(readRawConfig(configPath).unknown).toBe("keep");

    // Apply default feature flags through the same refresh used by settings.
    writeConfig(configPath, baseConfig);
    await current.prompt("/openai-tier standard");
    assertExposure(features.image, true);
    assertExposure(features.websearch, true);
    assertExposure(features.decisions, false);
    for (const name of [features.image, features.websearch]) {
      expect(current.systemPrompt).toContain(current.getToolDefinition(name)!.promptSnippet);
    }
    // Unchanged config must not re-register/reactivate tools a user deselected.
    current.setActiveToolsByName(
      current.getActiveToolNames().filter((name) => name !== features.image),
    );
    await current.prompt("/openai-tier standard");
    expect(current.getActiveToolNames()).not.toContain(features.image);
    expect(current.getActiveToolNames()).toContain(features.websearch);

    // Declaration hiding keeps tools callable, but Pi 1.1 omits their prompt rules.
    // An orchestrator owns redisclosing those rules via getPromptGuidelines.
    let proxyGuidelines: string[] = [];
    api!.registerTool({
      name: "proxy_probe",
      label: "Proxy probe",
      description: "Offline loadout probe",
      parameters: Type.Object({}),
      prepareLoadout: (loadout) => {
        proxyGuidelines = loadout.callable.flatMap((tool) =>
          loadout.getPromptGuidelines(tool.name),
        );
        return {
          descriptions: { proxy_probe: `Offline loadout probe\n${proxyGuidelines.join("\n")}` },
          hiddenDeclarations: loadout.registered
            .map((tool) => tool.name)
            .filter((name) => name !== "proxy_probe"),
        };
      },
      execute: async () => ({ content: [], details: undefined }),
    });
    assertExposure(features.websearch, true, false);
    for (const rule of current.getToolDefinition(features.websearch)!.promptGuidelines ?? []) {
      expect(proxyGuidelines).toContain(rule);
    }
    writeConfig(configPath, {
      ...baseConfig,
      image: { enabled: false },
      websearch: { enabled: false },
    });
    await current.prompt("/openai-tier standard");
    for (const name of Object.values(features)) assertExposure(name, false);
    for (const name of [features.image, features.websearch]) {
      expect(current.systemPrompt).not.toContain(current.getToolDefinition(name)!.promptSnippet);
    }
    expect(errors).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    if (session) {
      await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    loader.getExtensions().runtime.invalidate("Exposure test complete");
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
