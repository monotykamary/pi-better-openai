#!/usr/bin/env node
// Media host for remote live voice: runs on the computer with the microphone and speakers and
// speaks the stdio protocol in ./protocol.ts. Node cannot strip types from .ts files inside
// node_modules, so the TypeScript is loaded through jiti, the loader Pi itself uses.
//
// `media-host.mjs register` records this Node and entry as the launcher Pi hosts start over SSH.
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// stdout carries protocol frames and nothing else; stray logging goes to stderr.
console.log = console.info = console.debug = (...args) => console.error(...args);

const jiti = createJiti(import.meta.url);
const host = await jiti.import("./host.ts");

if (process.argv[2] === "register") {
  if (process.platform === "win32") {
    console.error("Only a Linux computer can provide the audio for remote live voice for now.");
    process.exit(1);
  }
  const { path } = host.registerLauncher({ entry: fileURLToPath(import.meta.url) });
  process.stdout.write(`${path}\n`);
  process.exit(0);
}

const { runCompanion } = await jiti.import("./companion.ts");
const { selfNodeId } = await jiti.import("./tailscale.ts");
const { createLocalMediaFactory } = await jiti.import("../media.ts");
const { loadLiveNative } = await jiti.import("../native.ts");

// An SSH session has no XDG_RUNTIME_DIR, and without it the audio server cannot be found.
host.ensureRuntimeDir();

// One media host per user. A second one still says hello, then answers `open` with the reason,
// so the Pi host can show it; no device is touched.
let refusal;
let lock;
try {
  lock = await host.acquireHostLock();
} catch (cause) {
  refusal = cause;
}

const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => abort.abort());

const code = await runCompanion({
  input: process.stdin,
  output: process.stdout,
  signal: abort.signal,
  diagnostics: (message) => process.stderr.write(`live media host: ${message}\n`),
  // The Pi host checks this against the computer it expects before it asks for any device.
  nodeId: await selfNodeId(),
  // Loading the modules above touches no device; the native addon loads and the devices open
  // only here, after the Pi host's version-checked `open` request.
  createMedia: (callbacks, signal) => {
    if (refusal) throw refusal;
    return createLocalMediaFactory(loadLiveNative())(callbacks, signal);
  },
});
lock?.close();
process.exit(code);
