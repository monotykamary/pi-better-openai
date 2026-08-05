import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { _test } from "../index.ts";
import { registerOpenAIImage } from "../src/image.ts";
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

type ImageHarness = {
  ctx: ExtensionContext;
  tool: RegisteredTool;
  getDebug: Awaited<ReturnType<typeof registerOpenAIImage>>["getDebug"];
};

const tempDirs: string[] = [];
const originalImageSaveDir = process.env.PI_IMAGE_SAVE_DIR;

function createTempProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-image-"));
  tempDirs.push(cwd);
  return cwd;
}

function sseResponse(events: unknown[], lineEnding = "\n"): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}${lineEnding}${lineEnding}`),
          );
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function finalImageEvent(id = "ig_test", data = "Zm9v") {
  return {
    type: "response.output_item.done",
    item: { type: "image_generation_call", id, status: "completed", result: data },
  };
}

async function writeTinyPng(path: string): Promise<void> {
  await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toFile(path);
}

async function writeTinyJpeg(path: string): Promise<void> {
  const data = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .jpeg()
    .toBuffer();
  writeFileSync(path, data);
}

function createImageHarness(
  options: {
    cwd?: string;
    registryCredentials?: string | undefined;
    imageConfig?: Partial<typeof _test.DEFAULT_IMAGE_CONFIG>;
  } = {},
): ImageHarness {
  const cwd = options.cwd ?? createTempProject();
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
    ui: { notify: vi.fn(), setFooter: vi.fn(), setStatus: vi.fn() },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getCwd: vi.fn(() => cwd),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: {
      getApiKeyForProvider: vi.fn(() => Promise.resolve(options.registryCredentials)),
      isUsingOAuth: vi.fn(() => true),
    },
    getContextUsage: vi.fn(() => ({ contextWindow: 0, percent: 0 })),
  } as unknown as ExtensionContext;
  const cfg = makeResolvedConfig({
    image: {
      ..._test.DEFAULT_IMAGE_CONFIG,
      enabled: true,
      defaultSave: "none",
      ...options.imageConfig,
    },
  });
  const debug = registerOpenAIImage(pi, () => cfg);
  if (!registeredTool) throw new Error("openai_image tool was not registered.");
  return { ctx, tool: registeredTool, getDebug: debug.getDebug };
}

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function executeImageTool(harness: ImageHarness, params: Record<string, unknown>) {
  return harness.tool.execute("tool-call-1", params, undefined, vi.fn(), harness.ctx);
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

beforeEach(() => {
  delete process.env.PI_IMAGE_SAVE_DIR;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  if (originalImageSaveDir === undefined) delete process.env.PI_IMAGE_SAVE_DIR;
  else process.env.PI_IMAGE_SAVE_DIR = originalImageSaveDir;
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("image helpers", () => {
  test("exposes image tool defaults", () => {
    expect(_test.imageTest.OPENAI_IMAGE_TOOL).toBe("openai_image");
  });

  test("detects image mime types and display paths", () => {
    expect(_test.imageTest.imageMimeType("x.jpg")).toBe("image/jpeg");
    expect(_test.imageTest.displayPath(join(homedir(), "dev", "image.png"))).toBe(
      "~/dev/image.png",
    );
  });

  test("extracts data URLs", () => {
    expect(_test.imageTest.dataUrlParts("data:image/png;base64,Zm9v", "image/png")).toEqual({
      data: "Zm9v",
      mimeType: "image/png",
    });
  });

  test("extracts image generation results from response events", () => {
    const extracted = _test.imageTest.extractImageFromEvent(
      {
        type: "response.output_item.done",
        item: { type: "image_generation_call", id: "ig_1", status: "completed", result: "Zm9v" },
      },
      "image/png",
    );
    expect(extracted?.data).toBe("Zm9v");

    const partial = _test.imageTest.extractImageFromEvent(
      { partial_image_b64: "cGFydGlhbA==" },
      "image/png",
    );
    expect(partial).toMatchObject({ status: "partial", data: "cGFydGlhbA==" });
  });

  test("builds image generation requests", () => {
    expect(
      _test.imageTest.buildRequest(
        { prompt: "draw an otter" },
        "gpt-5.5",
        makeResolvedConfig({ image: _test.DEFAULT_IMAGE_CONFIG }),
        [],
      ).tool_choice,
    ).toEqual({ type: "image_generation" });
  });
});

describe("openai_image tool execution", () => {
  test("executes through the registered tool and sends a Codex image request", async () => {
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    const result = await executeImageTool(harness, { prompt: "draw an otter", save: "none" });

    expect(harness.tool.name).toBe("openai_image");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(_test.imageTest.CODEX_RESPONSES_URL);
    expect(init.headers).toMatchObject({
      authorization: "Bearer test-access",
      "chatgpt-account-id": "acct_test",
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.5",
      tool_choice: { type: "image_generation" },
    });
    expect(body.input).toMatchObject([
      { role: "user", content: [{ type: "input_text", text: "draw an otter" }] },
    ]);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("Generated image") },
      { type: "image", data: "Zm9v", mimeType: "image/png" },
    ]);
    expect(result.details).toMatchObject({ id: "ig_test", data: "Zm9v", savedPath: undefined });
  });

  test("waits for a final image_generation_call when partial image events arrive first", async () => {
    stubFetch(
      sseResponse([{ partial_image_b64: "cGFydGlhbA==" }, finalImageEvent("ig_final", "ZmluYWw=")]),
    );
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    const result = await executeImageTool(harness, { prompt: "draw", save: "none" });

    expect(result.content).toContainEqual({
      type: "image",
      data: "ZmluYWw=",
      mimeType: "image/png",
    });
    expect(result.details).toMatchObject({ id: "ig_final", data: "ZmluYWw=" });
  });

  test("accepts a done image item whose embedded status is still generating", async () => {
    stubFetch(
      sseResponse([
        {
          type: "response.image_generation_call.partial_image",
          partial_image_b64: "cGFydGlhbA==",
        },
        {
          type: "response.output_item.done",
          item: {
            type: "image_generation_call",
            id: "ig_live_contract",
            status: "generating",
            result: "ZmluYWw=",
          },
        },
        { type: "response.completed", response: { status: "completed" } },
      ]),
    );
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    const result = await executeImageTool(harness, { prompt: "draw", save: "none" });

    expect(result.details).toMatchObject({
      id: "ig_live_contract",
      status: "completed",
      data: "ZmluYWw=",
    });
  });

  test("parses CRLF-delimited SSE events", async () => {
    stubFetch(sseResponse([finalImageEvent("ig_crlf", "Y3JsZg==")], "\r\n"));
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    const result = await executeImageTool(harness, { prompt: "draw", save: "none" });

    expect(result.details).toMatchObject({ id: "ig_crlf", data: "Y3JsZg==" });
  });

  test("rejects streams that end without a completed image_generation_call", async () => {
    stubFetch(sseResponse([{ partial_image_b64: "cGFydGlhbA==" }]));
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    await expect(executeImageTool(harness, { prompt: "draw", save: "none" })).rejects.toThrow(
      "No completed image_generation_call result returned by Codex.",
    );
  });

  test("uploads project-local reference images and saves generated output to the project", async () => {
    const cwd = createTempProject();
    const relativeInput = join(cwd, "input.png");
    const absoluteInput = join(cwd, "absolute.png");
    await writeTinyPng(relativeInput);
    await writeTinyPng(absoluteInput);
    const relativeData = readFileSync(relativeInput).toString("base64");
    const absoluteData = readFileSync(absoluteInput).toString("base64");
    const fetchMock = stubFetch(sseResponse([finalImageEvent("ig_saved", "Zm9v")]));
    const harness = createImageHarness({
      cwd,
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
      imageConfig: { defaultSave: "project" },
    });

    const result = await executeImageTool(harness, {
      prompt: "edit it",
      images: ["input.png", absoluteInput],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { input: Array<{ content: unknown[] }> };
    expect(body.input[0]?.content).toEqual([
      { type: "input_text", text: "edit it" },
      {
        type: "input_image",
        detail: "auto",
        image_url: `data:image/png;base64,${relativeData}`,
      },
      {
        type: "input_image",
        detail: "auto",
        image_url: `data:image/png;base64,${absoluteData}`,
      },
    ]);
    const outputDir = join(cwd, ".pi", "generated-images");
    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^openai-image-.*-ig_saved\.png$/);
    expect(readFileSync(join(outputDir, files[0]!)).toString("base64")).toBe("Zm9v");
    expect(result.details).toMatchObject({ savedPath: join(outputDir, files[0]!) });
  });

  test("uses detected image content type instead of a misleading file extension", async () => {
    const cwd = createTempProject();
    const renamedJpeg = join(cwd, "actually-jpeg.png");
    await writeTinyJpeg(renamedJpeg);
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      cwd,
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    await executeImageTool(harness, {
      prompt: "edit it",
      images: ["actually-jpeg.png"],
      save: "none",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).toContain("data:image/jpeg;base64,");
  });

  test("honors an explicitly refined tool prompt instead of replacing it from history", async () => {
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });
    harness.ctx.sessionManager.getEntries = vi.fn(() => [
      { type: "message", message: { role: "user", content: "raw user wording" } },
    ]) as unknown as ExtensionContext["sessionManager"]["getEntries"];

    await executeImageTool(harness, { prompt: "explicitly refined prompt", save: "none" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { input: Array<{ content: unknown[] }> };
    expect(body.input[0]?.content).toContainEqual({
      type: "input_text",
      text: "explicitly refined prompt",
    });
  });

  test("resolves relative custom save directories from the project", async () => {
    const cwd = createTempProject();
    stubFetch(sseResponse([finalImageEvent("ig_custom", "Zm9v")]));
    const harness = createImageHarness({
      cwd,
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    const result = await executeImageTool(harness, {
      prompt: "draw",
      save: "custom",
      saveDir: "artifacts",
    });

    expect(result.details).toMatchObject({
      savedPath: expect.stringMatching(
        new RegExp(`^${join(cwd, "artifacts").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      ),
    });
    expect(readdirSync(join(cwd, "artifacts"))).toHaveLength(1);
  });

  test("rejects a missing custom save directory before requesting an image", async () => {
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    await expect(executeImageTool(harness, { prompt: "draw", save: "custom" })).rejects.toThrow(
      "save=custom requires saveDir or PI_IMAGE_SAVE_DIR",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects image paths outside the workspace before upload", async () => {
    const cwd = createTempProject();
    const outsideDir = createTempProject();
    const outsideImage = join(outsideDir, "outside.png");
    await writeTinyPng(outsideImage);
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      cwd,
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    await expect(
      executeImageTool(harness, { prompt: "draw", images: [outsideImage] }),
    ).rejects.toThrow("Image input must be a file inside the current workspace");
    await expect(
      executeImageTool(harness, { prompt: "draw", images: [relative(cwd, outsideImage)] }),
    ).rejects.toThrow("Image input must be a file inside the current workspace");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects directory image inputs before upload", async () => {
    const cwd = createTempProject();
    mkdirSync(join(cwd, "images"));
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      cwd,
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    await expect(executeImageTool(harness, { prompt: "draw", images: ["images"] })).rejects.toThrow(
      "Image input must be a file inside the current workspace",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects non-image files before upload", async () => {
    const cwd = createTempProject();
    writeFileSync(join(cwd, "notes.txt"), "not an image", "utf8");
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      cwd,
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    await expect(
      executeImageTool(harness, { prompt: "draw", images: ["notes.txt"] }),
    ).rejects.toThrow("Image input is not a readable image");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects oversized image inputs before upload", async () => {
    const cwd = createTempProject();
    const largeImage = join(cwd, "large.png");
    writeFileSync(largeImage, "");
    truncateSync(largeImage, _test.imageTest.MAX_IMAGE_INPUT_BYTES + 1);
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      cwd,
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    await expect(
      executeImageTool(harness, { prompt: "draw", images: ["large.png"] }),
    ).rejects.toThrow("Image input is too large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("caps distinct reference images before building an unbounded request", async () => {
    const cwd = createTempProject();
    const imageNames = Array.from(
      { length: _test.imageTest.MAX_IMAGE_INPUTS + 1 },
      (_, index) => `input-${index}.png`,
    );
    await Promise.all(imageNames.map((name) => writeTinyPng(join(cwd, name))));
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      cwd,
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    await expect(
      executeImageTool(harness, { prompt: "collage", images: imageNames, save: "none" }),
    ).rejects.toThrow(`Too many image inputs (max ${_test.imageTest.MAX_IMAGE_INPUTS})`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects when image generation is disabled before calling fetch", async () => {
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
      imageConfig: { enabled: false },
    });

    await expect(executeImageTool(harness, { prompt: "draw" })).rejects.toThrow(
      "OpenAI image generation is disabled in config.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects when Codex credentials are missing before calling fetch", async () => {
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({ registryCredentials: undefined });

    await expect(executeImageTool(harness, { prompt: "draw" })).rejects.toThrow(
      "Missing openai-codex OAuth credentials.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("redacts non-OK Codex response bodies from errors and debug state", async () => {
    const secretBody = `Bearer sk-secretsecret accountId=acct_1234567890abcdef ${"x".repeat(700)}`;
    const fetchMock = stubFetch(
      new Response(secretBody, { status: 500, statusText: "Server Error" }),
    );
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    const error = await rejectedError(executeImageTool(harness, { prompt: "draw" }));
    const debug = await harness.getDebug(harness.ctx);

    expect(error.message).toBe("Codex image request failed (500 Server Error).");
    expect(error.message).not.toContain("sk-secretsecret");
    expect(error.message).not.toContain("acct_1234567890abcdef");
    expect(debug.lastError).toBe(error.message);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("redacts and bounds SSE error messages", async () => {
    const message = `bad\u001b[31m Bearer sk-secretsecret accountId=acct_1234567890abcdef ${"x".repeat(700)}`;
    stubFetch(sseResponse([{ type: "error", message }]));
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    const error = await rejectedError(executeImageTool(harness, { prompt: "draw" }));
    const debug = await harness.getDebug(harness.ctx);

    expect(error.message).toContain("Codex image error: bad");
    expect(error.message).not.toContain("\u001b");
    expect(error.message).not.toContain("sk-secretsecret");
    expect(error.message).not.toContain("acct_1234567890abcdef");
    expect(error.message.length).toBeLessThanOrEqual(520);
    expect(debug.lastError).toContain("Codex image error: bad");
    expect(debug.lastError).not.toContain("sk-secretsecret");
    expect(debug.lastError).not.toContain("acct_1234567890abcdef");
    expect(debug.lastError?.length).toBeLessThanOrEqual(500);
  });

  test("masks image debug account identifiers", async () => {
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({
        access: "test-access",
        accountId: "acct_1234567890abcdef",
      }),
    });

    const debug = await harness.getDebug(harness.ctx);

    expect(debug.accountId).toBe("acct...cdef");
    expect(debug.accountId).not.toBe("acct_1234567890abcdef");
  });
});
