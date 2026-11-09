import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Image, Text } from "@earendil-works/pi-tui";
import { isRecord, type ResolvedConfig } from "./config.ts";
import {
  CODEX_AUTH_REQUIRED,
  extractAccountIdFromJwt,
  getCodexCredentials,
  type CodexCredentialsWithSource,
} from "./codex-auth.ts";
import { maskIdentifier, sanitizeDiagnosticError } from "./format.ts";
import { registerOptionalTool, type OptionalTool } from "./optional-tool.ts";
import {
  OPENAI_IMAGE_TOOL,
  OPENAI_IMAGE_COMMAND,
  CODEX_IMAGES_BASE_URL,
  CODEX_IMAGE_GENERATIONS_URL,
  CODEX_IMAGE_EDITS_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUTS,
  MAX_TOTAL_IMAGE_INPUT_BYTES,
  TOOL_PARAMS,
  resolveModel,
  imageMimeType,
  dataUrlParts,
  parseImageResponsePayload,
  displayPath,
  buildRequest,
  resultText,
  isImageContent,
  type ToolParams,
  type CodexImageResult,
  type ImageGenerationDebug,
} from "./image-shared.ts";
export { IMAGE_SAVE_MODES, IMAGE_ACTIONS, IMAGE_OUTPUT_FORMATS } from "./image-shared.ts";
export type {
  ImageSaveMode,
  ImageAction,
  ImageOutputFormat,
  CodexImageResult,
  ImageGenerationDebug,
} from "./image-shared.ts";

type CodexImageCredentials = CodexCredentialsWithSource;

async function getCredentials(
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<CodexImageCredentials> {
  const credentials = await getCodexCredentials(ctx, signal);
  if (credentials) return credentials;
  throw new Error(CODEX_AUTH_REQUIRED);
}

export function registerOpenAIImage(
  pi: ExtensionAPI,
  getConfig: (ctx: ExtensionContext) => ResolvedConfig,
): OptionalTool & { getDebug: (ctx: ExtensionContext) => Promise<ImageGenerationDebug> } {
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
      // Request/validation/conversion code (and the native sharp codec it
      // uses) loads on the first image request, not at extension load.
      const { requestCodexImage } = await import("./image-runtime.ts");
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
      endpoint: CODEX_IMAGES_BASE_URL,
      defaultModel: cfg.image.defaultModel,
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
    description: "Generate an image with the standalone OpenAI Codex Images API",
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

  const tool = registerOptionalTool(pi, {
    name: OPENAI_IMAGE_TOOL,
    label: "OpenAI image",
    description:
      "Generate or edit images through the standalone Codex Images API using OpenAI subscription auth. Supports local reference/edit images and saves to the project by default.",
    promptSnippet: "Generate or edit raster images via OpenAI Codex subscription auth.",
    promptGuidelines: [
      "Use openai_image when the user asks to generate or edit a raster image, photo, illustration, mockup, texture, sprite, or bitmap asset.",
      "Pass the user's image prompt verbatim. Do not embellish, rewrite, add camera/style details, or add negative prompt terms unless the user explicitly asks you to refine the prompt.",
      "Use openai_image with images for local reference images or edit targets; save project assets into the workspace when requested.",
    ],
    parameters: TOOL_PARAMS,
    async execute(_toolCallId, params: ToolParams, signal, onUpdate, ctx) {
      const cfg = getConfig(ctx);
      const model = resolveModel(params, cfg);
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Requesting OpenAI Codex image via ${model}...`,
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

  return { getDebug, ...tool };
}

export const _imageTest = {
  CODEX_IMAGES_BASE_URL,
  CODEX_IMAGE_GENERATIONS_URL,
  CODEX_IMAGE_EDITS_URL,
  DEFAULT_TIMEOUT_MS,
  OPENAI_IMAGE_TOOL,
  OPENAI_IMAGE_COMMAND,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUTS,
  MAX_TOTAL_IMAGE_INPUT_BYTES,
  extractAccountIdFromJwt,
  imageMimeType,
  dataUrlParts,
  parseImageResponsePayload,
  displayPath,
  buildRequest,
};
