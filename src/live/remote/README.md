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
- `auto` inside Herdr reads the server's clients only on a Linux B with `ss`. On macOS, Windows or
  a Linux without `ss` it can only tell that no remote Herdr client exists (then this computer) or
  that one may (then it refuses); see "Where the clients cannot be read". `auto` outside Herdr
  only reads Pi's own SSH variables and works on any B. The Windows process list has not been run
  on a real Windows computer.
- Routing, identity, lock, lease and launcher are covered by tests with fakes; `auto` was also
  run against a real stock Herdr server with a local client and a remote client attached (below).

## Which audio computer

`live.audioHost` decides, and only `auto` looks anything up:

| `live.audioHost`     | `/live` uses                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset, empty         | this computer. Nothing is looked up: no `ss`, no Tailscale, no process is read.                                                                                                  |
| a host               | that SSH host, trusted to be the computer meant: only its `hello` (version) is checked                                                                                           |
| `auto`, not in Herdr | no SSH variables: this computer; `SSH_CONNECTION`: the computer it came from (Tailscale); `SSH_CLIENT`/`SSH_TTY` alone, or tmux/screen/zellij with any SSH variable: **refuses** |
| `auto`, in Herdr     | the one computer attached to the pane's Herdr server; **refuses** when several are attached, or when it cannot tell (below)                                                      |

Inside Herdr (`HERDR_PANE_ID` set) Pi's own `SSH_*` variables are ignored: a pane carries the
environment of the Herdr server, not of whoever is typing. By the computer running Pi:

| B (runs Pi)                                    | `auto` outside Herdr  | `auto` in a Herdr pane                                                                     |
| ---------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| Linux with `ss`                                | as in the table above | reads the server's clients (below): one computer is it, several or unrecognized **refuse** |
| Linux without `ss`, or a pane without a socket | as above              | this computer if no remote Herdr client is running, else **refuses**                       |
| macOS                                          | as above              | this computer if no remote Herdr client is running, else **refuses**                       |
| Windows                                        | as above              | the same, from a PowerShell process list (not yet run on a real Windows)                   |

Outside Herdr nothing depends on the operating system: Pi's own `SSH_CONNECTION` names the computer
(Tailscale looks it up), and no SSH variable means this computer.

1. `ss -x -a -n -p` lists the unix sockets. The server is the process listening on
   `HERDR_SOCKET_PATH`. It also listens on a second socket (`herdr-client.sock` beside it) that
   attached clients use; the API socket only serves one-off commands. A client is the holder of the
   other end of a connection the server accepted on that second socket, which the kernel names by
   inode, so a client of another Herdr session (another server) is never counted.
