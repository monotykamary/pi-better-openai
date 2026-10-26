import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

test("loads through pi's real extension loader and registers the native Codex provider", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-better-openai-load-"));
  const agentDir = join(scratch, "agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  const loader = new DefaultResourceLoader({
    cwd: scratch,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [fileURLToPath(new URL("..", import.meta.url))],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  try {
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    expect([...loaded.extensions[0]!.tools.keys()]).toEqual([
      "openai_image",
      "openai_websearch",
      "openai_decide",
    ]);
    expect([...loaded.extensions[0]!.commands.keys()]).toEqual(
      expect.arrayContaining(["openai-tier", "openai-decisions"]),
    );
    expect(
      loaded.runtime.pendingNativeProviderRegistrations.map(({ provider }) => provider.id),
    ).toEqual(["openai-codex", "openai", "openai-decisions"]);
    const registeredOpenAI = loaded.runtime.pendingNativeProviderRegistrations.find(
      ({ provider }) => provider.id === "openai",
    )!.provider;
    expect(registeredOpenAI.getModels()).toContainEqual(
      expect.objectContaining({ id: "gpt-6.1-terra", api: "openai-responses" }),
    );
    // The loader has its own module cache; function identity is tested in openai-models.test.ts.
    expect(registeredOpenAI.streamSimple).toEqual(expect.any(Function));
    expect(registeredOpenAI.auth?.oauth?.isSubscription).toBe(true);
    expect(loaded.extensions[0]!.commands.has("fast")).toBe(false);
    expect(loaded.extensions[0]!.flags.has("fast")).toBe(false);
    const provider = builtinProviders().find((provider) => provider.id === "openai")!;
    expect(provider.getAllModels?.()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "chat",
          provider: "openai",
          id: "gpt-6-astra",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        }),
        expect.objectContaining({
          type: "chat",
          provider: "openai",
          id: "gpt-6.1-sol",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        }),
        expect.objectContaining({ type: "classifier", id: "gpt-6-luna", api: "openai-decisions" }),
      ]),
    );
  } finally {
    loader.getExtensions().runtime.invalidate("Loader regression test complete");
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
