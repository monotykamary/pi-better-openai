# Agent guidance for pi-better-openai

## Project layout

- `index.ts` registers the pi extension commands, events, settings UI, footer/status rendering, usage polling, and pet lifecycle.
- `src/` contains focused helpers for config, formatting, Codex auth/usage, image generation, and pets.
- `tests/` contains Vitest coverage. Prefer adding targeted tests near the changed behavior.
- `.pi/` is local runtime/config/generated output and is ignored by git.

## Verification

Run the narrowest useful test first, then the full gate before committing:

```bash
bun install --frozen-lockfile
bun run test -- tests/<file>.test.ts
bun run check
```

`bun run check` runs typecheck, lint, format check, and all tests. Do not skip it for code changes.

## Coding conventions

- Use TypeScript ESM imports with `.ts` extensions, matching the existing files.
- Keep runtime behavior in `index.ts` small where possible; put pure helpers in `src/` and test them directly.
- Preserve unknown JSON config fields when writing settings.
- Do not commit `node_modules/`, generated `.pi/` images/config, auth files, or other local machine state.

## Release and publishing

The release workflow publishes to npm from GitHub releases or manual dispatch after `bun install --frozen-lockfile`, `bun run check`, and `bun audit --audit-level=high`. Do not publish, tag, or push release commits unless the maintainer explicitly instructs you to.

## Security reminders

- Never paste, log, or commit token/auth file contents. The auth store is normally `~/.pi/agent/auth.json` or under `PI_CODING_AGENT_DIR`.
- Mask account IDs in diagnostics and examples.
- Keep image input paths workspace-contained and avoid broadening file reads without explicit tests.
- Do not suppress high-severity audit findings without an actual remediation.
