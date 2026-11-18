import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve("picomatch/package.json"));
const auditScript = resolve("scripts/audit.mjs");
const temporary: string[] = [];
function tempDir() {
  const path = mkdtempSync(join(tmpdir(), "pi-picomatch-security-"));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

// Run potentially exponential regexes in a bounded child, never in Vitest's event loop.
const regressionProbe = `
const assert = require('node:assert/strict');
const pm = require(process.argv[1]);
for (const options of [{}, { maxExtglobRecursion: false }, { capture: true }, { windows: true }]) {
  for (const pattern of ['+(*)', '+(*a)', '*(a*)', '+([ab]*)', '+(*(a))', 'pre+(*a)suffix']) {
    assert.equal(pm.isMatch('a'.repeat(10000) + '!', pattern, options), false, pattern);
    assert.equal(pm.isMatch(pattern, pattern, options), true, 'literalized ' + pattern);
  }
}
assert.equal(pm.isMatch('src/models.test.ts', '**/*.test.ts'), true);
assert.equal(pm.isMatch('src/models.ts', '**/*.test.ts'), false);
assert.equal(pm.isMatch('foofoo', '+(foo)'), true);
assert.equal(pm.isMatch('abab', '+(a|b)'), true);
assert.equal(pm.isMatch('file.ts', '*.{js,ts}'), true);
assert.equal(pm.isMatch('file.ts', '*.?(c|m)ts'), true);
`;

describe("picomatch local security patch", () => {
  test("blocks single-branch repeated-extglob ReDoS without losing normal file matching", () => {
    const result = spawnSync(process.execPath, ["-e", regressionProbe, packageDir], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  test("the unpatched negative control times out on the advisory payload", () => {
    const copy = join(tempDir(), "picomatch");
    cpSync(packageDir, copy, { recursive: true, dereference: true });
    const parser = join(copy, "lib/parse.js");
    const source = readFileSync(parser, "utf8");
    const withoutPatch = source.replace(
      /  \/\/ BEGIN GHSA-fc5q-39xc-vjpf:[\s\S]*?  \/\/ END GHSA-fc5q-39xc-vjpf\n/,
      "",
    );
    expect(withoutPatch).not.toBe(source);
    writeFileSync(parser, withoutPatch);
    const result = spawnSync(
      process.execPath,
      ["-e", `require(process.argv[1]).isMatch('a'.repeat(40) + '!', '+(*a)')`, copy],
      {
        encoding: "utf8",
        timeout: 1000,
      },
    );
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
  });

  test("the audit verifies the installed patch", () => {
    const result = spawnSync(process.execPath, [auditScript, "--verify-only"], {
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("patched picomatch installation");
  });

  test("the audit refuses an unpatched copy, including an extra nested installation", () => {
    const root = tempDir();
    const modules = join(root, "node_modules");
    mkdirSync(modules);
    cpSync(packageDir, join(modules, "picomatch"), { recursive: true, dereference: true });
    const extra = join(modules, "other", "node_modules", "picomatch");
    cpSync(packageDir, extra, { recursive: true, dereference: true });
    writeFileSync(join(extra, "lib", "parse.js"), "// missing the security fix\n");
    const result = spawnSync(process.execPath, [auditScript, "--verify-only"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unverified picomatch security patch");
  });

  test("the audit refuses a missing installation", () => {
    const root = tempDir();
    mkdirSync(join(root, "node_modules"));
    const result = spawnSync(process.execPath, [auditScript, "--verify-only"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No installed picomatch security patch was verified");
  });
});
