import { lstatSync } from "node:fs";

// npm ships the compiled graph; a Git or local checkout can use TypeScript.
// Only a missing entry selects source. Import errors in a build must surface.
const built = lstatSync(new URL("./dist/index.mjs", import.meta.url), { throwIfNoEntry: false });
const implementation = built ? await import("./dist/index.mjs") : await import("./index.ts");

export default implementation.default;
export const _test = implementation._test;
