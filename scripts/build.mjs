import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ["index.ts"],
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22.19",
  // Pi hosts resolve their own peers; runtime and native dependencies stay external.
  packages: "external",
});
