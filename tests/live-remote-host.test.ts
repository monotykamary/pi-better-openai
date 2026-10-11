import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  acquireHostLock,
  ensureRuntimeDir,
  HostBusyError,
  hostDirectory,
  launcherPath,
  registerLauncher,
  registerPersonalLauncher,
} from "../src/live/remote/host.ts";

const roots: string[] = [];
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "lh-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const posix = describe.skipIf(process.platform === "win32");

posix("launcher", () => {
  test("is written under the agent dir, executable, and only rewritten when it changes", () => {
    const agentDir = temp();
    const first = registerLauncher({
      agentDir,
      nodePath: "/opt/node/bin/node",
      entry: "/pkg/h.mjs",
    });
    expect(first).toEqual({ path: launcherPath(agentDir), changed: true });
    expect(first.path).toBe(join(hostDirectory(agentDir), "media-host"));
    expect(statSync(first.path).mode & 0o111).not.toBe(0);
    expect(readFileSync(first.path, "utf8")).toContain(
      "exec '/opt/node/bin/node' '/pkg/h.mjs' \"$@\"",
    );

    expect(
      registerLauncher({ agentDir, nodePath: "/opt/node/bin/node", entry: "/pkg/h.mjs" }).changed,
    ).toBe(false);
    const moved = registerLauncher({
      agentDir,
      nodePath: "/opt/node/bin/node",
      entry: "/pkg2/h.mjs",
    });
    expect(moved.changed).toBe(true);
    expect(readFileSync(moved.path, "utf8")).toContain("'/pkg2/h.mjs'");
  });

  test("runs the media host with the recorded node whatever the paths contain", async () => {
    const agentDir = temp();
    const entry = join(temp(), "it's a dir", "host.mjs");
    mkdirSync(join(entry, ".."), { recursive: true });
    writeFileSync(entry, "console.log(JSON.stringify(process.argv.slice(2)))");
    const { path } = registerLauncher({ agentDir, nodePath: process.execPath, entry });
    // Run it the way the Pi host does: through a shell, from an unrelated directory and PATH.
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", `exec '${path}' one "two words"`], {
        cwd: tmpdir(),
        env: { PATH: "/nonexistent" },
      });
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.on("error", reject);
      child.on("exit", () => resolve(text));
    });
    expect(JSON.parse(out)).toEqual(["one", "two words"]);
  });

  test("a personal install keeps it fresh; a checkout, project copy or -e path never does", () => {
    const agentDir = temp();
    const personal = join(agentDir, "npm", "node_modules", "@monotykamary", "pi-better-openai");
    const entry = join(personal, "src", "live", "remote", "media-host.mjs");
    mkdirSync(join(entry, ".."), { recursive: true });
    writeFileSync(entry, "");
    expect(registerPersonalLauncher({ agentDir, entry, nodePath: "/n" })?.changed).toBe(true);
    expect(existsSync(launcherPath(agentDir))).toBe(true);

    for (const elsewhere of [temp(), join(temp(), ".pi", "npm", "node_modules", "pkg")]) {
      const other = temp();
      const outside = join(elsewhere, "media-host.mjs");
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(outside, "");
      expect(
        registerPersonalLauncher({ agentDir: other, entry: outside, nodePath: "/n" }),
      ).toBeUndefined();
      expect(existsSync(launcherPath(other))).toBe(false);
    }
  });

  test("a symlink out of the personal install is judged by where it really points", () => {
    const agentDir = temp();
    const checkout = temp();
    writeFileSync(join(checkout, "media-host.mjs"), "");
    mkdirSync(join(agentDir, "npm", "node_modules"), { recursive: true });
    symlinkSync(checkout, join(agentDir, "npm", "node_modules", "pkg"), "dir");
    const entry = join(agentDir, "npm", "node_modules", "pkg", "media-host.mjs");
    expect(registerPersonalLauncher({ agentDir, entry, nodePath: "/n" })).toBeUndefined();
  });

  test("nothing is registered on Windows yet", () => {
    const agentDir = temp();
    const entry = join(agentDir, "npm", "node_modules", "pkg", "media-host.mjs");
    expect(
      registerPersonalLauncher({ agentDir, entry, nodePath: "C:\\n", platform: "win32" }),
    ).toBeUndefined();
  });
});

describe("XDG_RUNTIME_DIR", () => {
  const exists = (path: string) => path === "/run/user/1000";

  test("is filled in on Linux, where an SSH session has none, but only for a real directory", () => {
    const env: NodeJS.ProcessEnv = {};
    ensureRuntimeDir({ env, uid: 1000, platform: "linux", exists });
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1000");

    const missing: NodeJS.ProcessEnv = {};
    ensureRuntimeDir({ env: missing, uid: 1001, platform: "linux", exists });
    expect(missing.XDG_RUNTIME_DIR).toBeUndefined();
  });

  test("never overrides a value or touches other platforms", () => {
    const set: NodeJS.ProcessEnv = { XDG_RUNTIME_DIR: "/custom" };
    ensureRuntimeDir({ env: set, uid: 1000, platform: "linux", exists });
    expect(set.XDG_RUNTIME_DIR).toBe("/custom");
    const mac: NodeJS.ProcessEnv = {};
    ensureRuntimeDir({ env: mac, uid: 1000, platform: "darwin", exists });
    expect(mac).toEqual({});
  });
});

posix("host lock", () => {
  test("a second host gets busy until the first lets go", async () => {
    const path = join(temp(), "lock.sock");
    const first = await acquireHostLock(path);
    await expect(acquireHostLock(path)).rejects.toBeInstanceOf(HostBusyError);
    await expect(acquireHostLock(path)).rejects.toThrow("already using");
    first.close();
    const second = await acquireHostLock(path);
    second.close();
  });

  test("a lock left behind by a host that was killed is taken over", async () => {
    const path = join(temp(), "lock.sock");
    const child = spawn(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`,
    ]);
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(existsSync(path)).toBe(true);
    (await acquireHostLock(path)).close();
  });
});
