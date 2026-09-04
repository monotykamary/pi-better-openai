# pi-better-openai

A pi extension for OpenAI subscription workflows: fast mode, usage visibility, realtime voice, footer polish, custom Codex pets, and image generation through `openai-codex` auth.

## Install

Requires Node.js 22.19.0 or newer.

Install from GitHub:

```bash
pi install git:github.com/monotykamary/pi-better-openai
```

Or install from npm:

```bash
pi install npm:@monotykamary/pi-better-openai
```

## Authentication

Usage display, image generation, and live voice require pi's `openai-codex` OAuth credentials.

1. In pi, run `/login openai-codex`.
2. Verify subscription usage with `/openai-usage`, or open `/openai-settings` and check **Diagnostics**.
3. The extension reads auth from pi's agent auth store, normally `~/.pi/agent/auth.json`. Do not copy, paste, or commit values from this file.
4. If `PI_CODING_AGENT_DIR` is set, the auth store, global extension config, and global generated-image directory use that agent directory instead of `~/.pi/agent`. A leading `~/` is expanded to your home directory.

## Features

- GPT-6 Astra and Daybreak Blue/Red model fallbacks for the built-in `openai-codex` provider.
- Fast mode for supported OpenAI models, toggled with `/fast` or in `/openai-settings`.
- OpenAI subscription usage display via `/openai-usage` and the footer.
- Interactive settings picker via `/openai-settings`.
- Footer customization for model, thinking, fast mode, usage, and token/cost context.
- OpenAI image generation/editing through the `openai_image` tool and `/openai-image` command.
- Live web search through the `openai_websearch` tool and `/openai-websearch` command, backed by the ChatGPT Codex search backend.
- Codex-backed realtime voice through `/live`, with an animated microphone waveform and coding-task delegation into the active pi session.
- Animated Codex custom pets rendered in the Better OpenAI footer.
- Commands:
  - `/fast` toggles fast mode.
  - `/openai-image <prompt>` generates an image directly.
  - `/openai-websearch <query>` searches the web and inserts the cited answer into the session.
  - `/live` starts or stops realtime voice mode. `Ctrl+Shift+L` is the keyboard toggle.
  - `/pets [help|list|wake [slug]|tuck|select <slug>]` renders or manages custom pets from `${CODEX_HOME:-~/.codex}/pets`.
  - `/openai-usage` shows current OpenAI subscription usage.
  - `/openai-settings` opens settings, diagnostics, and config details.

## Configuration

The extension reads JSON config from two locations:

- Project config: `.pi/extensions/pi-better-openai.json`
- Global config: `$PI_CODING_AGENT_DIR/extensions/pi-better-openai.json`, defaulting to `~/.pi/agent/extensions/pi-better-openai.json`

Project overrides global. Global values fill fields omitted by the project file. Invalid enum values are ignored, and numeric settings are clamped to safe ranges.

Default supported models:

```json
[
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-6-astra",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5"
]
```

Example config:

```json
{
  "persistState": true,
  "desiredActive": false,
  "supportedModels": ["openai/gpt-5.5", "openai-codex/gpt-5.5"],
  "usage": {
    "enabled": true,
    "refreshIntervalMs": 60000,
    "showOnlyOnSubscriptionModels": true,
    "showResetTimes": true
  },
  "footer": {
    "mode": "status"
  },
  "image": {
    "enabled": true,
    "defaultModel": "gpt-image-2",
    "defaultSave": "project",
    "outputFormat": "png",
    "timeoutMs": 180000
  },
  "live": {
    "enabled": true,
    "voice": "sol"
  },
  "pets": {
    "enabled": false,
    "slug": "",
    "placement": "inline-right",
    "state": "idle",
    "thinkingState": "review",
    "toolState": "running",
    "failedToolState": "failed",
    "idleEmotes": true,
    "idleEmoteIntervalMs": 30000,
    "sizeCells": 10
  }
}
```

## Codex model fallbacks

The extension adds `gpt-6-astra`, `gpt-daybreak-blue-latest`, and `gpt-daybreak-red-latest` to the built-in `openai-codex` provider without requiring local `models.json` entries. Existing built-in models remain available, and metadata from pi's live catalog takes precedence when pi publishes an official entry with the same ID.

Daybreak models require separate OpenAI approval and provisioning. pi currently exposes reasoning levels through `max`; Codex's `ultra` automatic-delegation mode is not a pi thinking level.

## Live voice

Run `/live` or press `Ctrl+Shift+L` to open the realtime voice panel. `Ctrl+L` remains pi's model selector, so the extension deliberately uses the shifted chord. While live mode has focus:

- `Space` toggles microphone mute.
- `Escape`, `Ctrl+C`, or `Ctrl+Shift+L` ends the call.
- The waveform reacts to microphone RMS level and the panel footer shows connecting, listening, working, speaking, muted, or error state.
- Streaming speech transcripts stay in the live panel. Coding and repository requests are delegated into the current pi agent session; normal tool and assistant output continues in the transcript, and the final result is spoken back through the live session.

Choose the spoken voice under **Live voice** in `/openai-settings`. Supported values are `arbor`, `breeze`, `cove`, `ember`, `juniper`, `maple`, `sol`, `spruce`, and `vale`.

