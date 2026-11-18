import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// npm has no patched release for this advisory. Exempt it only after checking
// every installed copy against the exact parser produced by our reviewed patch.
const advisory = "GHSA-fc5q-39xc-vjpf";
const patchedParserSha256 = "092b85effbb6277758a353c45066bd68723042bc9de3b3b59fbc76c5c2bdffe2";
const seen = new Set();
let verified = 0;

function verifyTree(directory) {
  const real = realpathSync(directory);
  if (seen.has(real) || !statSync(real).isDirectory()) return;
  seen.add(real);
  const entries = readdirSync(real, { withFileTypes: true });
  if (entries.some((entry) => entry.name === "package.json" && entry.isFile())) {
    const pkg = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
    if (pkg.name === "picomatch") {
      const digest = createHash("sha256")
        .update(readFileSync(join(real, "lib", "parse.js")))
        .digest("hex");
      if (pkg.version !== "4.0.7" || digest !== patchedParserSha256) {
        throw new Error(`Unverified picomatch security patch: ${real}`);
      }
      verified++;
    }
  }
  for (const entry of entries) {
    if (entry.name !== ".bin" && (entry.isDirectory() || entry.isSymbolicLink())) {
      verifyTree(join(real, entry.name));
    }
  }
}

try {
  verifyTree(join(process.cwd(), "node_modules"));
  if (verified === 0) throw new Error("No installed picomatch security patch was verified");
  console.log(`Verified ${verified} patched picomatch installation(s) for ${advisory}.`);
  if (!process.argv.includes("--verify-only")) {
    console.log(
      `Auditing all other advisories; ${advisory} is remediated by the verified local patch.`,
    );
    const result = spawnSync("bun", ["audit", "--audit-level=high", "--ignore", advisory], {
      stdio: "inherit",
      timeout: 120000,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
