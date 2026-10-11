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
  answers `open` with "Only a Linux computer can provide the audio for remote live voice for now.";
  one found by `auto` is refused before it is contacted.
- Run by hand with real devices: Linux B to Linux A (muted session, audible reply, a delegated tool
  run, teardown, a second session) and macOS B to Linux A (including DeviceCheck attestation, which
  only exists on macOS). Real human speech through the remote microphone is not yet verified.
- `auto` inside Herdr needs a Linux B with `ss`; on macOS or Windows B it refuses and names
  `live.audioHost`. `auto` outside Herdr only reads Pi's own SSH variables and works on any B.
- Routing, identity, lock, lease and launcher are covered by tests with fakes; `auto` was also
  run against a real stock Herdr server with a local client and a remote client attached (below).

## Which audio computer

`live.audioHost` decides, and only `auto` looks anything up:

| `live.audioHost`     | `/live` uses                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset, empty         | this computer. Nothing is looked up: no `ss`, no Tailscale, no process is read.                                                                                                  |
| a host               | that SSH host, trusted to be the computer meant: only its `hello` (version) is checked                                                                                           |
| `auto`, not in Herdr | no SSH variables: this computer; `SSH_CONNECTION`: the computer it came from (Tailscale); `SSH_CLIENT`/`SSH_TTY` alone, or tmux/screen/zellij with any SSH variable: **refuses** |
| `auto`, in Herdr     | the computer of the Herdr client that typed, found as described below                                                                                                            |

Inside Herdr (both `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` set) Pi's own `SSH_*` variables are
ignored: a pane carries the environment of the Herdr server, not of whoever is typing. The
lookup is made when `/live` is asked, not when a queued session gets the floor, because the
keystroke is the evidence.

1. `ss -x -a -n -p` lists the unix sockets. The server is the process listening on
   `HERDR_SOCKET_PATH`. It also listens on a second socket (`herdr-client.sock` beside it) that
   attached clients use; the API socket only serves one-off commands. A client is the holder of the
   other end of a connection the server accepted on that second socket, which the kernel names by
   inode, so a client of another Herdr session (another server) is never counted.
2. Each client's origin is `SSH_CONNECTION` from `/proc/<pid>/environ`: a remote-client bridge
   (`herdr remote-client-bridge`, run by sshd) has it, a local client does not. An unreadable
   process refuses; one that exited meanwhile is skipped.
3. One origin: it is that computer (`identify`: `tailscale whois`, same Tailscale user, Linux, a
   machine name safe for `ssh`; its media host must announce the same node ID in its `hello`).
4. Several origins: for each remote one, `ss -t -i` of its SSH connection gives `lastrcv`, the time
   since the client last sent data. The one whose data arrived within 120 ms of when `/live` was asked
   is the typist. None and a local client exists: this computer. None and no local client, or several:
   **refuses**, naming the computers and `live.audioHost`.

### What the signal is, and what it is not

- Herdr tells nothing about who typed, and none of its API is used (stock Herdr has no client list
  or origin method). The only per-client input signal found is the TCP `lastrcv` of a remote
  client's SSH connection. A local client has none: the tty's atime moves in 8-second steps by
  design, and `/proc/<pid>/io` mixes keystrokes with the rendering the client reads back. So local
  is inferred by exclusion: nobody remote just typed.
- Measured on a real attachment (stock bridge, laptop over Tailscale): an idle client sends one
  36-byte segment every 5.05 s (its keepalive). A keystroke segment is also 36 bytes, so only timing
  separates them. Asked 400 times at random moments with the laptop idle, 8 (2%) landed within the
  window and chose the laptop; asked right after a packet, 8 of 8 chose it. That 2% is the cost of
  an attached but idle remote computer when the user types on the Pi computer itself.
- The other error, a keystroke older than the window when `/live` runs (a stalled Pi or server),
  would pick this computer. The window is wide against the few milliseconds the path normally takes.
- The connection measured is the one the client came in on. A `herdr` started by hand inside an
  SSH session is read the same way, from its own `SSH_CONNECTION`; that case has not been tried.

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
- **`auto` only:** the Tailscale CLI on B and A, and on a Linux B inside Herdr the `ss` command
  (iproute2).

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
- [ ] With `auto` in Herdr and two computers attached: typing on B uses B's microphone, typing on the other uses it; toggling `/live` off and on from the other switches.

| B \ A   | Linux                                 | macOS   | Windows |
| ------- | ------------------------------------- | ------- | ------- |
| Linux   | session, audible reply, delegated run | refused | refused |
| macOS   | muted session, audible reply          | refused | refused |
| Windows | not run                               | refused | refused |

## Pieces

- `route.ts`: the `ssh` command line (host validation) and the media factory a session uses.
- `origin.ts`: what `auto` does (above) and the Tailscale identity of a computer from its SSH connection.
- `clients.ts`: the Herdr clients of a server (`ss` output), `SSH_CONNECTION` of a process, `lastrcv`.
- `client.ts` / `companion.ts` / `protocol.ts`: the Pi-side media, the host loop, and the framing
  (versioned, size-bounded, strictly validated; ping and a 20 s lease so a vanished Pi host
  releases the microphone).
- `host.ts`, `media-host.mjs`: launcher, per-user lock (a Linux abstract socket the kernel frees
  when the host dies), runtime directory; loads the TypeScript through `jiti` because Node refuses
  `.ts` inside `node_modules`.
- `tailscale.ts`: CLI lookup.

Tests use fakes and local subprocesses; none opens a device or reaches the network.
