import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { _test } from "../index.ts";
import { writeConfig } from "../src/config.ts";
import { registerOpenAIWebSearch, _websearchTest } from "../src/websearch.ts";
import { makeResolvedConfig } from "./helpers.ts";

vi.mock("../src/codex-auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex-auth.ts")>();
  return {
    ...actual,
    readCodexAuth: vi.fn(() => undefined),
    getCodexCredentials: vi.fn(async (ctx?: Pick<ExtensionContext, "modelRegistry">) => {
      const registryToken = await ctx?.modelRegistry
        ?.getApiKeyForProvider("openai-codex")
        .catch(() => undefined);
      const registryCredentials = actual.parseCodexRegistryCredentials(registryToken);
      return registryCredentials ? { ...registryCredentials, source: "modelRegistry" } : undefined;
    }),
  };
});

type ToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((update: unknown) => void) | undefined,
  ctx: ExtensionContext,
) => Promise<{ content: unknown[]; details?: unknown }>;

type RegisteredTool = {
  name: string;
  execute: ToolExecute;
};

type WebsearchHarness = {
  ctx: ExtensionContext;
  tool: RegisteredTool;
  getDebug: Awaited<ReturnType<typeof registerOpenAIWebSearch>>["getDebug"];
};

const REGISTRY_CREDENTIALS = JSON.stringify({ access: "test-access", accountId: "acct_test" });
const tempDirs: string[] = [];

function createTempProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-websearch-"));
  tempDirs.push(cwd);
  return cwd;
}

function createWebsearchHarness(
  options: {
    registryCredentials?: string;
    websearchConfig?: Partial<typeof _test.DEFAULT_WEBSEARCH_CONFIG>;
  } = {},
): WebsearchHarness {
  const cwd = createTempProject();
  let registeredTool: RegisteredTool | undefined;
  const pi = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      registeredTool = tool;
    }),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    signal: undefined,
    model: { provider: "openai-codex", id: "gpt-5.5" },
    ui: { notify: vi.fn() },
    modelRegistry: {
      getApiKeyForProvider: vi.fn(() =>
        Promise.resolve(
          "registryCredentials" in options ? options.registryCredentials : REGISTRY_CREDENTIALS,
        ),
      ),
      isUsingOAuth: vi.fn(() => true),
    },
  } as unknown as ExtensionContext;
  const cfg = makeResolvedConfig({
    websearch: {
      ..._test.DEFAULT_WEBSEARCH_CONFIG,
      ...options.websearchConfig,
    },
  });
  const debug = registerOpenAIWebSearch(pi, () => cfg);
  if (!registeredTool) throw new Error("openai_websearch tool was not registered.");
  return { ctx, tool: registeredTool, getDebug: debug.getDebug };
}