2. Each client is recognized as one of two things, whatever it is called. Remote: it has an
   `SSH_CONNECTION` in `/proc/<pid>/environ` (a remote-client bridge, run by sshd, has one). Local:
   it has none and its stdin is a terminal (`/proc/<pid>/fd/0` is a `/dev/pts/N` or `/dev/ttyN`; a
   bridge's is a pipe). A client that is neither, such as a redesigned bridge that no longer
   inherits sshd's environment, **refuses** with "Pi can't tell which computer is connected to this
   Herdr", even next to clients that are recognized. An unreadable process refuses; one that exited
   meanwhile is skipped.
3. One origin: it is that computer (`identify`: `tailscale whois`, same Tailscale user, Linux, a
   machine name safe for `ssh`; its media host must announce the same node ID in its `hello`).
4. Several origins (this computer's own client plus a remote one, or two remote computers):
   **refuses**, naming the computers and `live.audioHost`. Several connections from one computer
   (two bridges from the same laptop, or a bridge from this very computer next to its local client)
   are one origin. A computer that cannot be identified counts as another origin, named by address.

### Why several attached computers are a refusal

Herdr tells nothing about who typed, and none of its API is used (stock Herdr has no client list
or origin method). No other signal found separates the typist reliably, so `auto` does not guess:

- The TCP `lastrcv` of a remote client's SSH connection (time since it last sent data) moves on a
  keystroke, but also on the client's keepalive: an idle client sends a 36-byte segment every
  5.05 s, the same size as one keystroke. Matched against when `/live` was asked within 120 ms, an
  idle attached laptop was taken for the typist in 8 of 400 trials (2%), choosing the laptop's
  microphone for someone at the Pi computer; and a lookup delayed beyond the window chose this
  computer for someone at the laptop. That was implemented and removed.
- A local client has no signal at all: the tty's atime moves in 8-second steps by design, and
  `/proc/<pid>/io` mixes keystrokes with the rendering the client reads back. "Nobody remote just
  typed" is not evidence that the local one did.

So with several computers attached, detach the ones you are not using (a screen left attached
counts), or set `live.audioHost` to a host. A reliable signal, such as Herdr reporting which
client sent a pane its last input, would make this refusal unnecessary.

### Where the clients cannot be read

macOS and Windows have no `ss` and no `/proc`, and a Linux can lack `ss` or a pane its
`HERDR_SOCKET_PATH`. There the only evidence is the user's process list (`ps -ww -U <uid> -o
pid=,ppid=,command=`; on Windows all users, from `Get-CimInstance Win32_Process`), and it can only
show whether a remote client may exist. `auto` is this computer if none does, and refuses if one
does or the list cannot be read (an empty list counts as unreadable). It does not try to say which
of the computers is typing: the clients cannot be tied to this pane's server there, and their SSH
connection is not read.

A process is a possible remote client when it is:

- Herdr's program (`herdr`, `herdr.exe`, with any path) running the `remote-client-bridge`
  subcommand, wherever its parent is; or
- a `herdr` that is not its `server` and has `sshd` as an ancestor (a client started by hand in an
  SSH session, or a bridge whose subcommand was renamed); or
- anything else with `remote-client-bridge` in its command and `sshd` as an ancestor (the bridge
  under another binary name).

An `ssh` whose remote command is `herdr remote-client-bridge` is **not** one. That is this
computer's own Herdr client reaching another computer's server (the opposite direction), and a
machine that reaches others, as this PC and the Mac mini do, always has some.

### Limits of recognizing clients

- On Linux with `ss`, nothing depends on a name: a remote client is anything with an
  `SSH_CONNECTION`, a local one anything at a terminal, the rest refuses. What it cannot see is a
  client the Herdr server holds itself, without a process of its own on this computer (a
  redesign that connects to the server over the network): only the local client is visible, and the
  answer is this computer.
- On the process-list route a remote client that is not named like Herdr's bridge and was not
  started by sshd (a `mosh` or Tailscale SSH session, a different tunnel) is not seen, and the
  answer is this computer. A bridge that stays attached after its user left refuses, as on Linux.
  The first is pinned by a test, so a change is noticed.
- A bridge is only known by the subcommand name Herdr 0.9.x uses. If Herdr renames it, Linux with
  `ss` keeps working (nothing there depends on the name); the process-list route would stop seeing
  the bridge itself, and only still sees a bridge or `herdr` that sshd started.

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
- **`auto` only:** the Tailscale CLI on B and A. Inside Herdr, a Linux B also wants the `ss`
  command (iproute2); without it, and on macOS and Windows, only the local-screen case works.

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
- [ ] With `auto` in Herdr: one computer attached uses it; two attached refuse naming both and `live.audioHost`, and work again once one detaches.
- [ ] With `auto` in Herdr on macOS and Windows: only the local screen attached uses this computer's audio; a laptop attached through Herdr refuses and names `live.audioHost`.

| B \ A   | Linux                                 | macOS   | Windows |
| ------- | ------------------------------------- | ------- | ------- |
| Linux   | session, audible reply, delegated run | refused | refused |
| macOS   | muted session, audible reply          | refused | refused |
| Windows | not run                               | refused | refused |

## Pieces

- `route.ts`: the `ssh` command line (host validation) and the media factory a session uses.
- `origin.ts`: what `auto` does (above) and the Tailscale identity of a computer from its SSH connection.
- `clients.ts`: the Herdr clients of a server (`ss` output), `SSH_CONNECTION` and terminal of a process, and the process list with its remote-client rule.
- `client.ts` / `companion.ts` / `protocol.ts`: the Pi-side media, the host loop, and the framing
  (versioned, size-bounded, strictly validated; ping and a 20 s lease so a vanished Pi host
  releases the microphone).
- `host.ts`, `media-host.mjs`: launcher, per-user lock (a Linux abstract socket the kernel frees
  when the host dies), runtime directory; loads the TypeScript through `jiti` because Node refuses
  `.ts` inside `node_modules`.
- `tailscale.ts`: CLI lookup.

Tests use fakes and local subprocesses; none opens a device or reaches the network.
