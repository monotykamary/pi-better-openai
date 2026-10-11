# Remote live voice: developer notes

User-facing setup is in the package [README](../../../README.md#remote-audio-experimental). These notes
cover how the pieces fit and how to try them.

`/live` can run its audio on a different computer than Pi does. The Pi host (**B**) keeps the UI,
Codex OAuth, DeviceCheck attestation, signaling, the sideband WebSocket and the Pi turns. The audio
computer (**A**) runs capture, the microphone filter, the native WebRTC peer and playback
(`LocalLiveMedia`), started by B over `ssh`.

Only SDP, control messages, levels and server events cross the SSH connection. There is no field
for credentials, attestation or audio, and unknown fields are rejected.

## Status

- **A is Linux only** (PipeWire or PulseAudio). A Mac or Windows PC that is reached by `audioHost`
  answers `open` with "Only a Linux computer can provide the audio for remote live voice for now."; one
  found through Tailscale is refused before it is contacted.
- Run by hand with real devices: Linux B to Linux A (muted session, audible reply, a delegated tool
  run, teardown, a second session) and macOS B to Linux A (including DeviceCheck attestation, which
  only exists on macOS). Real human speech through the remote microphone is not yet verified.
- Routing, identity, lock, lease and launcher are covered by tests with fakes.
- Windows as B needs Herdr's CLI route for the automatic detection, which is untested.

## Which audio computer

| Condition                                                                        | `/live` uses                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `live.audioHost` is set                                                          | that SSH host, whatever else is true                  |
| Herdr reports `pane_last_input` and a local client typed in the pane             | this computer                                         |
| ... and an SSH client typed, identified on the tailnet as another Linux computer | that computer, over SSH                               |
| ... and the client disconnected, nothing was typed, or it cannot be identified   | **refuses**, with the reason (never a guessed device) |
| Herdr is in the environment but fails to answer (not a missing capability)       | **refuses**, with the reason                          |
| Anything else: no Herdr, Herdr answers without `pane_last_input`, SSH variables  | this computer, exactly as before this feature         |

The choice is made every time a session starts, including a queued one. Setting `audioHost` wins
even over a Herdr that says the user is local: the setting is an explicit choice and the simplest
rule to explain, and clearing it goes back to detection. A host named in the settings is trusted to
be the computer meant, so only its `hello` (protocol version) is checked. Detection compares more: it
asks `tailscale whois` about the SSH connection Herdr reports, requires the same Tailscale user as B,
and requires the media host to announce the same node ID in its `hello` before B asks it to open a
device.

## One-time setup

- **A:** the package installed through Pi's personal settings (`pi install npm:…` or
  `pi install git:…`). Starting Pi once writes the launcher `~/.pi/agent/live-host/media-host`
  (B always looks in the default agent dir, so a custom `PI_CODING_AGENT_DIR` on A is not supported).
  It records the absolute Node path, because SSH sessions rarely have Node on `PATH`. Copies loaded with
  `-e`, from a project, or from a path never write it. `XDG_RUNTIME_DIR` is filled in when SSH leaves
  it unset.
- **B to A:** `ssh <host>` must work without prompts (keys, or Tailscale SSH). New host keys are
  accepted automatically (`StrictHostKeyChecking=accept-new`); a changed key is refused. A userspace
  Tailscale needs a `Host` entry with a `ProxyCommand tailscale nc %h %p`.
- **Automatic detection only:** the Tailscale CLI on both computers, and a Herdr that reports
  `pane_last_input` in its `ping` capabilities.

## Trying a checkout without touching your settings

```bash
# A: record this checkout as the launcher (replaces the one the personal install wrote, until Pi
# next starts there with the personal install)
node <checkout>/src/live/remote/media-host.mjs register
# B: load only this checkout, with "live": { "audioHost": "<A>" } in its config
pi -ne -e <checkout>
```

## Manual acceptance checklist

Run per pair (B, A). Mark a cell only after doing it.

- [ ] `/live` with `audioHost` set: A's microphone is hot and B's is not; the reply plays on A.
- [ ] A coding request runs its tools on B and the result is spoken on A.
- [ ] Mute and unmute from the panel; stopping with `/live` releases A's microphone.
- [ ] Killing B's Pi, or dropping the network, releases A's microphone within ~20 s.
- [ ] A second `/live` from another B while one runs is refused as busy; it works after the first stops.
- [ ] A bad host name or a Mac/Windows `audioHost` fails with a readable reason and opens no device.
- [ ] With detection: typing from B locally uses B's microphone; reconnecting from another computer switches on the next start.

| B \ A   | Linux                                 | macOS   | Windows |
| ------- | ------------------------------------- | ------- | ------- |
| Linux   | session, audible reply, delegated run | refused | refused |
| macOS   | muted session, audible reply          | refused | refused |
| Windows | not run                               | refused | refused |

## Pieces

- `route.ts`: the `ssh` command line (host validation) and the media factory a session uses.
- `origin.ts`: the optional Herdr lookup (raw socket, or the CLI on Windows) and Tailscale identity.
- `client.ts` / `companion.ts` / `protocol.ts`: the Pi-side media, the host loop, and the framing
  (versioned, size-bounded, strictly validated; ping and a 20 s lease so a vanished Pi host
  releases the microphone).
- `host.ts`, `media-host.mjs`: launcher, per-user lock (a Linux abstract socket the kernel frees
  when the host dies), runtime directory; loads the TypeScript through `jiti` because Node refuses
  `.ts` inside `node_modules`.
- `tailscale.ts`: CLI lookup.

Tests use fakes and local subprocesses; none opens a device or reaches the network.
