import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import {
  CODEX_MODEL_FALLBACKS,
  appendMissingCodexModels,
  createOpenAICodexProvider,
  parseCodexCatalog,
  registerOpenAICodexModels,
} from "../src/codex-models.ts";

function refreshContext(
  publish: (publication: ModelsPublication) => Promise<boolean>,
): RefreshModelsContext {
  return {
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
    publish,
  };
}

describe("OpenAI Codex model registration", () => {
  test("defines Astra and both Daybreak aliases with verified metadata", () => {
    const models = Object.fromEntries(CODEX_MODEL_FALLBACKS.map((model) => [model.id, model]));

    expect(models["gpt-6-astra"]).toMatchObject({
      contextWindow: 272000,
      maxTokens: 128000,
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
        tiers: [
          {
            inputTokensAbove: 272000,
            input: 20,
            output: 75,
            cacheRead: 2,
            cacheWrite: 25,
          },
        ],
      },
    });
    expect(models["gpt-daybreak-blue-latest"]).toMatchObject({
      contextWindow: 272000,
      maxTokens: 128000,
      cost: {
        input: 4,
        output: 20,
        cacheRead: 0.4,
        cacheWrite: 5,
        tiers: [
          {
            inputTokensAbove: 272000,
            input: 8,
            output: 30,
            cacheRead: 0.8,
            cacheWrite: 10,
          },
        ],
      },
    });
    expect(models["gpt-daybreak-red-latest"]).toMatchObject({
      contextWindow: 372000,
      maxTokens: 128000,
      cost: { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 15.625 },
    });
  });

  test("keeps host models and treats extension metadata as fallback", () => {
    const officialAstra = { ...CODEX_MODEL_FALLBACKS[0]!, name: "Official Astra" };
    const models = appendMissingCodexModels([officialAstra]);

    expect(models.filter((model) => model.id === "gpt-6-astra")).toHaveLength(1);
    expect(models.find((model) => model.id === "gpt-6-astra")?.name).toBe("Official Astra");
    expect(models.map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "gpt-daybreak-blue-latest",
      "gpt-daybreak-red-latest",
    ]);
  });

  test("lets the live pi catalog override fallback metadata", async () => {
    const remoteAstra = { ...CODEX_MODEL_FALLBACKS[0]!, name: "Live Astra" };
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ [remoteAstra.id]: remoteAstra }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const provider = createOpenAICodexProvider({ fetch: fetchMock });
    let persisted: ModelsPublication["persist"];

    await provider.refreshModels?.(
      refreshContext(async (publication) => {
        persisted = publication.persist;
        publication.update?.();
        return true;
      }),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(provider.getModels().find((model) => model.id === remoteAstra.id)?.name).toBe(
      "Live Astra",
    );
    expect(provider.getModels().some((model) => model.id === "gpt-5.6-sol")).toBe(true);
    expect(provider.getModels().some((model) => model.id === "gpt-daybreak-red-latest")).toBe(true);
    expect(persisted && "models" in persisted ? persisted.models : []).toHaveLength(1);
  });

  test("normalizes object catalogs to the Codex provider", () => {
    const parsed = parseCodexCatalog({
      model: { ...CODEX_MODEL_FALLBACKS[0], provider: "wrong-provider" },
    });

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.provider).toBe("openai-codex");
  });

  test("registers a native openai-codex provider", () => {
    const registerProvider = vi.fn();
    registerOpenAICodexModels({ registerProvider } as unknown as ExtensionAPI);

    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: "openai-codex", name: "OpenAI Codex" }),
    );
  });
});
