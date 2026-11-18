import { createModels, InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import {
  OPENAI_GPT_62_MODELS,
  OPENAI_MODEL_FALLBACKS,
  withOpenAIModels,
} from "../src/openai-models.ts";
import {
  OPENAI_DECISIONS_MODEL,
  registerOpenAIDecisionsProvider,
} from "../src/openai-decisions.ts";
import { CODEX_MODEL_FALLBACKS, createOpenAICodexProvider } from "../src/codex-models.ts";

const native = () => builtinProviders().find((provider) => provider.id === "openai")!;

describe("GPT-6.2 Astra and Sol", () => {
  test.each([
    {
      id: "gpt-6.2-astra",
      name: "GPT-6.2 Astra",
      input: 8,
      output: 40,
      cacheRead: 0.4,
      cacheWrite: 10,
    },
    {
      id: "gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    },
  ])("uses published metadata for $id", ({ id, name, input, output, cacheRead, cacheWrite }) => {
    const model = OPENAI_GPT_62_MODELS.find((candidate) => candidate.id === id)!;
    expect(model).toMatchObject({
      id,
      name,
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1050000,
      maxTokens: 128000,
      thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh", max: "max" },
      cost: {
        input,
        output,
        cacheRead,
        cacheWrite,
        tiers: [
          {
            inputTokensAbove: 272000,
            input: input * 2,
            output: output * 1.5,
            cacheRead: cacheRead * 2,
            cacheWrite: cacheWrite * 2,
          },
        ],
      },
      compat: {
        supportsStrictMode: true,
        supportsOpenAIGrammarTools: true,
        supportsAdditionalTools: true,
        supportsToolSearch: true,
      },
    });
    expect(CODEX_MODEL_FALLBACKS.find((candidate) => candidate.id === id)).toMatchObject({
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 272000,
      maxTokens: model.maxTokens,
      cost: model.cost,
      thinkingLevelMap: model.thinkingLevelMap,
    });
  });

  test.each(OPENAI_GPT_62_MODELS)("preserves native metadata and capabilities for $id", (model) => {
    const base = native();
    let chat = base
      .getModels()
      .filter((candidate) => !OPENAI_GPT_62_MODELS.some((m) => m.id === candidate.id));
    let all = base.getAllModels!().filter(
      (candidate) => !OPENAI_GPT_62_MODELS.some((m) => m.id === candidate.id),
    );
    const provider = withOpenAIModels({ ...base, getModels: () => chat, getAllModels: () => all });
    expect(provider.getModels().filter((candidate) => candidate.id === model.id)).toEqual([model]);
    expect(provider.getAllModels!().filter((candidate) => candidate.id === model.id)).toEqual([
      model,
    ]);
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
    const official = { ...model, name: "Refreshed official metadata", contextWindow: 1200000 };
    chat = [...chat, official];
    all = [...all, official];
    expect(provider.getModels().filter((candidate) => candidate.id === model.id)).toEqual([
      official,
    ]);
    expect(provider.getAllModels!().filter((candidate) => candidate.id === model.id)).toEqual([
      official,
    ]);
    const classifier = { ...OPENAI_DECISIONS_MODEL, id: model.id };
    expect(withOpenAIModels({ ...base, getAllModels: () => [classifier] }).getAllModels!()).toEqual(
      [classifier, ...OPENAI_MODEL_FALLBACKS],
    );
  });

  test.each(["api_key", "oauth"] as const)(
    "registers both models without changing %s auth",
    async (type) => {
      const credentials = new InMemoryCredentialStore();
      const credential =
        type === "api_key"
          ? { type, key: "synthetic-key" }
          : {
              type,
              access: "synthetic-access",
              refresh: "synthetic-refresh",
              expires: Date.now() + 60000,
            };
      await credentials.modify("openai", async () => credential);
      const registry = createModels({ credentials });
      registerOpenAIDecisionsProvider({
        registerProvider: (provider: Provider) => registry.setProvider(provider),
      } as unknown as ExtensionAPI);
      for (const model of OPENAI_GPT_62_MODELS) {
        expect(
          (await registry.getAvailableOfType("chat", "openai")).filter(
            (candidate) => candidate.id === model.id,
          ),
        ).toHaveLength(1);
      }
      expect(await credentials.read("openai")).toEqual(credential);
      expect(registry.getModelOfType("classifier", "openai-decisions", "gpt-6-luna")).toBeDefined();
    },
  );

  test.each(OPENAI_GPT_62_MODELS)(
    "retains $id offline and accepts live Codex metadata",
    async (model) => {
      const fallback = CODEX_MODEL_FALLBACKS.find((candidate) => candidate.id === model.id)!;
      const official =
        builtinProviders()
          .find((provider) => provider.id === "openai-codex")!
          .getModels()
          .find((candidate) => candidate.id === model.id) ?? fallback;
      const live = { ...fallback, name: "Live metadata", contextWindow: 500000 };
      for (const response of [new Response(null, { status: 404 }), Response.json([live])]) {
        const provider = createOpenAICodexProvider({ fetch: vi.fn(async () => response) });
        expect(provider.getModels().filter((candidate) => candidate.id === model.id)).toEqual([
          official,
        ]);
        await provider.refreshModels?.({
          allowNetwork: true,
          force: true,
          signal: new AbortController().signal,
          publish: async (publication) => {
            publication.update?.();
            return true;
          },
        });
        expect(provider.getModels().filter((candidate) => candidate.id === model.id)).toEqual([
          response.status === 404 ? official : live,
        ]);
      }
    },
  );
});
