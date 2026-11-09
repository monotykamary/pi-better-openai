import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { extname, resolve, sep } from "node:path";
import { isRecord, normalizeImageModel, type ResolvedConfig } from "./config.ts";

export const OPENAI_IMAGE_TOOL = "openai_image";
export const OPENAI_IMAGE_COMMAND = "openai-image";
export const CODEX_IMAGES_BASE_URL = "https://chatgpt.com/backend-api/codex/images";
export const CODEX_IMAGE_GENERATIONS_URL = `${CODEX_IMAGES_BASE_URL}/generations`;
export const CODEX_IMAGE_EDITS_URL = `${CODEX_IMAGES_BASE_URL}/edits`;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_INPUTS = 5;
export const MAX_TOTAL_IMAGE_INPUT_BYTES = 50 * 1024 * 1024;
export const SUPPORTED_INPUT_IMAGE_FORMATS = new Set(["png", "jpeg", "jpg", "webp", "gif"]);

export const IMAGE_SAVE_MODES = ["none", "project", "global", "custom"] as const;
export const IMAGE_ACTIONS = ["auto", "generate", "edit"] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

export type ImageSaveMode = (typeof IMAGE_SAVE_MODES)[number];
export type ImageAction = (typeof IMAGE_ACTIONS)[number];
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];

export const TOOL_PARAMS = {
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
        "GPT Image model for the standalone Codex Images API. Defaults to the configured image model.",
    },
    outputFormat: {
      type: "string",
      enum: IMAGE_OUTPUT_FORMATS,
      description: "Returned image format; JPEG and WebP are converted locally from Codex PNG.",
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

export type ToolParams = {
  prompt: string;
  action?: ImageAction;
  images?: string[];
  model?: string;
  outputFormat?: ImageOutputFormat;
  save?: ImageSaveMode;
  saveDir?: string;
};

export type ImageInput = {
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

export type ExtractedImageResult = Omit<
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

export function resolveModel(params: Pick<ToolParams, "model">, cfg: ResolvedConfig): string {
  const model = params.model?.trim();
  return normalizeImageModel(model || cfg.image.defaultModel);
}

export function resolveImageConfig(cfg: ResolvedConfig, params: ToolParams) {
  const action = params.action ?? "auto";
  const outputFormat = params.outputFormat ?? cfg.image.outputFormat;
  const save = params.save ?? cfg.image.defaultSave;
  return { action, outputFormat, save };
}

export function imageMimeType(path: string, outputFormat?: string): string {
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

export function extensionForFormat(format: ImageOutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

export function isInsideDirectory(root: string, child: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedChild = resolve(child);
  return (
    normalizedChild !== normalizedRoot && normalizedChild.startsWith(`${normalizedRoot}${sep}`)
  );
}

export type ConcreteImageAction = Exclude<ImageAction, "auto">;

export type StandaloneImageRequest = {
  action: ConcreteImageAction;
  endpoint: string;
  body: Record<string, unknown>;
};

export function buildRequest(
  params: ToolParams,
  model: string,
  cfg: ResolvedConfig,
  images: ImageInput[],
): StandaloneImageRequest {
  const { action: requestedAction } = resolveImageConfig(cfg, params);
  const action: ConcreteImageAction =
    requestedAction === "auto" ? (images.length > 0 ? "edit" : "generate") : requestedAction;
  if (action === "edit" && images.length === 0)
    throw new Error("action=edit requires at least one image.");
  if (action === "generate" && images.length > 0)
    throw new Error("action=generate does not accept images; use action=auto or action=edit.");

  const common = {
    prompt: params.prompt,
    background: "auto",
    model,
    quality: "auto",
    size: "auto",
  };
  if (action === "edit") {
    return {
      action,
      endpoint: CODEX_IMAGE_EDITS_URL,
      body: {
        images: images.map((image) => ({
          image_url: `data:${image.mimeType};base64,${image.data}`,
        })),
        ...common,
      },
    };
  }
  return { action, endpoint: CODEX_IMAGE_GENERATIONS_URL, body: common };
}

export function dataUrlParts(
  value: string,
  fallbackMimeType: string,
): { data: string; mimeType: string } {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
  if (match)
    return {
      mimeType: match[1] || fallbackMimeType,
      data: (match[2] ?? "").trim(),
    };
  return { data: value.trim(), mimeType: fallbackMimeType };
}

export function parseImageResponsePayload(
  payload: unknown,
  requestId: string,
): ExtractedImageResult {
  if (!isRecord(payload) || !Array.isArray(payload.data))
    throw new Error("Invalid response from Codex Images API.");

  let image: Record<string, unknown> | undefined;
  for (const item of payload.data) {
    if (isRecord(item) && typeof item.b64_json === "string" && item.b64_json.trim()) {
      image = item;
      break;
    }
  }
  if (!image) throw new Error("No image data returned by Codex Images API.");

  const responseFormat =
    typeof payload.output_format === "string" &&
    (IMAGE_OUTPUT_FORMATS as readonly string[]).includes(payload.output_format)
      ? (payload.output_format as ImageOutputFormat)
      : "png";
  const { data, mimeType } = dataUrlParts(
    image.b64_json as string,
    imageMimeType(`image.${responseFormat}`, responseFormat),
  );
  const safeRequestId = requestId.replace(/[^a-zA-Z0-9_-]/g, "_") || randomUUID().slice(0, 8);
  return {
    id: typeof image.id === "string" ? image.id : `ig_${safeRequestId}`,
    status: "completed",
    revisedPrompt: typeof image.revised_prompt === "string" ? image.revised_prompt : undefined,
    data,
    mimeType,
  };
}

export function isImageContent(
  value: unknown,
): value is { type: "image"; data: string; mimeType: string } {
  return (
    isRecord(value) &&
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  );
}

export function displayPath(path: string): string {
  const home = homedir();
  if (!home) return path;
  if (path === home) return "~";
  const homePrefix = home.endsWith(sep) ? home : `${home}${sep}`;
  return path.startsWith(homePrefix) ? `~/${path.slice(homePrefix.length)}` : path;
}

export function resultText(result: CodexImageResult): string {
  const parts = [
    `Generated image using the OpenAI Codex Images API with ${result.model}.`,
    `Action: ${result.action}.`,
    `Prompt: ${result.prompt}`,
  ];
  if (result.revisedPrompt) parts.push(`Revised prompt: ${result.revisedPrompt}`);
  if (result.savedPath) parts.push(`Saved: ${displayPath(result.savedPath)}`);
  return parts.join("\n");
}
