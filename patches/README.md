# Local security patches

## picomatch 4.0.7 — GHSA-fc5q-39xc-vjpf

There is no published fixed version for [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf). The `picomatch@4.0.7` override and Bun `patchedDependencies` apply `picomatch@4.0.7.patch` to every installation used by Vite, Vitest, tinyglobby, and fdir.

The patch makes complex single-branch repeated extglobs fail closed using picomatch's existing literalization path. Patterns such as `+(*)`, `+(*a)`, and `*(a*)` are treated literally instead of generating nested, exponentially backtracking regular expressions. Literal repetition such as `+(foo)`, ordinary file globs, and existing multi-branch behavior remain unchanged. The guard cannot be disabled with `maxExtglobRecursion: false`. This is a deliberate compatibility restriction for these complex repeated patterns, not a complete redesign of the glob engine.

`tests/picomatch-security.test.ts` runs adversarial patterns in deadline-bounded child processes, retains an unpatched negative control, checks ordinary file matching, and verifies that audit fails if an unpatched nested copy is installed.

Run **`bun run audit`** for the release security gate. Before applying the exception for this one advisory, `scripts/audit.mjs` verifies the version and exact SHA-256 of `lib/parse.js` in **every installed picomatch copy**. Missing, altered, or unpatched copies fail closed. All other high-severity advisories remain enabled. Raw `bun audit --audit-level=high` still reports the registry advisory because registry metadata cannot see local source patches; it is not evidence that the patched parser was used.

Remove the patch, override, direct test dependency, and advisory exception together after upgrading to an upstream release that fixes the advisory. Do not simply change the expected hash or ignore another advisory. Re-run the regression suite, full check, and audit after any change.

Upstream source: [picomatch 4.0.7](https://github.com/micromatch/picomatch/tree/4.0.7), MIT, copyright Jon Schlinkert. The patch is included in the npm tarball; the affected dependency is development-only in this package.
