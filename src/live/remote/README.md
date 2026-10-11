# Remote live voice (experimental)

`/live` on a computer you reach through Herdr (the Pi host, **B**) can use the
microphone and speakers of the computer you are typing from (**A**). Nothing is configured per
session: `/live` asks Herdr who typed in the pane and routes by the answer.

| Pi host (B)                                                                       | Media host (A): the computer you type from                                             |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| UI, Codex OAuth, DeviceCheck attestation, signaling, sideband WebSocket, Pi turns | capture, the microphone filter, the native WebRTC peer and playback (`LocalLiveMedia`) |

Only SDP, control messages, levels and server events cross the SSH connection. There is no field
for credentials, attestation or audio, and unknown fields are rejected.

## Status

- Linux to Linux was run once with real devices (signaling on B, media on A over SSH stdio, the
  microphone muted). Everything added since (routing, identity, lock, lease, launcher) is covered by
  tests with fakes, **not yet by real hardware**.
- A Mac or Windows PC as the microphone computer is refused with "not yet supported". Windows as the
  Pi host needs Herdr's CLI route, which is untested.
- Outside Herdr nothing changes: `/live` uses the local microphone, as before.

## Which microphone

| Herdr says                                                                   | `/live` uses                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| A local client typed in this pane                                            | this computer                                         |
| An SSH client typed, identified on your tailnet as another Linux computer    | that computer, over SSH                               |
| Disconnected, nothing typed, unknown connection, or an unidentifiable client | **refuses**, with the reason (never a guessed device) |
| Herdr without `pane_last_input`, or unreachable                              | **refuses**                                           |
| Not in Herdr, no SSH variables                                               | this computer                                         |
| Not in Herdr, `SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY` set                    | **refuses**                                           |

The choice is made every time a session starts, including a queued one. Toggling `/live` off and on
from another computer switches to it. Identity comes from `tailscale whois` for the SSH connection
Herdr reports; the computer must belong to the same Tailscale user as B, and its media host must
announce the same node ID in its `hello` before B asks it to open a device.

## One-time setup

- **Every computer:** Tailscale CLI, and the package installed through Pi's personal settings.
- **A (microphone):** starting Pi once with the personal install writes the launcher
  `~/.pi/agent/live-host/media-host`. Copies loaded with `-e`, from a project, or from a path
  never write it. A Linux session needs PipeWire or PulseAudio; `XDG_RUNTIME_DIR` is filled in when
  SSH leaves it unset.
- **B to A:** `ssh <tailscale machine name>` must work without prompts (keys, or Tailscale SSH).
  New host keys are accepted automatically (`StrictHostKeyChecking=accept-new`); a changed key is
  refused. Userspace Tailscale (for example Orgo) needs a `Host` entry with a
  `ProxyCommand tailscale nc %h %p`.
- **Herdr:** a version that reports `pane_last_input` in its `ping` capabilities.

## Trying a checkout without touching your settings

```bash
# A: record this checkout as the launcher (replaces the one the personal install wrote, until Pi
# next starts there with the personal install)
node <checkout>/src/live/remote/media-host.mjs register
# B: load only this checkout
pi -ne -e <checkout>
```

## Manual acceptance checklist

Run per pair (B, A), from A through Herdr. Mark a cell only after doing it.

- [ ] `/live` from A: the A microphone is hot and B's is not; the reply plays on A.
- [ ] A coding request runs its tools on B and the result is spoken on A.
- [ ] Mute and unmute from the panel; stopping with `/live` releases A's microphone.
- [ ] Killing B's Pi, or dropping the network, releases A's microphone within ~20 s.
- [ ] A second `/live` from another B while one runs is refused as busy; it works after the first stops.
- [ ] Typing from B locally uses B's microphone; reconnecting from another computer switches on the next start.
- [ ] Type from a Mac or Windows PC: refused with the "not yet supported" reason.
- [ ] No Herdr voice plugin is installed or needed.

| B \ A           | Linux              | macOS   | Windows |
| --------------- | ------------------ | ------- | ------- |
| Linux           | muted session only | refused | refused |
| macOS / Windows | not run            | refused | refused |

## Pieces

- `origin.ts`: Herdr lookup (raw socket, or the CLI on Windows) and Tailscale identity.
- `route.ts`: the `ssh` command line and the media factory a session uses.
- `client.ts` / `companion.ts` / `protocol.ts`: the Pi-side media, the host loop, and the framing
  (versioned, size-bounded, strictly validated; ping and a 20 s lease so a vanished Pi host
  releases the microphone).
- `host.ts`, `media-host.mjs`: launcher, per-user lock, runtime directory; loads the TypeScript
  through `jiti` because Node refuses `.ts` inside `node_modules`.
- `tailscale.ts`: CLI lookup.

Tests use fakes and local subprocesses; none opens a device or reaches the network.
