#!/usr/bin/env node
// Media host for remote live voice: runs on the computer with the microphone and speakers and
// speaks the stdio protocol in ./protocol.ts. Node cannot strip types from .ts files inside
// node_modules, so the TypeScript is loaded through jiti, the loader Pi itself uses.
import { createJiti } from "jiti";

// stdout carries protocol frames and nothing else; stray logging goes to stderr.
console.log = console.info = console.debug = (...args) => console.error(...args);

const jiti = createJiti(import.meta.url);
const { runCompanion } = await jiti.import("./companion.ts");
const { createLocalMediaFactory } = await jiti.import("../media.ts");
const { loadLiveNative } = await jiti.import("../native.ts");

const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => abort.abort());

const code = await runCompanion({
  input: process.stdin,
  output: process.stdout,
  signal: abort.signal,
  diagnostics: (message) => process.stderr.write(`live media host: ${message}\n`),
  // Loading the modules above touches no device; the native addon loads and the devices open
  // only here, after the Pi host's version-checked `open` request.
  createMedia: (callbacks, signal) => createLocalMediaFactory(loadLiveNative())(callbacks, signal),
});
process.exit(code);
