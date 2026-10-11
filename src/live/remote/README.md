# Remote live media (work in progress)

Building blocks for running the microphone, speakers and native WebRTC peer of `/live` on a
different computer than the one running Pi. **Nothing selects them yet: `/live` always uses local
media, and no platform has been validated with real audio devices.**

## Split

| Pi host (B)                                                                       | Media host (A, has the microphone and speakers)                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| UI, Codex OAuth, DeviceCheck attestation, signaling, sideband WebSocket, Pi turns | `LocalLiveMedia`: capture, the microphone filter, the native WebRTC peer and playback |

`src/live/media.ts` is the seam: `LiveMedia` / `LiveMediaFactory`. The transport creates the media,
negotiates SDP through it and activates it once connected.

## Pieces here

- `protocol.ts`: newline-delimited JSON frames over stdio, version in every frame, byte-bounded
  decoder, strict validation. It carries SDP, control, levels and server events only. There is no
  field for credentials, attestation or audio, and unknown fields are rejected.
- `companion.ts`: the media host loop. It says `hello`, opens devices only after a valid
  version-checked `open`, and closes everything on `close`, EOF, abort or a broken pipe.
- `client.ts`: `createRemoteMediaFactory(spawn)` returns a `LiveMedia` backed by an injected process.
  It checks the host's `hello` before asking it to open anything.
- `media-host.mjs`: the entry to run on the media host. Node cannot strip types from `.ts` files in
  `node_modules`, so it loads the TypeScript through `jiti`.

## Not implemented

Choosing the media host (origin detection), launching it over SSH, pairing and setup, macOS
microphone permission handling, Windows audio sessions, hot-switching between computers, and user
documentation. Each needs real-device validation first.

## Tests

`tests/live-media.test.ts`, `tests/live-transport-media.test.ts`, `tests/live-remote-*.test.ts`. They
use fake capture, peer and streams; none opens a device or touches the network.
