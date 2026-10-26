// OpenAI Decisions compatibility classifier and independent API-key provider.
// Remove the fallback once the minimum supported Pi ships it. See THIRD_PARTY_NOTICES.md.
import { setTimeout as sleep } from "node:timers/promises";
import {
  calculateCost,
  createProvider,
  envApiKeyAuth,
  type ClassifierContext,
  type ClassifierModel,
  type ClassifierOptions,
  type ClassifierResult,
  type ImageContent,
  type Provider,
  type ProviderHeaders,
  type Usage,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./config.ts";
import { withOpenAIModels } from "./openai-models.ts";

export const OPENAI_DECISIONS_API = "openai-decisions";
export const OPENAI_DECISIONS_MODEL: ClassifierModel<typeof OPENAI_DECISIONS_API> = {
  type: "classifier",
  provider: "openai",
  id: "gpt-6-luna",
  name: "GPT-6 Luna (Decisions)",
  api: OPENAI_DECISIONS_API,
  baseUrl: "https://api.openai.com/v1",
  input: ["text", "image"],
  contextWindow: 922000,
  cost: {
    input: 0.1,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tiers: [{ inputTokensAbove: 272000, input: 0.2, output: 0, cacheRead: 0, cacheWrite: 0 }],
  },
};

// Structural compatibility with Pi's upcoming ClassifierContext.images field.
export type OpenAIDecisionsContext = ClassifierContext & { images?: ImageContent[] };

class DecisionsError extends Error {}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DecisionsError(message);
}

function number(value: unknown, field: string, maximum = 1): number {
  requireValue(
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum,
    `OpenAI Decisions returned invalid ${field}.`,
  );
  return value;
}

