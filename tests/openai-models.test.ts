import { createModels, InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { OPENAI_TERRA_MODEL, withOpenAIModels } from "../src/openai-models.ts";
import { registerOpenAIDecisionsProvider } from "../src/openai-decisions.ts";
import { CODEX_MODEL_FALLBACKS, createOpenAICodexProvider } from "../src/codex-models.ts";

const native = () => builtinProviders().find((provider) => provider.id === "openai")!;

describe("GPT-6.1 Terra", () => {
  test("uses published Responses metadata and conservative Codex context", () => {
    expect(OPENAI_TERRA_MODEL).toMatchObject({
      id: "gpt-6.1-terra",
      provider: "openai",
      api: "openai-responses",
      contextWindow: 1050000,
      maxTokens: 128000,
      input: ["text", "image"],
      thinkingLevelMap: { off: "none", minimal: "low", xhigh: "xhigh", max: "max" },
      cost: {
        input: 1,
        output: 5,
        cacheRead: 0.05,
        cacheWrite: 1.25,
        tiers: [
          { inputTokensAbove: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 },
        ],
      },
    });
    expect(CODEX_MODEL_FALLBACKS.find((model) => model.id === OPENAI_TERRA_MODEL.id)).toMatchObject(
      {
        api: "openai-codex-responses",
        provider: "openai-codex",
        contextWindow: 272000,
        baseUrl: "https://chatgpt.com/backend-api",
        cost: OPENAI_TERRA_MODEL.cost,
      },
    );
  });

  test("preserves native capabilities and lets a refreshed host catalog win", () => {
    const base = native();
    let chat = base.getModels().filter((model) => model.id !== OPENAI_TERRA_MODEL.id);
    let all = base.getAllModels!().filter((model) => model.id !== OPENAI_TERRA_MODEL.id);
    const provider = withOpenAIModels({ ...base, getModels: () => chat, getAllModels: () => all });
    expect(provider.getModels()).toEqual([...chat, OPENAI_TERRA_MODEL]);
    expect(provider.getAllModels!()).toEqual([...all, OPENAI_TERRA_MODEL]);
    for (const key of [
      "auth",
      "stream",
      "streamSimple",
      "classify",
      "generateImages",
      "filterModels",
      "filterAllModels",
      "refreshModels",
    ] as const) {
      expect(provider[key]).toBe(base[key]);
    }
    const official = { ...OPENAI_TERRA_MODEL, name: "Official Terra", contextWindow: 1200000 };
    chat = [...chat, official];
    all = [...all, official];
    expect(provider.getModels().filter((model) => model.id === official.id)).toEqual([official]);
    expect(provider.getAllModels!().filter((model) => model.id === official.id)).toEqual([
      official,
    ]);
  });

  test("does not confuse a same-ID classifier with a chat model", () => {
    const base = native();
    const classifier = { ...OPENAI_TERRA_MODEL, type: "classifier" as const };
    const provider = withOpenAIModels({ ...base, getAllModels: () => [classifier] });
    expect(provider.getAllModels!()).toEqual([classifier, OPENAI_TERRA_MODEL]);
  });

  test("registers Terra alongside Decisions and makes it available with subscription auth", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai", async () => ({
      type: "oauth",
      access: "synthetic-subscription-token",
      refresh: "synthetic-refresh",
      expires: Date.now() + 60000,
    }));
    const registry = createModels({ credentials });
    const registerProvider = vi.fn((provider: Provider) => registry.setProvider(provider));
    registerOpenAIDecisionsProvider({ registerProvider } as unknown as ExtensionAPI);
    expect(registerProvider).toHaveBeenCalledTimes(2);
    expect(
      (await registry.getAvailableOfType("chat", "openai")).find(
        (model) => model.id === OPENAI_TERRA_MODEL.id,
      ),
    ).toEqual(OPENAI_TERRA_MODEL);
    expect(await registry.getAvailableOfType("classifier", "openai")).toEqual([]);
    expect(registry.getModelOfType("classifier", "openai-decisions", "gpt-6-luna")).toBeDefined();
    expect((await credentials.read("openai"))?.type).toBe("oauth");
  });

  test("keeps the Codex fallback offline and accepts authoritative live Terra metadata", async () => {
    const fallback = CODEX_MODEL_FALLBACKS.find((model) => model.id === OPENAI_TERRA_MODEL.id)!;
    const live = { ...fallback, name: "Live Terra", contextWindow: 500000 };
    for (const response of [new Response(null, { status: 404 }), Response.json([live])]) {
      const provider = createOpenAICodexProvider({ fetch: vi.fn(async () => response) });
      expect(provider.getModels()).toContainEqual(fallback);
      await provider.refreshModels?.({
        allowNetwork: true,
        force: true,
        signal: new AbortController().signal,
        publish: async (publication) => {
          publication.update?.();
          return true;
        },
      });
      expect(provider.getModels().filter((model) => model.id === fallback.id)).toEqual([
        response.status === 404 ? fallback : live,
      ]);
    }
  });
});
