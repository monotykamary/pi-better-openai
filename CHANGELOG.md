# Changelog

## Unreleased

- Add experimental remote audio for `/live`: set `live.audioHost` to an SSH host and the realtime session, Codex login, and coding agent stay on the Pi computer while a Linux computer's microphone and speakers carry the audio. Unset by default, which changes nothing.
- Set `live.audioHost` to `auto` to use the computer you are connected from, found from your SSH session or from the clients attached to a stock Herdr server, and named through Tailscale. With several computers attached to the same Herdr, `/live` asks which one you are at (every time, nothing is remembered; Escape starts nothing). It refuses rather than guess when it cannot tell, and where nobody can be asked. On macOS and Windows it uses the local audio when no remote Herdr client is attached, so a synced `auto` keeps plain local `/live` working there.
- Adapt the Tailscale lookup of an SSH connection from [`herdr-codex-voice`](https://github.com/ricardofelixb/herdr-codex-voice) (MIT; see `THIRD_PARTY_NOTICES.md`).

## 0.2.13

- Add a native OpenAI Decisions compatibility classifier for hosts without upstream support, preserving OpenAI chat/auth and deferring to the host adapter when available.
- Support typed predicates, choices, scores, inline images, cancellation, hooks, HTTP retries, and input-only usage accounting through native codemode and pi-fabric.
- Keep the bounded decision tool opt-in, explicitly disable its provider retries, and verify real-host codemode with offline HTTP fixtures.
- Upgrade sharp and pin patched source-map-js/tinypool dependencies to resolve high/critical security advisories.

## 0.2.12

- Validate against Pi 1.0.2, where `openai` supports ChatGPT subscription OAuth and `openai-codex` is labeled legacy; preserve the native OpenAI provider and transport.
- Keep Ultrafast API-only: do not inject it for the new OpenAI subscription login, and retain Standard/Fast behavior.
- Label separately authenticated Codex usage on OpenAI models and warn that it is not verified against the active OpenAI account.
- Clarify that usage, banked resets, images, web search, and live voice still need `/login openai-codex`; never substitute direct-OpenAI OAuth credentials for Codex backend auth.
- Add auth-boundary regressions and an isolated real-host subscription/API-key compatibility probe.

## 0.2.11

- Auto-redeem banked Codex resets ten minutes before expiry instead of one minute, with matching settings and redemption-time displays.
- Preserve the scheduled credit across polling refreshes so the longer lead retains the no-fallback safeguard.
- Extend the shared redemption cooldown to ten minutes and add regression coverage for exact timing and startup inside the redemption window.

## 0.2.10

- Hide disabled image, web search, and decision tools and their prompt guidance, including from pi-fabric capture.
- Apply settings and decision-command toggles immediately without reactivating unrelated tools; retain execution guards and configuration commands.
- Add real Pi regression coverage for startup, live toggles, nested-call availability, and prompt updates.
- Update brace-expansion to 5.0.11 and undici to 8.10.2 to resolve high-severity security advisories.

## 0.2.9

- Validate Pi 1.0.0 with exact development pins and wildcard host peers.
- Exercise real-host registration, startup, and repeated shutdown offline.
- Scope Vitest to owned tests so ignored research checkouts do not enter release checks.

## 0.2.8

- Add GPT-6.1 Sol fallback metadata and Fast support for the GPT-6 model family.
- Add `/openai-tier` for Standard, Fast, and capability-gated API Astra Ultrafast, with explicit pricing warnings, persistence, diagnostics, and footer labels.
- Add opt-in `openai_decide` and `/openai-decisions` through Pi's classifier API, with typed validation, cancellation, safe errors, and usage accounting.
- Include classifier tool usage in footer totals and preserve legacy Fast settings and customized model lists.
- Document remaining native OpenAI Decisions, Codex subscription Ultrafast, and hosted multi-agent integration gates; no undocumented endpoint or chat fallback is assumed.

## 0.2.7

- Validate against Pi 0.99.0, including an offline real-host package-loading probe.
- Declare imported host packages as wildcard peers and pin development dependencies to Pi 0.99.0.