function stubFetch(response: Response | (() => Promise<Response>)): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    typeof response === "function" ? response() : Promise.resolve(response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function executeSearch(
  harness: WebsearchHarness,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return harness.tool.execute("tool-call-1", params, signal, vi.fn(), harness.ctx);
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Expected Error rejection, received ${String(error)}`);
  }
  throw new Error("Expected promise to reject.");
}

function codexSearchResponse(): Response {
  return Response.json({
    encrypted_output: "opaque-ciphertext",
    output: " Search completed ",
    results: [
      {
        type: "text_result",
        ref_id: "turn0search0",
        url: "https://effect.website/",
        title: " Effect ",
        snippet: " Effect documentation ",
        future_field: { accepted: true },
      },
      { type: "future_result", url: "https://example.com/ignored" },
      { type: "text_result", url: "javascript:alert(1)", title: "unsafe" },
    ],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("websearch helpers", () => {
  test("validates queries before making a request", () => {
    expect(_test.websearchTest.validateSearchQuery("  effect ts  ")).toBe("effect ts");
    expect(() => _test.websearchTest.validateSearchQuery("   ")).toThrowError(/non-empty query/);
    expect(() =>
      _test.websearchTest.validateSearchQuery("x".repeat(_test.websearchTest.MAX_QUERY_BYTES + 1)),
    ).toThrowError(/exceeded/);
  });

  test("builds the Codex search request body", () => {
    expect(
      _test.websearchTest.buildSearchRequestBody(
        "effect typescript",
        _test.DEFAULT_WEBSEARCH_CONFIG,
        "short",
        "search-id",
      ),
    ).toEqual({
      id: "search-id",
      model: "gpt-5.6-luna",
      reasoning: { effort: "max" },
      input: "effect typescript",
      commands: {
        search_query: [{ q: "effect typescript" }],
        response_length: "short",
      },
      settings: {
        allowed_callers: ["direct"],
        external_web_access: true,
      },
      max_output_tokens: 4096,
    });
  });

  test("parses answers while trimming and filtering unsafe citations", () => {
    const body = JSON.stringify({
      output: " answer ",
      results: [
        {
          type: "text_result",
          url: "https://effect.website/",
          title: " Effect ",
          snippet: " docs ",
        },
        { type: "future_result", url: "https://example.com/ignored" },
        { type: "text_result", url: "javascript:alert(1)", title: "unsafe" },
        { type: "text_result", title: "missing url" },
      ],
    });
    expect(_test.websearchTest.parseSearchResponse(body)).toEqual({
      answer: "answer",
      results: [{ url: "https://effect.website/", title: "Effect", content: "docs" }],
    });
  });

  test("fails clearly when the alpha response omits structured citations", () => {
    const error = (() => {
      try {
        _test.websearchTest.parseSearchResponse(
          JSON.stringify({ output: "No structured results", results: null }),
        );
      } catch (cause) {
        return cause as Error;
      }
      throw new Error("expected parse to throw");
    })();
    expect(error.message).toContain("structured citations");
  });

  test("formats answers with a capped source list and no-result fallback", () => {
    const text = _test.websearchTest.formatSearchText("effect", {
      answer: "An answer.",
      results: [{ url: "https://effect.website/", title: "Effect", content: "docs" }],
    });
    expect(text).toContain("An answer.");
    expect(text).toContain("1. [Effect](https://effect.website/)");
    expect(text).toContain("docs");
    expect(_test.websearchTest.formatSearchText("nothing", { answer: "", results: [] })).toBe(
      'No web results found for "nothing".',
    );
  });
});

describe("websearch config", () => {
  test("exposes websearch defaults", () => {
    expect(_test.DEFAULT_WEBSEARCH_CONFIG).toEqual({
      enabled: true,
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      responseLength: "short",
      maxOutputTokens: 4096,
      timeoutMs: 25_000,
    });
  });

  test("resolves websearch overrides with clamping", () => {
    const cwd = createTempProject();
    writeConfig(_test.configPaths(cwd).project, {
      websearch: { responseLength: "long", timeoutMs: 1, maxOutputTokens: 999_999 },
    });
    const resolved = _test.resolveConfig(cwd);
    expect(resolved.websearch.responseLength).toBe("long");
    expect(resolved.websearch.timeoutMs).toBe(5_000);
    expect(resolved.websearch.maxOutputTokens).toBe(100_000);
    writeConfig(_test.configPaths(cwd).project, {
      websearch: { reasoningEffort: "bogus" },
    });
    expect(_test.resolveConfig(cwd).websearch.reasoningEffort).toBe("max");
  });
});

describe("openai_websearch tool execution", () => {
  test("sends the Codex search request and formats cited results", async () => {
    const fetchMock = stubFetch(codexSearchResponse());
    const harness = createWebsearchHarness();

    const result = await executeSearch(harness, { query: "effect typescript" });

    expect(harness.tool.name).toBe("openai_websearch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(_test.websearchTest.CODEX_SEARCH_URL);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(init.headers).toMatchObject({
      authorization: "Bearer test-access",
      "chatgpt-account-id": "acct_test",
      accept: "application/json",
      "content-type": "application/json",
      originator: "codex_cli_rs",
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: { effort: "max" },
      input: "effect typescript",
      commands: {
        search_query: [{ q: "effect typescript" }],
        response_length: "short",
      },
      settings: { allowed_callers: ["direct"], external_web_access: true },
      max_output_tokens: 4096,
    });
    expect(typeof body.id).toBe("string");

    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Search completed") as unknown as string,
      },
    ]);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1. [Effect](https://effect.website/)");
    expect(text).not.toContain("javascript:");
    expect(result.details).toMatchObject({
      query: "effect typescript",
      answer: "Search completed",
      model: "gpt-5.6-luna",
      results: [
        { url: "https://effect.website/", title: "Effect", content: "Effect documentation" },
      ],
    });

    const debug = await harness.getDebug(harness.ctx);
    expect(debug).toMatchObject({
      authFound: true,
      authSource: "modelRegistry",
      accountId: "acct...test",
      endpoint: _test.websearchTest.CODEX_SEARCH_URL,
      enabled: true,
      lastStatus: "completed (1 sources)",
    });
  });

  test("honours the responseLength override parameter", async () => {
    const fetchMock = stubFetch(codexSearchResponse());
    const harness = createWebsearchHarness();

    await executeSearch(harness, { query: "effect", responseLength: "long" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      commands: { search_query: [{ q: "effect" }], response_length: "long" },
    });
  });

  test("rejects blank and oversized queries before making a request", async () => {
    const fetchMock = stubFetch(codexSearchResponse());
    const harness = createWebsearchHarness();

    await expect(executeSearch(harness, { query: "   " })).rejects.toThrow(/non-empty query/);
    await expect(
      executeSearch(harness, { query: "x".repeat(_test.websearchTest.MAX_QUERY_BYTES + 1) }),
    ).rejects.toThrow(/exceeded/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses to run when disabled in config", async () => {
    const fetchMock = stubFetch(codexSearchResponse());
    const harness = createWebsearchHarness({ websearchConfig: { enabled: false } });

    await expect(executeSearch(harness, { query: "effect" })).rejects.toThrow(/disabled in config/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("requires ChatGPT OAuth credentials", async () => {
    const fetchMock = stubFetch(codexSearchResponse());
    const harness = createWebsearchHarness({ registryCredentials: undefined });

    const error = await rejectedError(executeSearch(harness, { query: "effect" }));
    expect(error.message).toContain("/login openai-codex");
    expect(fetchMock).not.toHaveBeenCalled();

    const debug = await harness.getDebug(harness.ctx);
    expect(debug.authFound).toBe(false);
    expect(debug.lastStatus).toBe("error");
  });

  test("sanitizes authentication failures", async () => {
    stubFetch(new Response("test-access acct_test upstream details", { status: 401 }));
    const harness = createWebsearchHarness();

    const error = await rejectedError(executeSearch(harness, { query: "effect" }));
    expect(error.message).toContain("authentication failed (HTTP 401)");
    expect(error.message).not.toContain("test-access");
    expect(error.message).not.toContain("acct_test");
    expect(error.message).not.toContain("upstream details");
  });

  test("rejects oversized responses by declared content length", async () => {
    stubFetch(
      new Response("", {
        headers: { "content-length": String(_test.websearchTest.MAX_RESPONSE_BYTES + 1) },
      }),
    );
    const harness = createWebsearchHarness();

    await expect(executeSearch(harness, { query: "effect" })).rejects.toThrow(/exceeded/);
  });

  test("rejects oversized streamed responses without a content length", async () => {
    stubFetch(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(_test.websearchTest.MAX_RESPONSE_BYTES + 1));
            controller.close();
          },
        }),
      ),
    );
    const harness = createWebsearchHarness();

    await expect(executeSearch(harness, { query: "effect" })).rejects.toThrow(/exceeded/);
  });

  test("propagates caller cancellation as a sanitized error", async () => {
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) =>
      Promise.reject().catch(() => {
        if (init?.signal?.aborted) throw new Error("raw abort");
        return Response.json({ output: "unexpected", results: [] });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const harness = createWebsearchHarness();
    const controller = new AbortController();
    controller.abort();

    const error = await rejectedError(
      executeSearch(harness, { query: "effect" }, controller.signal),
    );
    expect(error.message).toContain("aborted");
    expect(error.message).not.toContain("raw abort");
  });
});
