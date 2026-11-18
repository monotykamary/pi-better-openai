import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { applySettingToRawConfig, readRawConfig, updateConfig } from "../src/config.ts";

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-settings-atomic-"));
  path = join(directory, "settings.json");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

test.each(["{invalid", "[]", "null"])("leaves malformed settings intact: %s", (raw) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    writeFileSync(path, raw);
    const patch = vi.fn(() => ({ active: true }));
    expect(updateConfig(path, patch)).toBe(false);
    expect(patch).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(readdirSync(directory)).toEqual(["settings.json"]);
  } finally {
    warn.mockRestore();
  }
});

test.skipIf(process.platform === "win32")(
  "replaces the target inode, not its symlink or mode",
  () => {
    const alias = join(directory, "alias.json");
    const oldInode = join(directory, "old.json");
    const raw = '{"usage":{"unknown":1}}';
    writeFileSync(path, raw);
    chmodSync(path, 0o640);
    symlinkSync("settings.json", alias);
    linkSync(path, oldInode);
    writeFileSync(`${path}.unrelated.tmp`, "other writer's temp");

    expect(
      updateConfig(alias, (current) => applySettingToRawConfig(current, "usage.enabled", "false")),
    ).toBe(true);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readRawConfig(alias)).toEqual({ usage: { unknown: 1, enabled: false } });
    expect(readFileSync(oldInode, "utf8")).toBe(raw);
    expect(readFileSync(`${path}.unrelated.tmp`, "utf8")).toBe("other writer's temp");
    expect(readdirSync(directory).sort()).toEqual([
      "alias.json",
      "old.json",
      "settings.json",
      "settings.json.unrelated.tmp",
    ]);
  },
);

test("contending processes merge distinct settings after acquiring the lock", async () => {
  const ready = join(directory, "ready");
  const release = join(directory, "release");
  const contended = join(directory, "contended");
  writeFileSync(path, '{"unknown":1,"usage":{"enabled":true,"unknown":2}}');
  const moduleUrl = new URL("../src/config.ts", import.meta.url).href;
  const source = `
    import { existsSync, writeFileSync } from "node:fs";
    import { applySettingToRawConfig, updateConfig } from ${JSON.stringify(moduleUrl)};
    const { SETTINGS_PATH: path, READY: ready, RELEASE: release, CONTENDED: contended, ROLE: role } = process.env;
    const wait = Atomics.wait;
    const cell = new Int32Array(new SharedArrayBuffer(4));
    const until = (condition) => {
      const deadline = performance.now() + 5000;
      while (!condition()) {
        if (performance.now() > deadline) throw new Error("Test synchronization timed out");
        wait(cell, 0, 0, 10);
      }
    };
    if (role === "contender") {
      // Signal after the actual EEXIST, then pause this retry until the holder publishes.
      Atomics.wait = (...args) => {
        writeFileSync(contended, "");
        until(() => !existsSync(path + ".lock"));
        return wait(...args);
      };
    }
    const saved = updateConfig(path, (raw) => {
      if (role === "holder") {
        writeFileSync(ready, "");
        until(() => existsSync(release));
      }
      return applySettingToRawConfig(raw, role === "holder" ? "usage.enabled" : "usage.showResetTimes", "false");
    });
    if (!saved) process.exitCode = 1;
  `;
  const run = (role: string) =>
    new Promise<Error | null>((done) => {
      execFile(
        "bun",
        ["--eval", source],
        {
          timeout: 8000,
          env: {
            PATH: process.env.PATH,
            SETTINGS_PATH: path,
            READY: ready,
            RELEASE: release,
            CONTENDED: contended,
            ROLE: role,
          },
        },
        (error) => done(error),
      );
    });
  const holder = run("holder");
  let contender: Promise<Error | null> | undefined;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 2000 });
    expect(updateConfig(path, (raw) => ({ ...raw, stolen: true }))).toBe(false);
    contender = run("contender");
    await vi.waitFor(() => expect(existsSync(contended)).toBe(true), { timeout: 2000 });
    expect(existsSync(`${path}.lock`)).toBe(true);
    expect(readRawConfig(path)).toEqual({ unknown: 1, usage: { enabled: true, unknown: 2 } });
  } finally {
    warn.mockRestore();
    writeFileSync(release, "");
    const [holderError, contenderError] = await Promise.all([holder, contender]);
    expect(holderError).toBeNull();
    if (contender) expect(contenderError).toBeNull();
  }
  expect(readRawConfig(path)).toEqual({
    unknown: 1,
    usage: { enabled: false, unknown: 2, showResetTimes: false },
  });
  expect(existsSync(`${path}.lock`)).toBe(false);
}, 10_000);
