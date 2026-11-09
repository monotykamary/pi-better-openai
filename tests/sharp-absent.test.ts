import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeResolvedConfig } from "./helpers.ts";

// Simulates an install where the native sharp module cannot load.
vi.mock("sharp", () => {
  throw new Error("Cannot find module 'sharp'");
});
vi.mock("../src/codex-auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex-auth.ts")>();
  return {
    ...actual,
    readCodexAuth: vi.fn(() => undefined),
    getCodexCredentials: vi.fn(async () => ({
      accessToken: "test-access",
      accountId: "acct_test",
      source: "modelRegistry",
    })),
  };
});

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ExtensionContext,
) => Promise<{ details?: unknown }>;

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function harness() {
  const { registerOpenAIImage } = await import("../src/image.ts");
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-nosharp-"));
  tempDirs.push(cwd);
  let execute: Execute | undefined;
  const pi = {
    registerTool: vi.fn((tool: { execute: Execute }) => {
      execute = tool.execute;
    }),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
  } as unknown as ExtensionAPI;
  const cfg = makeResolvedConfig();
  cfg.image = { ...cfg.image, enabled: true, defaultSave: "none" };
  const image = registerOpenAIImage(pi, () => cfg);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: [{ b64_json: ONE_PIXEL_PNG }], output_format: "png" })),
  );
  const ctx = { cwd, signal: undefined } as unknown as ExtensionContext;
  return { cwd, ctx, image, execute: execute! };
}

describe("image generation without a loadable sharp", () => {
  test("still registers, and requests that need no codec succeed", async () => {
    const { ctx, execute } = await harness();
    const result = await execute(
      "call-1",
      { prompt: "draw", outputFormat: "png" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details).toMatchObject({ mimeType: "image/png", data: ONE_PIXEL_PNG });
  });

  test("format conversion fails with the existing conversion error", async () => {
    const { ctx, execute, image } = await harness();
    await expect(
      execute("call-2", { prompt: "draw", outputFormat: "jpeg" }, undefined, undefined, ctx),
    ).rejects.toThrow("Failed to convert Codex image output to jpeg.");
    expect((await image.getDebug(ctx)).lastStatus).toBe("error");
  });

  test("input image validation surfaces the codec load failure", async () => {
    const { cwd, ctx, execute } = await harness();
    writeFileSync(join(cwd, "ref.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
    await expect(
      execute("call-3", { prompt: "edit", images: ["ref.png"] }, undefined, undefined, ctx),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
