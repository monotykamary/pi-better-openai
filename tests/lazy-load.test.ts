import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeResolvedConfig } from "./helpers.ts";

// Records which optional heavy graphs were evaluated. Each mock defers to the
// real module, so behavior is unchanged; only the first evaluation is noted.
const loaded = vi.hoisted(() => new Set<string>());

vi.mock("sharp", async (importOriginal) => {
  loaded.add("sharp");
  return importOriginal();
});
vi.mock("../src/image-runtime.ts", async (importOriginal) => {
  loaded.add("image-runtime");
  return importOriginal();
});
vi.mock("../src/live/controller.ts", async (importOriginal) => {
  loaded.add("live-controller");
  return importOriginal();
});
vi.mock("../src/live/transport.ts", async (importOriginal) => {
  loaded.add("live-transport");
  return importOriginal();
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

// A permissive Pi API: every property is a callable stub returning another stub.
function permissiveStub(): unknown {
  const fn = () => permissiveStub();
  return new Proxy(fn, {
    get: (_target, key) => (key === "then" ? undefined : permissiveStub()),
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lazy optional graphs", () => {
  test("importing and registering the extension loads neither sharp, image runtime, nor live transport", async () => {
    const extension = await import("../index.ts");
    extension.default(permissiveStub() as ExtensionAPI);
    expect([...loaded]).toEqual([]);
  });

  test("image runtime loads on first request and sharp only when conversion needs it", async () => {
    const { registerOpenAIImage } = await import("../src/image.ts");
    const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-lazy-"));
    tempDirs.push(cwd);
    let tool:
      | {
          execute: (
            id: string,
            params: Record<string, unknown>,
            signal: AbortSignal | undefined,
            onUpdate: undefined,
            ctx: ExtensionContext,
          ) => Promise<{ details?: unknown }>;
        }
      | undefined;
    const pi = {
      registerTool: vi.fn((registered: typeof tool) => {
        tool = registered;
      }),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
    } as unknown as ExtensionAPI;
    const cfg = makeResolvedConfig();
    cfg.image = { ...cfg.image, enabled: true, defaultSave: "none" };
    const image = registerOpenAIImage(pi, () => cfg);
    expect(loaded.has("image-runtime")).toBe(false);
    expect(loaded.has("sharp")).toBe(false);

    const ctx = { cwd, signal: undefined } as unknown as ExtensionContext;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ data: [{ b64_json: ONE_PIXEL_PNG }], output_format: "png" }),
      ),
    );
    const png = await tool!.execute(
      "call-1",
      { prompt: "draw", outputFormat: "png" },
      undefined,
      undefined,
      ctx,
    );
    expect(png.details).toMatchObject({ mimeType: "image/png", data: ONE_PIXEL_PNG });
    expect(loaded.has("image-runtime")).toBe(true);
    expect(loaded.has("sharp")).toBe(false);

    const jpeg = await tool!.execute(
      "call-2",
      { prompt: "draw", outputFormat: "jpeg" },
      undefined,
      undefined,
      ctx,
    );
    expect(jpeg.details).toMatchObject({ mimeType: "image/jpeg", outputFormat: "jpeg" });
    expect(loaded.has("sharp")).toBe(true);
    expect((await image.getDebug(ctx)).lastStatus).toMatch(/^completed/);
  });

  test("live session controller loads when /live first starts", async () => {
    const { registerOpenAILive, LIVE_COMMAND } = await import("../src/live/index.ts");
    let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerMessageRenderer: vi.fn(),
      registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
        if (name === LIVE_COMMAND) handler = command.handler;
      }),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    } as unknown as ExtensionAPI;
    const cfg = makeResolvedConfig();
    cfg.live = { ...cfg.live, enabled: true };
    registerOpenAILive(pi, () => cfg);
    expect(loaded.has("live-controller")).toBe(false);

    const custom = vi.fn(async () => ({}));
    const notify = vi.fn();
    await handler!("", { mode: "tui", ui: { custom, notify } } as unknown as ExtensionContext);
    expect(custom).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    expect(loaded.has("live-controller")).toBe(true);
    expect(loaded.has("live-transport")).toBe(true);
  });
});