function wireInput(context: OpenAIDecisionsContext): unknown {
  const state = JSON.stringify(context.state);
  const images = context.images ?? [];
  requireValue(
    Array.isArray(images) && images.length <= 128,
    "Decisions accepts at most 128 images.",
  );
  if (!images.length) return state;
  return [
    {
      role: "user",
      content: [
        { type: "input_text", text: state },
        ...images.map((image) => {
          requireValue(
            isRecord(image) &&
              image.type === "image" &&
              typeof image.mimeType === "string" &&
              /^image\/(png|jpeg|gif|webp)$/.test(image.mimeType) &&
              typeof image.data === "string" &&
              image.data.length > 0 &&
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data),
            "Decisions images must be inline base64 PNG, JPEG, GIF, or WebP blocks.",
          );
          return { type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` };
        }),
      ],
    },
  ];
}

function wireQuestions(context: ClassifierContext): unknown[] {
  return Object.entries(context.questions).map(([name, q]) => {
    if (q.type === "choice")
      return {
        type: "choice",
        name,
        instructions: q.instructions,
        choices: Object.entries(q.criteria).map(([value, description]) =>
          description ? { value, description } : { value },
        ),
      };
    if (q.type === "score")
      return {
        type: "score",
        name,
        instructions: q.instructions,
        levels: q.criteria.map((label) => ({ label })),
      };
    requireValue(q.type === "bool", "Unsupported Decisions question type.");
    const meanings = [
      q.criteria.true && `True means: ${q.criteria.true}`,
      q.criteria.false && `False means: ${q.criteria.false}`,
    ].filter(Boolean);
    return {
      type: "predicate",
      name,
      instructions: meanings.length
        ? `${q.instructions}\n\n${meanings.join("\n")}`
        : q.instructions,
    };
  });
}

function parseAnswers(value: unknown, context: ClassifierContext): ClassifierResult["answers"] {
  requireValue(Array.isArray(value), "OpenAI Decisions returned invalid answers.");
  const byName = new Map<string, Record<string, unknown>>();
  for (const answer of value) {
    requireValue(
      isRecord(answer) && typeof answer.name === "string" && !byName.has(answer.name),
      "OpenAI Decisions returned invalid answer names.",
    );
    byName.set(answer.name, answer);
  }
  requireValue(
    byName.size === Object.keys(context.questions).length,
    "OpenAI Decisions returned incomplete answers.",
  );
  return Object.fromEntries(
    Object.entries(context.questions).map(([id, q]) => {
      const answer = byName.get(id);
      requireValue(answer, "OpenAI Decisions omitted an answer.");
      requireValue(answer.type !== "refusal", "OpenAI Decisions refused a question.");
      if (q.type === "bool") {
        requireValue(
          answer.type === "predicate",
          "OpenAI Decisions returned an invalid predicate.",
        );
        return [id, { type: "bool", probability: number(answer.probability, "probability") }];
      }
      requireValue(answer.type === q.type, "OpenAI Decisions returned an invalid answer type.");
      const confidence = number(answer.confidence, "confidence");
      if (q.type === "score")
        return [
          id,
          {
            type: "score",
            score: number(answer.score, "score", q.criteria.length - 1),
            confidence,
          },
        ];
      requireValue(
        typeof answer.choice === "string" &&
          Object.hasOwn(q.criteria, answer.choice) &&
          Array.isArray(answer.probabilities),
        "OpenAI Decisions returned an invalid choice.",
      );
      const probabilities: Record<string, number> = Object.create(null);
      for (const entry of answer.probabilities) {
        requireValue(
          isRecord(entry) &&
            typeof entry.value === "string" &&
            Object.hasOwn(q.criteria, entry.value) &&
            !Object.hasOwn(probabilities, entry.value),
          "OpenAI Decisions returned invalid choice probabilities.",
        );
        probabilities[entry.value] = number(entry.probability, "probability");
      }
      requireValue(
        Object.keys(probabilities).length === Object.keys(q.criteria).length &&
          Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) <= 0.001,
        "OpenAI Decisions returned incomplete choice probabilities.",
      );
      return [id, { type: "choice", choice: answer.choice, probabilities, confidence }];
    }),
  );
}

function parseUsage(value: unknown, model: ClassifierModel<string>): Usage | undefined {
  if (!isRecord(value) || (value.input_tokens === undefined && value.output_tokens === undefined))
    return undefined;
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
  const input = count(value.input_tokens),
    output = count(value.output_tokens);
  const usage: Usage = {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function headers(...sources: (ProviderHeaders | undefined)[]): Headers {
  const result = new Headers();
  for (const source of sources)
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === null) result.delete(key);
      else if (value !== undefined) result.set(key, value);
    }
  return result;
}

async function post(
  model: ClassifierModel<string>,
  context: OpenAIDecisionsContext,
  options: ClassifierOptions,
): Promise<unknown> {
  requireValue(
    options.apiKey,
    "OpenAI Decisions requires an OpenAI API key, not a ChatGPT subscription.",
  );
  let payload: unknown = {
    model: model.id,
    input: wireInput(context),
    questions: wireQuestions(context),
  };
  const transformed = await options.onPayload?.(payload, model);
  if (transformed !== undefined) payload = transformed;
  const body = JSON.stringify(payload);
  const url = new URL("decisions", `${model.baseUrl.replace(/\/+$/u, "")}/`);
  const requestHeaders = headers(
    { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    model.headers,
    options.headers,
  );
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const timeout =
      options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
    const signal =
      options.signal && timeout
        ? AbortSignal.any([options.signal, timeout])
        : (options.signal ?? timeout);
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(url, {
        method: "POST",
        headers: requestHeaders,
        body,
        signal,
      });
      await options.onResponse?.(
        { status: response.status, headers: Object.fromEntries(response.headers) },
        model,
      );
      if (response.ok) return await response.json();
    } catch {
      throw new DecisionsError(
        timeout?.aborted
          ? "OpenAI Decisions request timed out."
          : "OpenAI Decisions request failed.",
      );
    }
    // Do not surface provider bodies, which can echo credentials or submitted state.
    await response.body?.cancel();
    const hint = response.headers.get("x-should-retry");
    const retryable =
      hint === "true" ||
      (hint !== "false" && ([408, 409, 429].includes(response.status) || response.status >= 500));
    // Like upstream Pi, never retry gateway timeouts caused by very large inputs.
    requireValue(
      response.status !== 504,
      "OpenAI Decisions gateway timeout (504). Reduce the input size.",
    );
    requireValue(
      retryable && attempt < (options.maxRetries ?? 2),
      `OpenAI Decisions HTTP ${response.status}. Check API-key access and request limits.`,
    );
    const afterMs = response.headers.get("retry-after-ms"),
      after = response.headers.get("retry-after");
    let delay =
      afterMs !== null
        ? Number(afterMs)
        : after !== null
          ? Number.isNaN(Number(after))
            ? Date.parse(after) - Date.now()
            : Number(after) * 1000
          : NaN;
    if (!Number.isFinite(delay))
      delay = Math.min(500 * 2 ** attempt, 8000) * (1 - Math.random() * 0.25);
    const cap = options.maxRetryDelayMs ?? 60000;
    requireValue(
      cap <= 0 || delay <= cap,
      "OpenAI Decisions retry delay exceeds the configured limit.",
    );
    await sleep(Math.max(0, delay), undefined, { signal: options.signal });
  }
}

export async function classifyOpenAIDecisions(
  model: ClassifierModel<string>,
  context: OpenAIDecisionsContext,
  options: ClassifierOptions = {},
): Promise<ClassifierResult> {
  const result: ClassifierResult = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: {},
    stopReason: "stop",
    timestamp: Date.now(),
  };
  try {
    requireValue(model.api === OPENAI_DECISIONS_API, "Unsupported OpenAI classifier API.");
    const body = await post(model, context, options);
    requireValue(isRecord(body), "OpenAI Decisions returned an invalid response.");
    result.usage = parseUsage(body.usage, model);
    result.answers = parseAnswers(body.answers, context);
  } catch (error) {
    result.stopReason = options.signal?.aborted ? "aborted" : "error";
    result.errorMessage =
      result.stopReason === "aborted"
        ? "OpenAI Decisions request aborted."
        : error instanceof DecisionsError
          ? error.message
          : "OpenAI Decisions request failed.";
  }
  return result;
}

export function withOpenAIDecisions(builtIn: Provider): Provider {
  const catalog = () => builtIn.getAllModels?.() ?? builtIn.getModels();
  // Never replace a classifier implementation shipped by the host.
  if (
    builtIn.classify &&
    catalog().some((m) => m.type === "classifier" && m.api === OPENAI_DECISIONS_API)
  )
    return builtIn;
  return {
    ...builtIn,
    getAllModels: () => [
      ...catalog().filter((m) => !(m.type === "classifier" && m.id === OPENAI_DECISIONS_MODEL.id)),
      OPENAI_DECISIONS_MODEL,
    ],
    filterAllModels: (models, credential) => {
      const available =
        builtIn.filterAllModels?.(models, credential) ??
        models.filter(
          (m) =>
            m.type === "classifier" ||
            m.type === "image" ||
            !builtIn.filterModels ||
            builtIn.filterModels([m], credential).length > 0,
        );
      return credential?.type === "oauth"
        ? available.filter((m) => m.api !== OPENAI_DECISIONS_API)
        : available;
    },
    classify: (model, context, options) =>
      model.api === OPENAI_DECISIONS_API
        ? classifyOpenAIDecisions(model, context, options)
        : builtIn.classify
          ? builtIn.classify(model, context, options)
          : Promise.resolve({
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: Date.now(),
              answers: {},
              stopReason: "error",
              errorMessage: "Unsupported classifier API.",
            }),
  };
}

// Keep API-billed classification separate from the host's subscription chat credential.
export function createOpenAIDecisionsProvider(builtIn: Provider): Provider {
  const native = withOpenAIDecisions(builtIn);
  const model =
    native
      .getAllModels?.()
      .find(
        (m): m is ClassifierModel<string> =>
          m.type === "classifier" &&
          m.api === OPENAI_DECISIONS_API &&
          m.id === OPENAI_DECISIONS_MODEL.id,
      ) ?? OPENAI_DECISIONS_MODEL;
  return createProvider({
    id: "openai-decisions",
    name: "OpenAI Decisions (API key only)",
    baseUrl: model.baseUrl,
    auth: {
      apiKey: envApiKeyAuth("OpenAI Decisions API key", [
        "OPENAI_DECISIONS_API_KEY",
        "OPENAI_API_KEY",
      ]),
    },
    models: [{ ...model, provider: "openai-decisions" }],
    filterAllModels: (models, credential) => (credential?.type === "oauth" ? [] : models),
    classifiers: {
      [OPENAI_DECISIONS_API]: {
        classify: (model, context, options) => native.classify!(model, context, options),
      },
    },
  });
}

export function registerOpenAIDecisionsProvider(pi: ExtensionAPI): void {
  const builtIn = builtinProviders().find((provider) => provider.id === "openai");
  if (!builtIn) return;
  const provider = withOpenAIModels(withOpenAIDecisions(builtIn));
  pi.registerProvider(provider);
  pi.registerProvider(createOpenAIDecisionsProvider(provider));
}
