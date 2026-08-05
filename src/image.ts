import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Image, Text } from "@earendil-works/pi-tui";
import sharp from "sharp";
import type { ResolvedConfig } from "./config.ts";
import { isRecord } from "./config.ts";
import {
  extractAccountIdFromJwt,
  getCodexCredentials,
  type CodexCredentialsWithSource,
} from "./codex-auth.ts";
import { maskIdentifier, sanitizeDiagnosticError } from "./format.ts";
import { piAgentDir, resolveUserPath } from "./paths.ts";

const OPENAI_IMAGE_TOOL = "openai_image";
const OPENAI_IMAGE_COMMAND = "openai-image";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_INPUTS = 5;
const MAX_TOTAL_IMAGE_INPUT_BYTES = 50 * 1024 * 1024;
const SUPPORTED_INPUT_IMAGE_FORMATS = new Set(["png", "jpeg", "jpg", "webp", "gif"]);
const SSE_EVENT_BOUNDARY = /\r?\n\r?\n/;

export const IMAGE_SAVE_MODES = ["none", "project", "global", "custom"] as const;
export const IMAGE_ACTIONS = ["auto", "generate", "edit"] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

export type ImageSaveMode = (typeof IMAGE_SAVE_MODES)[number];
export type ImageAction = (typeof IMAGE_ACTIONS)[number];
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];

const TOOL_PARAMS = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description:
        "Image generation/editing prompt. Pass the user's wording verbatim unless they explicitly ask you to refine or expand it.",
    },
    action: {
      type: "string",
      enum: IMAGE_ACTIONS,
      description:
        "Whether to generate a new image, edit/reference provided images, or let the model decide.",
    },
    images: {
      type: "array",
      maxItems: MAX_IMAGE_INPUTS,
      items: { type: "string" },
      description: "Local image paths to use as edit targets or references.",
    },
    model: {
      type: "string",
      description:
        "OpenAI Codex model to drive the hosted image_generation tool. Defaults to current openai-codex model or config default.",
    },
    outputFormat: {
      type: "string",
      enum: IMAGE_OUTPUT_FORMATS,
      description: "Generated image format.",
    },
    save: {
      type: "string",
      enum: IMAGE_SAVE_MODES,
      description: "Where to save the generated image.",
    },
    saveDir: { type: "string", description: "Directory to save image when save=custom." },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;

type ToolParams = {
  prompt: string;
  action?: ImageAction;
  images?: string[];
  model?: string;
  outputFormat?: ImageOutputFormat;
  save?: ImageSaveMode;
  saveDir?: string;
};

type CodexImageCredentials = CodexCredentialsWithSource;

type ImageInput = {
  path: string;
  data: string;
  mimeType: string;
};

export type CodexImageResult = {
  id: string;
  status: string;
  prompt: string;
  revisedPrompt?: string;
  data: string;
  mimeType: string;
  savedPath?: string;
  model: string;
  action: ImageAction;
  outputFormat: ImageOutputFormat;
};

type ExtractedImageResult = Omit<
  CodexImageResult,
  "prompt" | "savedPath" | "model" | "action" | "outputFormat"
>;

export type ImageGenerationDebug = {
  authFound: boolean;
  authSource?: string;
  accountId?: string;
  endpoint: string;
  defaultModel: string;
  defaultSave: ImageSaveMode;
  enabled: boolean;
  lastStatus?: string;
  lastError?: string;
};