Live mode requires interactive TUI mode, microphone/speaker access, `openai-codex` OAuth, and one of these native targets: macOS arm64/x64, Linux arm64/x64, or Windows x64. Standard `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` settings are honored for signaling and sideband traffic. Audio/WebRTC uses the MIT-licensed native platform packages from [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi). The adapted implementation is attributed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). On macOS, launchd-managed LocalTerm users should rerun `localterm install` after upgrading LocalTerm and allow its microphone prompt.

The feature uses Codex Desktop's experimental `gpt-live-1-codex`/Quicksilver protocol rather than the public OpenAI Realtime API. Upstream protocol or entitlement changes may temporarily break it.

## Image generation

Use the command for quick generation:

```text
/openai-image draw an otter reading a terminal
```

Agents can call the `openai_image` tool directly. Supported parameters:

- `prompt` (required): pass the user's image wording verbatim.
- `action`: `auto`, `generate`, or `edit`. `auto` uses the edit endpoint when `images` are supplied; explicit `edit` requires images, while explicit `generate` does not accept them.
- `images`: up to five distinct project-local reference/edit image paths. Paths must stay inside the current workspace and point to readable PNG, JPEG, WebP, or GIF files; each file is limited to 20 MB and the combined input to 50 MB.
- `model`: GPT Image model override for the standalone Codex Images API, for example `gpt-image-2`.
- `outputFormat`: `png`, `jpeg`, or `webp`. Codex returns PNG and the extension converts other formats locally.
- `save`: `project`, `global`, `custom`, or `none`.
- `saveDir`: required for `save: "custom"` unless `PI_IMAGE_SAVE_DIR` is set.

Save modes:

- `project` writes to `.pi/generated-images/` in the current project.
- `global` writes to the agent `generated-images` directory, normally `~/.pi/agent/generated-images/` or `$PI_CODING_AGENT_DIR/generated-images/`.
- `custom` writes to `saveDir` or `PI_IMAGE_SAVE_DIR`; relative paths are resolved from the current project.
- `none` returns the image without saving it.

The repository ignores `.pi/`, so generated images and local config should not be committed.

## Web search

Use the command for a quick search:

```text
/openai-websearch latest tanstack query release
```

Agents can call the `openai_websearch` tool directly. Supported parameters:

- `query` (required): the web search query.
- `responseLength`: `short`, `medium`, or `long`. Defaults to the configured value.

The tool returns a synthesized answer plus cited source URLs. It calls the
undocumented `chatgpt.com/backend-api/codex/alpha/search` endpoint with your ChatGPT
OAuth credentials (`openai-codex` login), so it can change or break without notice;
OAuth/API-key-only setups without ChatGPT login are not supported.

Settings under `websearch` in the config file or the `/openai-settings` picker:

- `enabled` (default `true`), `model` (default `gpt-5.6-luna`),
  `reasoningEffort` (default `max`), `responseLength` (default `short`),
  `maxOutputTokens` (default `4096`, clamped to 256-100000), and
  `timeoutMs` (default `25000`, clamped to 5000-120000).

## Codex pets

Codex pets are an OpenAI Codex app feature, so the floating overlay and pet picker are still controlled by Codex (`Settings → Appearance → Pets` or `/pet`). This extension can also render compatible custom pet spritesheets directly in pi's Better OpenAI footer.

```bash
/pets wake          # render the selected pet, or pick one if none is selected
/pets wake <slug>   # render a specific ready pet
/pets select <slug> # select a ready pet without changing visibility
/pets tuck          # hide it
/pets list          # list local custom pets and readiness diagnostics
```

You can also enable **Footer pet** in `/openai-settings`, cycle installed pets with the **Pet** row, preview the selected pet in the footer, and tune placement (`inline-right` by default), idle, thinking/streaming, tool-execution, and any failed-tool animation states, plus random idle emotes and size.

To create a custom pet for the Codex app:

```bash
$skill-installer hatch-pet
```

Then reload Codex skills (`Cmd/Ctrl+K → Force Reload Skills`) and ask:

```text
$hatch-pet create a new pet inspired by pi-better-openai
```

Custom pets should end up in `${CODEX_HOME:-~/.codex}/pets/<pet-name>/` with `pet.json` and `spritesheet.webp`. The spritesheet must be a 1536×1872 atlas arranged as 8 columns by 9 animation rows. Animated footer rendering also requires a terminal image protocol supported by pi. Refresh custom pets in Codex settings and toggle the overlay with `/pet`.

## Attribution

[`pi-better-openai`](https://github.com/mattleong/pi-better-openai) was originally created by [Matt Leong](https://github.com/mattleong). This fork is maintained and published under the `@monotykamary` namespace while retaining Matt's authorship and the original Git history. Realtime voice adaptations have separate attribution in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Screenshots

<!-- Add screenshots here. -->

<img width="983" height="851" alt="Screenshot 2026-04-29 at 11 53 23 PM" src="https://github.com/user-attachments/assets/07a2fb87-ef48-4396-8b12-124825c8d360" />
<img width="1327" height="102" alt="Screenshot 2026-04-29 at 11 34 49 PM" src="https://github.com/user-attachments/assets/22042782-c94e-491d-b5af-095f7f0810f9" />
