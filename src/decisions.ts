import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isRecord,
  parseModelKey,
  readRawConfig,
  writeConfig,
  type DecisionsConfig,
  type ResolvedConfig,
} from "./config.ts";
import { registerOptionalTool, type OptionalTool } from "./optional-tool.ts";
import { openAIDecisionsArgumentCompletions } from "./command-completions.ts";

export const OPENAI_DECIDE_TOOL = "openai_decide";
export const OPENAI_DECISIONS_COMMAND = "openai-decisions";
export const MAX_DECISION_BYTES = 64 * 1024;
const MAX_QUESTIONS = 32;
const MAX_CRITERIA = 64;
const text = Type.String({ minLength: 1, maxLength: 4096 });
const question = Type.Union([
  Type.Object(
    {
      type: Type.Literal("choice"),
      instructions: text,
      criteria: Type.Record(Type.String(), text, { minProperties: 2, maxProperties: MAX_CRITERIA }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("bool"),
      instructions: text,
      criteria: Type.Object({ true: text, false: text }, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("score"),
      instructions: text,
      criteria: Type.Array(text, { minItems: 2, maxItems: MAX_CRITERIA }),
    },
    { additionalProperties: false },
  ),
]);
export const DECISION_PARAMETERS = Type.Object(
  {
    state: Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Only the JSON state needed for this decision. Do not send secrets or the entire session.",
    }),
    questions: Type.Record(Type.String(), question, {
      minProperties: 1,
      maxProperties: MAX_QUESTIONS,
    }),
  },
  { additionalProperties: false },
);
const probability = Type.Number({ minimum: 0, maximum: 1 });
export const DECISION_OUTPUT = Type.Union([
  Type.Object(
    {
      status: Type.Literal("ok"),
      provider: Type.String(),
      model: Type.String(),
      answers: Type.Record(
        Type.String(),
        Type.Union([
          Type.Object(
            {
              type: Type.Literal("choice"),
              choice: Type.String(),
              probabilities: Type.Record(Type.String(), probability),
              confidence: Type.Number(),
            },
            { additionalProperties: false },
          ),
          Type.Object({ type: Type.Literal("bool"), probability }, { additionalProperties: false }),
          Type.Object(
            { type: Type.Literal("score"), score: Type.Number(), confidence: Type.Number() },
            { additionalProperties: false },
          ),
        ]),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { status: Type.Literal("error"), error: Type.String() },
    { additionalProperties: false },
  ),
]);
type DecisionOutput = Static<typeof DECISION_OUTPUT>;

class DecisionError extends Error {}

function requireDecision(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DecisionError(message);
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
}

export function validateDecisionRequest(value: unknown): ClassifierContext {
  requireDecision(
    isRecord(value) && isRecord(value.state) && isRecord(value.questions),
    "Decisions require a JSON state object and typed questions.",
  );
  let encoded: string;
  try {
    encoded = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error();
      if (["undefined", "function", "symbol", "bigint"].includes(typeof item)) throw new Error();
      return item;
    });
  } catch {
    throw new DecisionError("Decision input must contain only finite JSON values.");
  }
  requireDecision(
    Buffer.byteLength(encoded, "utf8") <= MAX_DECISION_BYTES,
    "Decision input exceeds the 64 KiB limit.",
  );
  requireDecision(
    Object.keys(value).every((key) => key === "state" || key === "questions"),
    "Unexpected decision input fields.",
  );
  const questions = Object.entries(value.questions);
  requireDecision(
    questions.length > 0 && questions.length <= MAX_QUESTIONS,
    "Provide between 1 and 32 decision questions.",
  );
  for (const [key, item] of questions) {
    requireDecision(
      key.length > 0 &&
        key.length <= 128 &&
        !["__proto__", "constructor", "prototype"].includes(key),
      "Invalid decision question key.",
    );
    requireDecision(
      isRecord(item) && validText(item.instructions),
      "Each question requires bounded, nonempty instructions.",
    );
    requireDecision(
      Object.keys(item).every((field) => ["type", "instructions", "criteria"].includes(field)),
      "Unexpected decision question fields.",
    );
    if (item.type === "score") {
      requireDecision(
        Array.isArray(item.criteria) &&
          item.criteria.length >= 2 &&
          item.criteria.length <= MAX_CRITERIA &&
          item.criteria.every(validText),
        "Scores require 2–64 ordered criteria.",
      );
    } else {
      requireDecision(
        (item.type === "choice" || item.type === "bool") && isRecord(item.criteria),
        "Question type must be choice, bool, or score.",
      );
      const keys = Object.keys(item.criteria);
      requireDecision(
        keys.length >= 2 &&
          keys.length <= MAX_CRITERIA &&
          keys.every(
            (label) =>
              label.length > 0 &&
              label.length <= 128 &&
              !["__proto__", "constructor", "prototype"].includes(label),
          ) &&
          Object.values(item.criteria).every(validText),
        "Provide 2–64 valid labeled criteria.",
      );
      if (item.type === "bool")
        requireDecision(
          keys.length === 2 && keys.includes("true") && keys.includes("false"),
          "Boolean criteria must be true and false.",
        );
    }
  }
  return JSON.parse(encoded) as ClassifierContext;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const unit = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;

export function validateDecisionAnswers(
  answers: unknown,
  request: ClassifierContext,
): ClassifierResult["answers"] {
  const invalid = "Classifier returned invalid typed answers.";
  requireDecision(
    isRecord(answers) && Object.keys(answers).length === Object.keys(request.questions).length,
    invalid,
  );
  const clean: ClassifierResult["answers"] = {};
  for (const [key, q] of Object.entries(request.questions)) {
    const answer = answers[key];
    requireDecision(isRecord(answer) && answer.type === q.type, invalid);
    if (q.type === "bool") {
      requireDecision(unit(answer.probability), invalid);
      clean[key] = { type: "bool", probability: answer.probability };
    } else if (q.type === "score") {
      requireDecision(finite(answer.score) && finite(answer.confidence), invalid);
      // Preserve the provider's score scale; do not relabel it as a probability.
      clean[key] = { type: "score", score: answer.score, confidence: answer.confidence };
    } else {
      requireDecision(
        typeof answer.choice === "string" &&
          Object.hasOwn(q.criteria, answer.choice) &&
          isRecord(answer.probabilities) &&
          finite(answer.confidence),
        invalid,
      );
      const entries = Object.entries(answer.probabilities);
      requireDecision(
        entries.length === Object.keys(q.criteria).length &&
          entries.every(([label, p]) => Object.hasOwn(q.criteria, label) && unit(p)),
        invalid,
      );
      requireDecision(
        Math.abs(entries.reduce((sum, [, p]) => sum + (p as number), 0) - 1) <= 0.001,
        invalid,
      );
      clean[key] = {
        type: "choice",
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: Object.fromEntries(entries) as Record<string, number>,
      };
    }
  }
  return clean;
}

export async function evaluateDecision(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  input: unknown,
  signal?: AbortSignal,
) {
  let result: ClassifierResult | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let abortListener: (() => void) | undefined;
  try {
    requireDecision(
      cfg.decisions.enabled,
      "Decisions are disabled. Select a native classifier with /openai-decisions use provider/model to opt in.",
    );
    const key = parseModelKey(cfg.decisions.model);
    requireDecision(
      key,
      "Select an explicit native classifier with /openai-decisions use provider/model.",
    );
    const model = ctx.modelRegistry.getModelOfType("classifier", key.provider, key.id);
    requireDecision(
      model,
      "The configured native classifier is unavailable. Inspect /openai-decisions models; no chat fallback is used.",
    );
    const request = validateDecisionRequest(input);
    requireDecision(!controller.signal.aborted, "Decision request aborted.");
    const cancelled = new Promise<never>((_resolve, reject) => {
      abortListener = () =>
        reject(
          new DecisionError(
            signal?.aborted ? "Decision request aborted." : "Decision request timed out.",
          ),
        );
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    timer = setTimeout(abort, cfg.decisions.timeoutMs);
    result = await Promise.race([
      ctx.modelRegistry.classify(model, request, { signal: controller.signal, maxRetries: 0 }),
      cancelled,
    ]);
    requireDecision(
      !controller.signal.aborted,
      signal?.aborted ? "Decision request aborted." : "Decision request timed out.",
    );
    requireDecision(
      result.stopReason === "stop",
      result.stopReason === "aborted"
        ? "Decision request aborted."
        : "Decision provider failed. Check the selected provider's credentials and availability in Pi.",
    );
    requireDecision(
      result.provider === model.provider && result.model === model.id,
      "Classifier response did not match the selected provider/model.",
    );
    const answers = validateDecisionAnswers(result.answers, request);
    const output: DecisionOutput = {
      status: "ok",
      provider: result.provider,
      model: result.model,
      answers,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      details: output,
      structuredContent: output,
      usage: result.usage,
    };
  } catch (error) {
    // Provider errors can echo submitted state or credentials; never expose their text.
    const output: DecisionOutput = {
      status: "error",
      error:
        error instanceof DecisionError
          ? error.message
          : "Decision provider failed. Check the selected provider's credentials and availability in Pi.",
    };
    return {
      content: [{ type: "text" as const, text: output.error }],
      details: output,
      structuredContent: output,
      isError: true,
      usage: result?.usage,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}

export function registerOpenAIDecisions(
  pi: ExtensionAPI,
  getConfig: (ctx: ExtensionContext) => ResolvedConfig,
  refreshConfig: (ctx: ExtensionContext) => ResolvedConfig,
): OptionalTool {
  let modelRegistry: ExtensionContext["modelRegistry"] | undefined;
  pi.on("session_start", (_event, ctx) => {
    modelRegistry = ctx.modelRegistry;
  });

  function save(ctx: ExtensionContext, patch: DecisionsConfig): void {
    const cfg = refreshConfig(ctx);
    const raw = readRawConfig(cfg.configPath);
    writeConfig(cfg.configPath, {
      ...raw,
      decisions: { ...(isRecord(raw.decisions) ? raw.decisions : {}), ...patch },
    });
    tool.setEnabled(refreshConfig(ctx).decisions.enabled);
  }

  pi.registerCommand(OPENAI_DECISIONS_COMMAND, {
    description: "Configure opt-in native decisions: models | use provider/model | off",
    getArgumentCompletions: (prefix) =>
      openAIDecisionsArgumentCompletions(
        prefix,
        () => modelRegistry?.getModelsOfType("classifier") ?? [],
      ),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "off") {
        save(ctx, { enabled: false });
        ctx.ui.notify("Decision requests disabled.", "info");
      } else if (arg === "models") {
        const models = ctx.modelRegistry.getModelsOfType("classifier");
        ctx.ui.notify(
          models.length
            ? models.map((m) => `${m.provider}/${m.id}`).join("\n") +
                "\nCatalog entries do not guarantee credentials or entitlement."
            : "No native classifiers registered.",
          "info",
        );
      } else if (arg.startsWith("use ")) {
        const key = parseModelKey(arg.slice(4));
        if (!key || !ctx.modelRegistry.getModelOfType("classifier", key.provider, key.id)) {
          ctx.ui.notify(
            "Unknown native classifier. Use /openai-decisions models; chat models are not accepted.",
            "error",
          );
          return;
        }
        const model = `${key.provider}/${key.id}`;
        save(ctx, { enabled: true, model });
        ctx.ui.notify(
          `Decisions enabled for ${model}. Submitted state is sent to that provider and billed there. No automatic actions or provider fallback.`,
          "warning",
        );
      } else if (!arg) {
        const cfg = getConfig(ctx).decisions;
        ctx.ui.notify(
          `Decisions: ${cfg.enabled ? "enabled" : "disabled"}; model: ${cfg.model || "not selected"}; timeout: ${cfg.timeoutMs}ms.\n/openai-decisions models | use provider/model | off\nOpenAI Decisions: use openai-decisions/gpt-6-luna for API-key billing alongside openai subscription chat. Configure /login openai-decisions or OPENAI_DECISIONS_API_KEY (fallback: OPENAI_API_KEY).`,
          "info",
        );
      } else {
        ctx.ui.notify("Usage: /openai-decisions [models | use provider/model | off]", "error");
      }
    },
  });
  const tool = registerOptionalTool(pi, {
    name: OPENAI_DECIDE_TOOL,
    label: "Typed decision",
    description:
      "Answer bounded choice, bool, or score questions using the user's explicitly configured native classifier. Disabled until opt-in. Supports OpenAI Decisions (openai-decisions/gpt-6-luna for separate API-key billing, or openai/gpt-6-luna with API-key login) and other Pi classifiers including Jev. Never uses a chat fallback or executes decisions.",
    parameters: DECISION_PARAMETERS,
    outputSchema: DECISION_OUTPUT,
    promptGuidelines: [
      "Use only for explicitly requested judgments after the user selects a classifier. Send minimal state, not secrets or the full session.",
      "Treat probabilities as uncertain judgments, not permission to act. Preserve score semantics and escalate ambiguous results.",
    ],
    execute: (_id, params, signal, _onUpdate, ctx) =>
      evaluateDecision(ctx, getConfig(ctx), params, signal),
  });
  return tool;
}
