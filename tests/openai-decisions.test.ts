import { createModels, InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import {
  classifyOpenAIDecisions,
  OPENAI_DECISIONS_MODEL as model,
  registerOpenAIDecisionsProvider,
  withOpenAIDecisions,
  type OpenAIDecisionsContext,
} from "../src/openai-decisions.ts";
import { evaluateDecision } from "../src/decisions.ts";
import { makeResolvedConfig } from "./helpers.ts";

const context: OpenAIDecisionsContext = {
  state: { message: "The deployment worked." },
  questions: {
    category: {
      type: "choice",
      instructions: "Classify the message.",
      criteria: { success: "Worked", failure: "Failed" },
    },
    severity: {
      type: "score",
      instructions: "Rate the severity.",
      criteria: ["low", "medium", "high"],
    },
    approved: {
      type: "bool",
      instructions: "Was it approved?",
      criteria: { true: "Approval", false: "No approval" },
    },
  },
};
const answers = [
  { name: "approved", type: "predicate", probability: 0.95 },
  { name: "severity", type: "score", score: 1.2, confidence: 0.6 },
  {
    name: "category",
    type: "choice",
    choice: "success",
    confidence: 0.8,
    probabilities: [
      { value: "success", probability: 0.9 },
      { value: "failure", probability: 0.1 },
    ],
  },
];
const usage = { input_tokens: 100, output_tokens: 0 };
const response = () => Response.json({ answers, usage });
const openai = () => builtinProviders().find((p) => p.id === "openai")!;
const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };

function transport() {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response());
}

