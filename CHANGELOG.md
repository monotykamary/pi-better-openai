# Changelog

## 0.3.2

- Allow `/openai-tier ultrafast` directly for OpenAI subscription OAuth on supported Astra/Sol endpoints, without an extra setting or unverified-support warning. Preserve API-key pricing notices and existing model/endpoint restrictions.

## 0.3.1

- Add argument autocomplete for `/openai-tier` and `/openai-decisions`, including live registered classifier suggestions after `use`. Completion does not change settings or call providers.

## 0.3.0

- Add the classifier-only `openai-decisions` provider for API-billed Decisions alongside subscription-authenticated `openai` chat. Use `/login openai-decisions`, `OPENAI_DECISIONS_API_KEY`, or `OPENAI_API_KEY`; native adapters and chat credentials are preserved.
- Remove the legacy `/fast` command and `--fast` flag; use `/openai-tier fast` or `/openai-tier standard`. Existing saved tier settings still load.
- Enable API-key Ultrafast for GPT-6.1 Sol on global, US, and EU Responses endpoints; retain Astra's global/US restriction and subscription-auth safeguards.
- Document generally available OpenAI Decisions and direct `openai/gpt-6-astra` selection, preserving native chat, classifier, and authentication implementations.
- Add regression coverage for Sol Ultrafast eligibility and direct OpenAI model access alongside the legacy Codex provider.
- Upgrade undici to 8.12.2 and pin patched Vite 8.2.4 to address high-severity security advisories.

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
