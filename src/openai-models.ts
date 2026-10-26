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

export function withOpenAIModels(builtIn: Provider): Provider {
  const appendTerra = <T extends { id: string; type?: string }>(
    models: readonly T[],
  ): readonly (T | typeof OPENAI_TERRA_MODEL)[] =>
    models.some(
      (model) => model.id === OPENAI_TERRA_MODEL.id && (!model.type || model.type === "chat"),
    )
      ? models
      : [...models, OPENAI_TERRA_MODEL];
  // Read the host's current catalog on every call so refreshes remain authoritative.
  // Keep its transport, auth, classifier/image adapters, and filtering untouched.
  return {
    ...builtIn,
    getModels: () => appendTerra(builtIn.getModels()),
    getAllModels: () => appendTerra(builtIn.getAllModels?.() ?? builtIn.getModels()),
  };
}
