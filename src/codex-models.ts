import {
  createProvider,
  type Model,
  type Provider,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEX_API = "openai-codex-responses" as const;
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_CATALOG_URL = "https://pi.dev/api/models/providers/openai-codex";
const CODEX_PROVIDER_ID = "openai-codex";
const CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

type CodexModel = Model<typeof CODEX_API>;

type CreateCodexProviderOptions = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

const CODEX_COMPAT = {
  supportsOpenAIGrammarTools: true,
  supportsAdditionalTools: true,
  supportsToolSearch: true,
} as const;

export const CODEX_MODEL_FALLBACKS: CodexModel[] = [
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    api: CODEX_API,
    provider: CODEX_PROVIDER_ID,
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: {
      minimal: "low",
      xhigh: "xhigh",
      max: "max",
    },
    input: ["text", "image"],
    contextWindow: 272000,
    maxTokens: 128000,
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
    compat: CODEX_COMPAT,
  },
  {
    id: "gpt-daybreak-blue-latest",
    name: "Daybreak Blue",
    api: CODEX_API,
    provider: CODEX_PROVIDER_ID,
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: {
      minimal: "low",
      xhigh: "xhigh",
      max: "max",
    },
    input: ["text", "image"],
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
    compat: CODEX_COMPAT,
  },
  {
    id: "gpt-daybreak-red-latest",
    name: "Daybreak Red",
    api: CODEX_API,
    provider: CODEX_PROVIDER_ID,
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: {
      minimal: "low",
      xhigh: "xhigh",
      max: "max",
    },
    input: ["text", "image"],
    contextWindow: 372000,
    maxTokens: 128000,
    cost: {
      input: 12.5,
      output: 75,
      cacheRead: 1.25,
      cacheWrite: 15.625,
    },
    compat: CODEX_COMPAT,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogEntries(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value.models)) return value.models;
  return Object.values(value);
}

export function parseCodexCatalog(value: unknown): CodexModel[] {
  const entries = catalogEntries(value);
  if (!entries) throw new Error("Invalid openai-codex model catalog");

  return entries
    .filter((entry): entry is Record<string, unknown> => {
      return isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0;
    })
    .map((entry) => ({ ...entry, provider: CODEX_PROVIDER_ID }) as CodexModel);
}

export function appendMissingCodexModels(
  models: readonly CodexModel[],
  fallbacks: readonly CodexModel[] = CODEX_MODEL_FALLBACKS,
): CodexModel[] {
  const merged = [...models];
  const modelIds = new Set(merged.map((model) => model.id));
  for (const model of fallbacks) {
    if (modelIds.has(model.id)) continue;
    merged.push(model);
    modelIds.add(model.id);
  }
  return merged;
}

function storedCodexModels(context: RefreshModelsContext): CodexModel[] {
  return (context.stored?.models ?? []).filter(
    (model): model is CodexModel => model.provider === CODEX_PROVIDER_ID && model.api === CODEX_API,
  );
}

async function fetchCodexModels(
  context: RefreshModelsContext,
  options: CreateCodexProviderOptions,
): Promise<readonly CodexModel[]> {
  const cached = storedCodexModels(context);
  const checkedAt = context.stored?.checkedAt;
  const now = options.now?.() ?? Date.now();
  if (!context.force && checkedAt !== undefined && now - checkedAt < CATALOG_REFRESH_INTERVAL_MS) {
    return cached;
  }

  const response = await (options.fetch ?? globalThis.fetch)(CODEX_CATALOG_URL, {
    headers: { accept: "application/json" },
    signal: context.signal,
  });
  if (response.status === 404 || response.status === 501) return cached;
  if (!response.ok) {
    throw new Error(`OpenAI Codex model catalog request failed: ${response.status}`);
  }
  return parseCodexCatalog(await response.json());
}

export function createOpenAICodexProvider(
  options: CreateCodexProviderOptions = {},
): Provider<typeof CODEX_API> {
  const builtIn = openaiCodexProvider();
  return createProvider({
    id: builtIn.id,
    name: builtIn.name,
    baseUrl: builtIn.baseUrl,
    headers: builtIn.headers,
    auth: builtIn.auth,
    models: appendMissingCodexModels(builtIn.getModels()),
    fetchModels: (context) => fetchCodexModels(context, options),
    filterModels: builtIn.filterModels,
    api: openAICodexResponsesApi(),
  });
}

export function registerOpenAICodexModels(pi: ExtensionAPI): void {
  pi.registerProvider(createOpenAICodexProvider());
}