async function getCredentials(
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<CodexImageCredentials> {
  const credentials = await getCodexCredentials(ctx, signal);
  if (credentials) return credentials;
  throw new Error("Missing openai-codex OAuth credentials. Run /login openai-codex.");
}

function resolveModel(
  params: Pick<ToolParams, "model">,
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
): string {
  const model = params.model?.trim();
  if (model) return model.includes("/") ? model.split("/").pop() || model : model;
  if (ctx.model?.provider === "openai-codex") return ctx.model.id;
  return cfg.image.defaultModel;
}

function resolveImageConfig(cfg: ResolvedConfig, params: ToolParams) {
  const action = params.action ?? "auto";
  const outputFormat = params.outputFormat ?? cfg.image.outputFormat;
  const save = params.save ?? cfg.image.defaultSave;
  return { action, outputFormat, save };
}

function imageMimeType(path: string, outputFormat?: string): string {
  if (outputFormat === "jpeg" || outputFormat === "jpg") return "image/jpeg";
  if (outputFormat === "webp") return "image/webp";
  if (outputFormat === "gif") return "image/gif";
  if (outputFormat === "png") return "image/png";
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function extensionForFormat(format: ImageOutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

function isInsideDirectory(root: string, child: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedChild = resolve(child);
  return (
    normalizedChild !== normalizedRoot && normalizedChild.startsWith(`${normalizedRoot}${sep}`)
  );
}

async function validateImageInput(
  path: string,
  realWorkspaceRoot: string,
): Promise<{ mimeType: string; path: string; size: number }> {
  const realInputPath = await realpath(path).catch(() => undefined);
  if (!realInputPath || !isInsideDirectory(realWorkspaceRoot, realInputPath))
    throw new Error(
      `Image input must be a file inside the current workspace: ${displayPath(path)}`,
    );

  const pathStats = await stat(realInputPath).catch(() => undefined);
  if (!pathStats?.isFile())
    throw new Error(
      `Image input must be a file inside the current workspace: ${displayPath(path)}`,
    );
  if (pathStats.size > MAX_IMAGE_INPUT_BYTES)
    throw new Error(`Image input is too large (max 20 MB): ${displayPath(path)}`);

  const metadata = await sharp(realInputPath, { animated: false })
    .metadata()
    .catch(() => undefined);
  if (!metadata?.format || !SUPPORTED_INPUT_IMAGE_FORMATS.has(metadata.format))
    throw new Error(`Image input is not a readable image: ${displayPath(path)}`);
  return {
    mimeType: imageMimeType(path, metadata.format),
    path: realInputPath,
    size: pathStats.size,
  };
}

async function readImageInputs(paths: string[] | undefined, cwd: string): Promise<ImageInput[]> {
  const validatedInputs: Array<{ path: string; mimeType: string }> = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  const workspaceRoot = resolve(cwd);
  let realWorkspaceRoot: string | undefined;
  for (const rawPath of paths ?? []) {
    const trimmed = rawPath.trim();
    if (!trimmed) continue;
    const path = isAbsolute(trimmed) ? resolve(trimmed) : resolve(workspaceRoot, trimmed);
    if (!isInsideDirectory(workspaceRoot, path))
      throw new Error(
        `Image input must be a file inside the current workspace: ${displayPath(path)}`,
      );
    realWorkspaceRoot ??= await realpath(workspaceRoot).catch(() => workspaceRoot);
    const input = await validateImageInput(path, realWorkspaceRoot);
    if (seenPaths.has(input.path)) continue;
    if (validatedInputs.length >= MAX_IMAGE_INPUTS)
      throw new Error(`Too many image inputs (max ${MAX_IMAGE_INPUTS}).`);
    totalBytes += input.size;
    if (totalBytes > MAX_TOTAL_IMAGE_INPUT_BYTES)
      throw new Error("Image inputs are too large in total (max 50 MB).");
    seenPaths.add(input.path);
    validatedInputs.push({ path: input.path, mimeType: input.mimeType });
  }
  return Promise.all(
    validatedInputs.map(async (input) => ({
      ...input,
      data: (await readFile(input.path)).toString("base64"),
    })),
  );
}

function resolveSaveDir(
  mode: ImageSaveMode,
  params: Pick<ToolParams, "saveDir">,
  cwd: string,
): string | undefined {
  if (mode === "none") return undefined;
  if (mode === "project") return join(cwd, ".pi", "generated-images");
  if (mode === "global") return join(piAgentDir(), "generated-images");
  const dir = params.saveDir?.trim() || process.env.PI_IMAGE_SAVE_DIR?.trim();
  if (!dir) throw new Error("save=custom requires saveDir or PI_IMAGE_SAVE_DIR.");
  return resolveUserPath(dir, cwd);
}

async function saveImage(
  data: string,
  format: ImageOutputFormat,
  outputDir: string,
  id: string,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_") || randomUUID().slice(0, 8);
  const path = join(outputDir, `openai-image-${timestamp}-${safeId}.${extensionForFormat(format)}`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path, Buffer.from(data, "base64"));
  return path;
}

function buildRequest(
  params: ToolParams,
  model: string,
  cfg: ResolvedConfig,
  images: ImageInput[],
) {
  const { action, outputFormat } = resolveImageConfig(cfg, params);
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: params.prompt }];
  for (const image of images) {
    content.push({
      type: "input_image",
      detail: "auto",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  }
  const tool: Record<string, unknown> = { type: "image_generation", output_format: outputFormat };
  if (action !== "auto") tool.action = action;
  return {
    model,
    instructions: "",
    input: [{ role: "user", content }],
    tools: [tool],
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
    client_metadata: { "x-codex-installation-id": "pi-better-openai" },
  };
}

function dataUrlParts(value: string, fallbackMimeType: string): { data: string; mimeType: string } {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
  if (match)
    return {
      mimeType: match[1] || fallbackMimeType,
      data: (match[2] ?? "").trim(),
    };
  return { data: value.trim(), mimeType: fallbackMimeType };
}

function asImageResultItem(
  value: unknown,
):
  | { id?: string; status?: string; revised_prompt?: string; result?: string; b64_json?: string }
  | undefined {
  if (!isRecord(value) || value.type !== "image_generation_call") return undefined;
  return value as {
    id?: string;
    status?: string;
    revised_prompt?: string;
    result?: string;
    b64_json?: string;
  };
}

function isImageContent(
  value: unknown,
): value is { type: "image"; data: string; mimeType: string } {
  return (
    isRecord(value) &&
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  );
}

function extractImageFromEvent(
  event: unknown,
  fallbackMimeType: string,
): ExtractedImageResult | undefined {
  if (!isRecord(event)) return undefined;
  let item = asImageResultItem(event.item) ?? asImageResultItem(event);
  if (!item && isRecord(event.response) && Array.isArray(event.response.output)) {
    for (const outputItem of event.response.output) {
      item = asImageResultItem(outputItem);
      if (item) break;
    }
  }
  if (item) {
    const raw =
      typeof item.result === "string" && item.result.trim()
        ? item.result
        : typeof item.b64_json === "string"
          ? item.b64_json
          : undefined;
    if (!raw) return undefined;
    const { data, mimeType } = dataUrlParts(raw, fallbackMimeType);
    return {
      id: typeof item.id === "string" ? item.id : `ig_${randomUUID().slice(0, 8)}`,
      status: typeof item.status === "string" ? item.status : "completed",
      revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
      data,
      mimeType,
    };
  }
  const partial =
    typeof event.partial_image_b64 === "string"
      ? event.partial_image_b64
      : typeof event.b64_json === "string"
        ? event.b64_json
        : undefined;
  if (typeof partial === "string" && partial.trim()) {
    const { data, mimeType } = dataUrlParts(partial, fallbackMimeType);
    return { id: `ig_${randomUUID().slice(0, 8)}`, status: "partial", data, mimeType };
  }
  return undefined;
}

async function parseSseForImage(
  response: Response,
  fallbackMimeType: string,
  signal?: AbortSignal,
): Promise<ExtractedImageResult> {
  if (!response.body) throw new Error("No response body from Codex image request.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Image request was aborted.");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = SSE_EVENT_BOUNDARY.exec(buffer);
      while (boundary) {
        const idx = boundary.index;
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + boundary[0].length);
        const data = chunk
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();
        if (data && data !== "[DONE]") {
          let event: unknown;
          try {
            event = JSON.parse(data);
          } catch {
            event = undefined;
          }
          const image = extractImageFromEvent(event, fallbackMimeType);
          const terminalImageEvent =
            isRecord(event) &&
            (event.type === "response.output_item.done" ||
              event.type === "response.completed" ||
              event.type === "response.done");
          if (image?.data && (image.status === "completed" || terminalImageEvent)) {
            await reader.cancel().catch(() => undefined);
            return { ...image, status: "completed" };
          }
          if (isRecord(event) && event.type === "response.failed") {
            const error =
              isRecord(event.response) && isRecord(event.response.error)
                ? event.response.error
                : undefined;
            const message = sanitizeDiagnosticError(
              typeof error?.message === "string" ? error.message : "Codex image request failed.",
            );
            throw new Error(message);
          }
          if (isRecord(event) && event.type === "error") {
            const message = sanitizeDiagnosticError(
              typeof event.message === "string" ? event.message : JSON.stringify(event),
            );
            throw new Error(`Codex image error: ${message}`);
          }
        }
        boundary = SSE_EVENT_BOUNDARY.exec(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error("No completed image_generation_call result returned by Codex.");
}

async function requestCodexImage(
  params: ToolParams,
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  requestSignal?: AbortSignal,
): Promise<CodexImageResult> {
  if (!cfg.image.enabled) throw new Error("OpenAI image generation is disabled in config.");
  const cwd = ctx.cwd || process.cwd();
  const model = resolveModel(params, ctx, cfg);
  const { action, outputFormat, save } = resolveImageConfig(cfg, params);
  const saveDir = resolveSaveDir(save, params, cwd);
  const timeoutSignal = AbortSignal.timeout(cfg.image.timeoutMs);
  const baseSignal = requestSignal ?? ctx.signal;
  const signal = baseSignal ? AbortSignal.any([baseSignal, timeoutSignal]) : timeoutSignal;
  const credentials = await getCredentials(ctx, signal);
  const images = await readImageInputs(params.images, cwd);
  const request = buildRequest(params, model, cfg, images);
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.0.0 (pi-better-openai)",
    },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    const statusText = response.statusText
      ? ` ${sanitizeDiagnosticError(response.statusText, 120)}`
      : "";
    throw new Error(`Codex image request failed (${response.status}${statusText}).`);
  }
  const parsed = await parseSseForImage(
    response,
    imageMimeType(`image.${outputFormat}`, outputFormat),
    signal,
  );
  const savedPath = saveDir
    ? await saveImage(parsed.data, outputFormat, saveDir, parsed.id)
    : undefined;
  return { ...parsed, prompt: params.prompt, savedPath, model, action, outputFormat };
}

function displayPath(path: string): string {
  const home = homedir();
  if (!home) return path;
  if (path === home) return "~";
  const homePrefix = home.endsWith(sep) ? home : `${home}${sep}`;
  return path.startsWith(homePrefix) ? `~/${path.slice(homePrefix.length)}` : path;
}

function resultText(result: CodexImageResult): string {
  const parts = [
    `Generated image using OpenAI image_generation tool via openai-codex/${result.model}.`,
    `Action: ${result.action}.`,
    `Prompt: ${result.prompt}`,
  ];
  if (result.revisedPrompt) parts.push(`Revised prompt: ${result.revisedPrompt}`);
  if (result.savedPath) parts.push(`Saved: ${displayPath(result.savedPath)}`);
  return parts.join("\n");
}

export function registerOpenAIImage(
  pi: ExtensionAPI,
  getConfig: (ctx: ExtensionContext) => ResolvedConfig,
): { getDebug: (ctx: ExtensionContext) => Promise<ImageGenerationDebug> } {
  let lastStatus: string | undefined;
  let lastError: string | undefined;

  async function generate(
    params: ToolParams,
    ctx: ExtensionContext,
    requestSignal?: AbortSignal,
  ): Promise<CodexImageResult> {
    try {
      lastStatus = "requesting";
      lastError = undefined;
      const result = await requestCodexImage(params, ctx, getConfig(ctx), requestSignal);
      lastStatus = `completed (${result.id})`;
      return result;
    } catch (error) {
      lastStatus = "error";
      lastError = sanitizeDiagnosticError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function getDebug(ctx: ExtensionContext): Promise<ImageGenerationDebug> {
    const cfg = getConfig(ctx);
    let credentials: CodexImageCredentials | undefined;
    try {
      credentials = await getCredentials(ctx);
    } catch {
      credentials = undefined;
    }
    return {
      authFound: credentials !== undefined,
      authSource: credentials?.source,
      accountId: maskIdentifier(credentials?.accountId),
      endpoint: CODEX_RESPONSES_URL,
      defaultModel: ctx.model?.provider === "openai-codex" ? ctx.model.id : cfg.image.defaultModel,
      defaultSave: cfg.image.defaultSave,
      enabled: cfg.image.enabled,
      lastStatus,
      lastError,
    };
  }

  pi.registerMessageRenderer<CodexImageResult>("openai-image", (message, _options, theme) => {
    const result = message.details;
    const text =
      result && isRecord(result)
        ? resultText(result as CodexImageResult)
        : typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
    let image: { data: string; mimeType: string; savedPath?: string } | undefined;
    if (
      result &&
      isRecord(result) &&
      typeof result.data === "string" &&
      typeof result.mimeType === "string"
    ) {
      image = {
        data: result.data,
        mimeType: result.mimeType,
        savedPath: typeof result.savedPath === "string" ? result.savedPath : undefined,
      };
    } else if (Array.isArray(message.content)) {
      const imagePart = message.content.find(isImageContent);
      if (imagePart) image = { data: imagePart.data, mimeType: imagePart.mimeType };
    }

    const container = new Container();
    const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
    box.addChild(new Text(`${theme.fg("accent", theme.bold("[openai-image]"))}\n\n${text}`, 0, 0));
    if (image) {
      box.addChild(
        new Image(
          image.data,
          image.mimeType,
          { fallbackColor: (line) => theme.fg("dim", line) },
          {
            maxWidthCells: 80,
            maxHeightCells: 24,
            filename:
              "savedPath" in image && typeof image.savedPath === "string"
                ? image.savedPath
                : undefined,
          },
        ),
      );
    }
    container.addChild(box);
    return container;
  });

  pi.registerCommand(OPENAI_IMAGE_COMMAND, {
    description: "Generate an image with OpenAI Codex image generation",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify("Usage: /openai-image <prompt>", "error");
        return;
      }
      ctx.ui.notify("Requesting OpenAI image...", "info");
      const result = await generate({ prompt }, ctx);
      pi.sendMessage({
        customType: "openai-image",
        content: [
          { type: "text", text: resultText(result) },
          { type: "image", data: result.data, mimeType: result.mimeType },
        ],
        display: true,
        details: result,
      });
    },
  });

  pi.registerTool({
    name: OPENAI_IMAGE_TOOL,
    label: "OpenAI image",
    description:
      "Generate or edit images through OpenAI Codex subscription auth using the hosted image_generation tool. Supports local reference/edit images and saves to the project by default.",
    promptSnippet: "Generate or edit raster images via OpenAI Codex subscription auth.",
    promptGuidelines: [
      "Use openai_image when the user asks to generate or edit a raster image, photo, illustration, mockup, texture, sprite, or bitmap asset.",
      "Pass the user's image prompt verbatim. Do not embellish, rewrite, add camera/style details, or add negative prompt terms unless the user explicitly asks you to refine the prompt.",
      "Use openai_image with images for local reference images or edit targets; save project assets into the workspace when requested.",
    ],
    parameters: TOOL_PARAMS,
    async execute(_toolCallId, params: ToolParams, signal, onUpdate, ctx) {
      const cfg = getConfig(ctx);
      const model = resolveModel(params, ctx, cfg);
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Requesting OpenAI image_generation via openai-codex/${model}...`,
          },
        ],
        details: undefined,
      });
      const result = await generate(params, ctx, signal);
      return {
        content: [
          { type: "text", text: resultText(result) },
          { type: "image", data: result.data, mimeType: result.mimeType },
        ],
        details: result,
      };
    },
  });

  return { getDebug };
}

export const _imageTest = {
  CODEX_RESPONSES_URL,
  DEFAULT_TIMEOUT_MS,
  OPENAI_IMAGE_TOOL,
  OPENAI_IMAGE_COMMAND,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUTS,
  MAX_TOTAL_IMAGE_INPUT_BYTES,
  extractAccountIdFromJwt,
  imageMimeType,
  dataUrlParts,
  extractImageFromEvent,
  displayPath,
  buildRequest,
};
