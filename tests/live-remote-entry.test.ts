import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import type { RemoteMediaProcess } from "../src/live/remote/client.ts";
import {
  encodeFrame,
  FrameDecoder,
  type HostFrame,
  parseHostFrame,
} from "../src/live/remote/protocol.ts";
import { resolveLiveNativePackage } from "../src/live/native.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

/** Mirrors an npm install: the package, its jiti and its native addon side by side in node_modules. */
function installLayout(): { entry: string; probe: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "live-media-host-"));
  roots.push(root);
  const modules = join(root, "node_modules");
  const pkg = join(modules, "@monotykamary", "pi-better-openai");
  mkdirSync(pkg, { recursive: true });
  cpSync(join(repo, "src"), join(pkg, "src"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@monotykamary/pi-better-openai", type: "module" }),
  );
  symlinkSync(join(repo, "node_modules", "jiti"), join(modules, "jiti"), "junction");
  symlinkSync(join(repo, "node_modules", "@oh-my-pi"), join(modules, "@oh-my-pi"), "junction");
  const probe = join(root, "probe.mjs");
  writeFileSync(
    probe,
    `import { createJiti } from "jiti";
const jiti = createJiti(${JSON.stringify(pathToFileURL(join(pkg, "src/live/remote/media-host.mjs")).href)});
const { loadLiveNative } = await jiti.import("../native.ts");
const { createLocalMediaFactory } = await jiti.import("../media.ts");
const bindings = loadLiveNative();
console.log(JSON.stringify({ capture: typeof bindings.AudioCapture, factory: typeof createLocalMediaFactory }));
`,
  );
  return { entry: join(pkg, "src/live/remote/media-host.mjs"), probe, root };
}

function startHost(entry: string, cwd: string) {
  const child = spawn(process.execPath, [entry], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const frames: HostFrame[] = [];
  const decoder = new FrameDecoder(parseHostFrame);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    frames.push(...decoder.push(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  return { child, frames, exited, stdout: () => stdout, stderr: () => stderr };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("media-host.mjs loaded from a node_modules layout", () => {
  test("greets with hello and exits cleanly on EOF without opening anything", async () => {
    const { entry, root } = installLayout();
    const host = startHost(entry, root);
    await until(() => host.frames.length > 0, "hello");
    expect(host.frames).toEqual([{ type: "hello" }]);
    host.child.stdin.end();
    await expect(host.exited).resolves.toBe(0);
    expect(host.stdout()).toBe(encodeFrame({ type: "hello" }));
  }, 30_000);

  test("rejects an incompatible client before loading any media code", async () => {
    const { entry, root } = installLayout();
    const host = startHost(entry, root);
    host.child.stdin.write('{"v":2,"type":"request","id":1,"method":"open"}\n');
    await expect(host.exited).resolves.toBe(1);
    expect(host.frames[0]).toEqual({ type: "hello" });
    expect(host.frames.at(-1)).toMatchObject({
      type: "failure",
      message: expect.stringContaining("version 2"),
    });
    expect(host.stderr()).toContain("version 2");
  }, 30_000);

  test("stops on a close frame sent before open", async () => {
    const { entry, root } = installLayout();
    const host = startHost(entry, root);
    await until(() => host.frames.length > 0, "hello");
    host.child.stdin.write(encodeFrame({ type: "close" }));
    await expect(host.exited).resolves.toBe(0);
  }, 30_000);

  test.skipIf(process.platform === "win32")(
    "stops on SIGTERM",
    async () => {
      const { entry, root } = installLayout();
      const host = startHost(entry, root);
      await until(() => host.frames.length > 0, "hello");
      host.child.kill("SIGTERM");
      await expect(host.exited).resolves.toBe(0);
    },
    30_000,
  );

  test.skipIf(!resolveLiveNativePackage(process.platform, process.arch))(
    "loads the media and native modules through jiti beside the addon, without opening a device",
    async () => {
      const { probe, root } = installLayout();
      const child = spawn(process.execPath, [probe], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const code = await new Promise<number | null>((done) => child.once("exit", done));
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({ capture: "function", factory: "function" });
    },
    30_000,
  );

  test("a real child process satisfies the client's process type", () => {
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["-e", ""]);
    const asClientProcess: RemoteMediaProcess = child;
    child.kill();
    expect(typeof asClientProcess.kill).toBe("function");
  });
});