describe("OpenAI Decisions compatibility", () => {
  test("maps all native question types and out-of-order answers; reports input-only cost", async () => {
    const fetch = transport();
    const result = await classifyOpenAIDecisions(model, context, {
      apiKey: "synthetic-key",
      fetch,
      temperature: 2,
    });
    expect(result).toMatchObject({
      provider: "openai",
      model: "gpt-6-luna",
      api: "openai-decisions",
      stopReason: "stop",
      answers: {
        category: {
          type: "choice",
          choice: "success",
          probabilities: { success: 0.9, failure: 0.1 },
          confidence: 0.8,
        },
        severity: { type: "score", score: 1.2, confidence: 0.6 },
        approved: { type: "bool", probability: 0.95 },
      },
      usage: { input: 100, output: 0, totalTokens: 100, cost: { total: 0.00001 } },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/decisions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-6-luna",
      input: JSON.stringify(context.state),
      questions: [
        {
          name: "category",
          type: "choice",
          instructions: "Classify the message.",
          choices: [
            { value: "success", description: "Worked" },
            { value: "failure", description: "Failed" },
          ],
        },
        {
          name: "severity",
          type: "score",
          instructions: "Rate the severity.",
          levels: [{ label: "low" }, { label: "medium" }, { label: "high" }],
        },
        {
          name: "approved",
          type: "predicate",
          instructions: "Was it approved?\n\nTrue means: Approval\nFalse means: No approval",
        },
      ],
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("supports only inline images without reading paths or fetching remote URLs", async () => {
    const fetch = transport();
    expect(
      (
        await classifyOpenAIDecisions(
          model,
          { ...context, images: [image] },
          { apiKey: "key", fetch },
        )
      ).stopReason,
    ).toBe("stop");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: JSON.stringify(context.state) },
          { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
        ],
      },
    ]);
    for (const images of [
      [{ ...image, data: "https://example.com/private.png" }],
      [{ ...image, mimeType: "image/svg+xml" }],
      Array.from({ length: 129 }, () => image),
    ]) {
      expect(
        (await classifyOpenAIDecisions(model, { ...context, images }, { apiKey: "key", fetch }))
          .stopReason,
      ).toBe("error");
    }
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("honors payload/response hooks, effective endpoint and nullable header overrides", async () => {
    const fetch = transport();
    const onPayload = vi.fn(() => ({ replaced: true }));
    const onResponse = vi.fn();
    const result = await classifyOpenAIDecisions(
      {
        ...model,
        baseUrl: "https://example.test/custom/v1/",
        headers: { "X-Default": "remove", "X-Model": "yes" },
      },
      context,
      {
        apiKey: "key",
        fetch,
        headers: { "x-default": null, "X-Request": "yes" },
        onPayload,
        onResponse,
      },
    );
    expect(result.stopReason).toBe("stop");
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://example.test/custom/v1/decisions");
    expect(JSON.parse(String(init?.body))).toEqual({ replaced: true });
    const h = new Headers(init?.headers);
    expect(h.get("x-default")).toBeNull();
    expect(h.get("x-model")).toBe("yes");
    expect(h.get("x-request")).toBe("yes");
    expect(onResponse).toHaveBeenCalledExactlyOnceWith(
      { status: 200, headers: expect.any(Object) },
      expect.objectContaining({ id: model.id }),
    );
  });

  test("refusals and malformed answers fail closed without losing billed usage or echoing payloads", async () => {
    for (const invalid of [
      [],
      [...answers, answers[0]],
      [{ name: "approved", type: "refusal", reason: "secret echo" }, ...answers.slice(1)],
      [{ ...answers[0], probability: 2 }, ...answers.slice(1)],
      [answers[0], { ...answers[1], score: 3 }, answers[2]],
      [answers[0], answers[1], { ...answers[2], choice: "unknown" }],
      [
        answers[0],
        answers[1],
        {
          ...answers[2],
          probabilities: [
            { value: "success", probability: 0.9 },
            { value: "success", probability: 0.1 },
          ],
        },
      ],
    ]) {
      const result = await classifyOpenAIDecisions(model, context, {
        apiKey: "key",
        fetch: async () => Response.json({ answers: invalid, usage }),
      });
      expect(result).toMatchObject({ stopReason: "error", answers: {}, usage: { input: 100 } });
      expect(JSON.stringify(result)).not.toContain("secret echo");
    }
  });

  test("uses catalog long-context costs and leaves absent usage unknown", async () => {
    const result = await classifyOpenAIDecisions(model, context, {
      apiKey: "key",
      fetch: async () =>
        Response.json({ answers, usage: { input_tokens: 300000, output_tokens: 0 } }),
    });
    expect(result.usage?.cost.total).toBeCloseTo(0.06);
    expect(
      (
        await classifyOpenAIDecisions(model, context, {
          apiKey: "key",
          fetch: async () => Response.json({ answers }),
        })
      ).usage,
    ).toBeUndefined();
  });

  test("bounds HTTP retries and does not retry gateway timeouts, auth errors or explicit no-retry calls", async () => {
    const fetch = vi.fn(async () => response());
    fetch.mockResolvedValueOnce(
      new Response("private echo", { status: 429, headers: { "retry-after-ms": "0" } }),
    );
    expect(
      (await classifyOpenAIDecisions(model, context, { apiKey: "key", fetch })).stopReason,
    ).toBe("stop");
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [status, maxRetries] of [
      [401, 2],
      [504, 2],
      [429, 0],
    ] as const) {
      const fetch = vi.fn(async () => new Response("private echo", { status }));
      const result = await classifyOpenAIDecisions(model, context, {
        apiKey: "key",
        fetch,
        maxRetries,
      });
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain(String(status));
      expect(result.errorMessage).not.toContain("private echo");
      expect(fetch).toHaveBeenCalledOnce();
    }
    const capped = vi.fn(
      async () => new Response("", { status: 429, headers: { "retry-after": "100" } }),
    );
    expect(
      (
        await classifyOpenAIDecisions(model, context, {
          apiKey: "key",
          fetch: capped,
          maxRetryDelayMs: 1,
        })
      ).errorMessage,
    ).toContain("retry delay");
    expect(capped).toHaveBeenCalledOnce();
  });

  test("returns error envelopes for missing auth, invalid JSON, aborts and timeouts", async () => {
    const fetch = transport();
    expect((await classifyOpenAIDecisions(model, context, { fetch })).stopReason).toBe("error");
    expect(
      (
        await classifyOpenAIDecisions(model, context, {
          apiKey: "key",
          fetch,
          signal: AbortSignal.abort(),
        })
      ).stopReason,
    ).toBe("aborted");
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (
        await classifyOpenAIDecisions(model, context, {
          apiKey: "key",
          fetch: async () => new Response("not JSON"),
        })
      ).stopReason,
    ).toBe("error");
    const pendingFetch = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    expect(
      (
        await classifyOpenAIDecisions(model, context, {
          apiKey: "key",
          fetch: pendingFetch,
          timeoutMs: 5,
          maxRetries: 0,
        })
      ).errorMessage,
    ).toContain("timed out");
    const controller = new AbortController();
    const pending = classifyOpenAIDecisions(model, context, {
      apiKey: "key",
      fetch: pendingFetch,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);
    expect((await pending).stopReason).toBe("aborted");
  });

  test("adds compatibility without changing an older host's existing provider behavior", () => {
    const current = openai();
    const native: Provider = {
      ...current,
      classify: undefined,
      getAllModels: () => current.getAllModels!().filter((m) => m.type !== "classifier"),
    };
    const provider = withOpenAIDecisions(native);
    for (const key of [
      "auth",
      "stream",
      "streamSimple",
      "getModels",
      "refreshModels",
      "generateImages",
      "fetchDeferred",
      "cancelDeferred",
    ] as const)
      expect(provider[key]).toBe(native[key]);
    expect(provider.getModels()).toEqual(native.getModels());
    expect(provider.getAllModels!().filter((m) => m.type === "classifier")).toEqual([model]);
    expect(
      provider.filterAllModels!(provider.getAllModels!(), {
        type: "oauth",
        access: "synthetic",
        refresh: "synthetic",
        expires: Date.now() + 3600000,
      }),
    ).not.toContain(model);
    expect(
      provider.filterAllModels!(provider.getAllModels!(), { type: "api_key", key: "synthetic" }),
    ).toContain(model);
    const upcoming: Provider = { ...provider, classify: vi.fn() };
    expect(withOpenAIDecisions(upcoming)).toBe(upcoming);
    const registerProvider = vi.fn();
    registerOpenAIDecisionsProvider({ registerProvider } as unknown as ExtensionAPI);
    expect(registerProvider).toHaveBeenCalledTimes(2);
    expect(registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "openai" }));
    expect(registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: "openai-decisions" }),
    );
    expect(withOpenAIDecisions(current)).toBe(current);
  });

  test("uses the real Pi registry and existing opt-in tool without a second credential path", async () => {
    const provider = withOpenAIDecisions(openai());
    const credentials = new InMemoryCredentialStore();
    const registry = createModels({
      credentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    registry.setProvider(provider);
    expect(await registry.getAvailableOfType("classifier")).toEqual([]);
    await credentials.modify("openai-codex", async () => ({
      type: "api_key",
      key: "not-openai-auth",
    }));
    expect(await registry.getAvailableOfType("classifier")).toEqual([]);
    await credentials.modify("openai", async () => ({
      type: "api_key",
      key: "synthetic-openai-key",
    }));
    const nativeModel = provider.getAllModels!().find(
      (m) => m.type === "classifier" && m.id === model.id,
    );
    expect(nativeModel).toBeDefined();
    expect(await registry.getAvailableOfType("classifier", "openai")).toEqual([nativeModel]);
    const fetch = transport();
    const ctx = {
      modelRegistry: {
        getModelOfType: registry.getModelOfType.bind(registry),
        classify: (m, c, o) => registry.classify(m, c, { ...o, fetch }),
      },
    } as ExtensionContext;
    const cfg = makeResolvedConfig({
      decisions: { enabled: true, model: "openai/gpt-6-luna", timeoutMs: 1000 },
    });
    const result = await evaluateDecision(ctx, cfg, context);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      provider: "openai",
      model: model.id,
      answers: { approved: { type: "bool", probability: 0.95 } },
    });
    expect(result.usage?.input).toBe(100);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBe(
      "Bearer synthetic-openai-key",
    );
  });
});
