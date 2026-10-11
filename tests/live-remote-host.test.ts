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

  test.each([
    ["npm", ["npm", "node_modules", "@monotykamary", "pi-better-openai"]],
    ["git", ["git", "github.com", "monotykamary", "pi-better-openai"]],
  ])("a personal %s install keeps it fresh", (_kind, parts) => {
    const agentDir = temp();
    const entry = join(agentDir, ...parts, "src", "live", "remote", "media-host.mjs");
    mkdirSync(join(entry, ".."), { recursive: true });
    writeFileSync(entry, "");
    expect(registerPersonalLauncher({ agentDir, entry, nodePath: "/n" })?.changed).toBe(true);
    expect(existsSync(launcherPath(agentDir))).toBe(true);
  });

  test("a checkout, project copy or -e path never writes it", () => {
    for (const parts of [
      [],
      [".pi", "npm", "node_modules", "pkg"],
      [".pi", "git", "github.com", "o", "r"],
    ]) {
      const other = temp();
      const outside = join(temp(), ...parts, "media-host.mjs");
      mkdirSync(join(outside, ".."), { recursive: true });
      writeFileSync(outside, "");
      expect(
        registerPersonalLauncher({ agentDir: other, entry: outside, nodePath: "/n" }),
      ).toBeUndefined();
      expect(existsSync(launcherPath(other))).toBe(false);
    }
  });

  test.each([
    ["npm", ["npm", "node_modules"]],
    ["git", ["git", "github.com", "monotykamary"]],
  ])(
    "a symlink out of the personal %s install is judged by where it really points",
    (_kind, parts) => {
      const agentDir = temp();
      const checkout = temp();
      writeFileSync(join(checkout, "media-host.mjs"), "");
      mkdirSync(join(agentDir, ...parts), { recursive: true });
      symlinkSync(checkout, join(agentDir, ...parts, "pkg"), "dir");
      const entry = join(agentDir, ...parts, "pkg", "media-host.mjs");
      expect(registerPersonalLauncher({ agentDir, entry, nodePath: "/n" })).toBeUndefined();
    },
  );

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

describe.skipIf(process.platform !== "linux")("host lock", () => {
  const name = () => join(temp(), "lock");

  test("a second host gets busy until the first lets go", async () => {
    const lock = name();
    const first = await acquireHostLock(lock);
    await expect(acquireHostLock(lock)).rejects.toBeInstanceOf(HostBusyError);
    await expect(acquireHostLock(lock)).rejects.toThrow("already using");
    first.close();
    const second = await acquireHostLock(lock);
    second.close();
  });

  test("the lock is held by the kernel: nothing is left on disk to go stale", async () => {
    const lock = name();
    const first = await acquireHostLock(lock);
    expect(existsSync(lock)).toBe(false);
    first.close();
  });

  test("a host that was killed frees the lock", async () => {
    const lock = name();
    const child = spawn(process.execPath, [
      "-e",
      `require("node:net").createServer().listen("\\0" + ${JSON.stringify(lock)}, () => console.log("up"))`,
    ]);
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    await expect(acquireHostLock(lock)).rejects.toBeInstanceOf(HostBusyError);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    (await acquireHostLock(lock)).close();
  });

  test("starting together after a crash admits exactly one host", async () => {
    const lock = name();
    // What an earlier version left behind after a crash: a socket file nobody listens on.
    const stale = spawn(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(lock)}, () => console.log("up"))`,
    ]);
    await new Promise<void>((resolve) => stale.stdout.once("data", () => resolve()));
    stale.kill("SIGKILL");
    await new Promise((resolve) => stale.once("exit", resolve));
    expect(existsSync(lock)).toBe(true);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireHostLock(lock)),
    );
    const held = results.filter((result) => result.status === "fulfilled");
    expect(held).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(HostBusyError);
    }
    for (const result of held) result.value.close();
    expect(existsSync(lock)).toBe(true);
  });
});

test("only Linux can hold the lock yet, and says so rather than claiming busy", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const refusal = acquireHostLock("any", platform);
    await expect(refusal).rejects.toThrow(
      "Only a Linux computer can provide the audio for remote live voice for now.",
    );
    await expect(refusal).rejects.not.toBeInstanceOf(HostBusyError);
  }
});
