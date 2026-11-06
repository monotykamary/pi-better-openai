import type { Model, Provider } from "@earendil-works/pi-ai";

// https://developers.openai.com/api/docs/models/gpt-6.1-terra
export const OPENAI_TERRA_MODEL: Model<"openai-responses"> = {
  id: "gpt-6.1-terra",
  name: "GPT-6.1 Terra",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  thinkingLevelMap: { off: "none", minimal: "low", xhigh: "xhigh", max: "max" },
  input: ["text", "image"],
  contextWindow: 1050000,
  maxTokens: 128000,
  cost: {
    input: 1,
    output: 5,
    cacheRead: 0.05,
    cacheWrite: 1.25,
    tiers: [{ inputTokensAbove: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }],
  },
  compat: {
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
    supportsMidConvoSystemMessages: true,
  },
};

// https://developers.openai.com/api/docs/models/gpt-6-cyber
// Requires organization approval through Daybreak Red; registration grants no access.
export const OPENAI_CYBER_MODEL: Model<"openai-responses"> = {
  id: "gpt-6-cyber",
  name: "GPT-6 Cyber",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  // Keep extended efforts disabled until documented; native catalog metadata wins.
  thinkingLevelMap: { off: null, minimal: "low", xhigh: null, max: null },
  input: ["text", "image"],
  contextWindow: 1050000,
  maxTokens: 128000,
  // Published standard short-context rates, including 30-minute cache writes.
  cost: { input: 20, output: 100, cacheRead: 2, cacheWrite: 25 },
  compat: {
    supportsStrictMode: true,
    supportsToolSearch: true,
  },
};

export function withOpenAIModels(builtIn: Provider): Provider {
  const appendMissing = <T extends { id: string; type?: string }>(
    models: readonly T[],
  ): readonly (T | Model<"openai-responses">)[] => {
    const missing = [OPENAI_TERRA_MODEL, OPENAI_CYBER_MODEL].filter(
      (fallback) =>
        !models.some((model) => model.id === fallback.id && (!model.type || model.type === "chat")),
    );
    return missing.length > 0 ? [...models, ...missing] : models;
  };
  // Read the host's current catalog on every call so refreshes remain authoritative.
  // Keep its transport, auth, classifier/image adapters, and filtering untouched.
  return {
    ...builtIn,
    getModels: () => appendMissing(builtIn.getModels()),
    getAllModels: () => appendMissing(builtIn.getAllModels?.() ?? builtIn.getModels()),
  };
}
