import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "./config.ts";
import { CODEX_AUTH_REQUIRED, getCodexCredentials } from "./codex-auth.ts";
import { sanitizeDiagnosticError } from "./format.ts";
import { piAgentDir, resolveUserPath } from "./paths.ts";
import { loadSharp } from "./sharp.ts";
import {
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUTS,
  MAX_TOTAL_IMAGE_INPUT_BYTES,
  SUPPORTED_INPUT_IMAGE_FORMATS,
  displayPath,
  imageMimeType,
  isInsideDirectory,
  extensionForFormat,
  resolveModel,
  resolveImageConfig,
  buildRequest,
  parseImageResponsePayload,
  type ToolParams,
  type ImageInput,
  type ImageSaveMode,
  type ImageOutputFormat,
  type ExtractedImageResult,
  type CodexImageResult,
} from "./image-shared.ts";

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

  const sharp = await loadSharp();
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

async function parseImageResponse(
  response: Response,
  requestId: string,
): Promise<ExtractedImageResult> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Invalid response from Codex Images API.");
  }
  return parseImageResponsePayload(payload, requestId);
}

async function convertImageOutput(
  image: ExtractedImageResult,
  outputFormat: ImageOutputFormat,
): Promise<ExtractedImageResult> {
  const targetMimeType = imageMimeType(`image.${outputFormat}`, outputFormat);
  if (image.mimeType === targetMimeType) return image;

  try {
    const sharp = await loadSharp();
    const input = sharp(Buffer.from(image.data, "base64"), { animated: false });
    const output =
      outputFormat === "jpeg"
        ? await input.jpeg().toBuffer()
        : outputFormat === "webp"
          ? await input.webp().toBuffer()
          : await input.png().toBuffer();
    return { ...image, data: output.toString("base64"), mimeType: targetMimeType };
  } catch {
    throw new Error(`Failed to convert Codex image output to ${outputFormat}.`);
  }
}

export async function requestCodexImage(
  params: ToolParams,
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  requestSignal?: AbortSignal,
): Promise<CodexImageResult> {
  if (!cfg.image.enabled) throw new Error("OpenAI image generation is disabled in config.");
  if (!params.prompt.trim()) throw new Error("Image prompt must not be empty.");
  const cwd = ctx.cwd || process.cwd();
  const model = resolveModel(params, cfg);
  const { outputFormat, save } = resolveImageConfig(cfg, params);
  const saveDir = resolveSaveDir(save, params, cwd);
  const timeoutSignal = AbortSignal.timeout(cfg.image.timeoutMs);
  const baseSignal = requestSignal ?? ctx.signal;
  const signal = baseSignal ? AbortSignal.any([baseSignal, timeoutSignal]) : timeoutSignal;
  const credentials = await getCodexCredentials(ctx, signal);
  if (!credentials) throw new Error(CODEX_AUTH_REQUIRED);
  const images = await readImageInputs(params.images, cwd);
  const request = buildRequest(params, model, cfg, images);
  const requestId = randomUUID();
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      accept: "application/json",
      "content-type": "application/json",
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.0.0 (pi-better-openai)",
      "x-codex-image-turn-id": requestId,
    },
    body: JSON.stringify(request.body),
    signal,
  });
  if (!response.ok) {
    const statusText = response.statusText
      ? ` ${sanitizeDiagnosticError(response.statusText, 120)}`
      : "";
    throw new Error(`Codex image request failed (${response.status}${statusText}).`);
  }
  const parsed = await parseImageResponse(response, requestId);
  const converted = await convertImageOutput(parsed, outputFormat);
  const savedPath = saveDir
    ? await saveImage(converted.data, outputFormat, saveDir, converted.id)
    : undefined;
  return {
    ...converted,
    prompt: params.prompt,
    savedPath,
    model,
    action: request.action,
    outputFormat,
  };
}
