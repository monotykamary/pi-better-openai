import type { Readable, Writable } from "node:stream";
import { clampLevel, type LiveMedia, type LiveMediaFactory } from "../media.ts";
import {
  boundedMessage,
  type ClientFrame,
  encodeFrame,
  FrameDecoder,
  type HostFrame,
  LIVE_MEDIA_LEASE_MS,
  parseClientFrame,
  ProtocolError,
} from "./protocol.ts";

export const LEVELS_HIGH_WATER_BYTES = 64 * 1024;
export const MAX_PENDING_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_IN_FLIGHT_REQUESTS = 16;
const FLUSH_TIMEOUT_MS = 250;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;

export interface CompanionOptions {
  /** Protocol frames from the Pi host (the process's stdin). */
  input: Readable;
  /** Protocol frames to the Pi host (the process's stdout); nothing else may be written to it. */
  output: Writable;
  /** Opens the devices. Called only after a valid, version-checked `open` request. */
  createMedia: LiveMediaFactory;
  diagnostics?: (message: string) => void;
  signal?: AbortSignal;
  /** How long closing the media may take before the host gives up and exits anyway. */
  closeTimeoutMs?: number;
  /** This computer's Tailscale node id, announced in `hello` for the Pi host to check. */
  nodeId?: string | undefined;
  /** How long the Pi host may stay silent before the devices are closed. */
  leaseMs?: number | undefined;
}

type Request = Extract<ClientFrame, { type: "request" }>;

function messageOf(cause: unknown): string {
  return boundedMessage(cause instanceof Error ? cause.message : String(cause));
}

/**
 * Runs the media side of a remote live session on the computer with the microphone and speakers.
 * Resolves with the process exit code once the media is closed: 0 when the Pi host ended the
 * session (close frame, EOF or abort), 1 on a protocol violation or a broken connection.
 */
export function runCompanion(options: CompanionOptions): Promise<number> {
  return new Promise((resolve) => new MediaHost(options, resolve).start());
}

class MediaHost {
  readonly #options: CompanionOptions;
  readonly #finish: (code: number) => void;
  readonly #decoder = new FrameDecoder(parseClientFrame);
  readonly #abort = new AbortController();
  readonly #inFlight = new Set<number>();
  #media: LiveMedia | undefined;
  #stopping = false;
  #stopPromise: Promise<number> | undefined;
  #lease: NodeJS.Timeout | undefined;

  constructor(options: CompanionOptions, finish: (code: number) => void) {
    this.#options = options;
    this.#finish = finish;
  }

  start(): void {
    const { input, output, signal } = this.#options;
    output.on("error", (error) => this.#fatal(`Output failed: ${error.message}`, false));
    // A destroyed output closes without an error; nobody is listening any more.
    output.on("close", () => this.#fatal("Output closed.", false));
    input.on("data", (chunk: Buffer) => this.#onData(chunk));
    input.on("end", () => void this.#stop(0));
    input.on("close", () => void this.#stop(0));
    input.on("error", (error) => this.#fatal(`Input failed: ${error.message}`, false));
    if (signal?.aborted) void this.#stop(0);
    else signal?.addEventListener("abort", () => void this.#stop(0), { once: true });
    this.#write({ type: "hello", ...(this.#options.nodeId ? { node: this.#options.nodeId } : {}) });
    this.#touch();
  }

  /** The Pi host pings while it is alive; silence means it is gone, and so is the reason to listen. */
  #touch(): void {
    clearTimeout(this.#lease);
    if (this.#stopping) return;
    this.#lease = setTimeout(
      () => this.#fatal("The Pi host has been silent; closing the microphone."),
      this.#options.leaseMs ?? LIVE_MEDIA_LEASE_MS,
    );
    this.#lease.unref?.();
  }

  #onData(chunk: Buffer): void {
    if (this.#stopping) return;
    this.#touch();
    try {
      for (const frame of this.#decoder.push(chunk)) {
        if (this.#stopping) return;
        this.#handle(frame);
      }
    } catch (cause) {
      this.#fatal(messageOf(cause));
    }
  }

  #handle(frame: ClientFrame): void {
    if (!this.#media) {
      if (frame.type === "close") void this.#stop(0);
      else if (frame.type === "ping") return;
      else if (frame.type === "request" && frame.method === "open") this.#open(frame.id);
      else throw new ProtocolError("The first request must be open.");
      return;
    }
    switch (frame.type) {
      case "request":
        this.#request(frame, this.#media);
        break;
      case "activate":
        this.#control(() => this.#media?.activate());
        break;
      case "mute":
        this.#control(() => this.#media?.setMuted(frame.muted));
        break;
      case "ping":
        break;
      case "close":
        void this.#stop(0);
        break;
    }
  }

  #open(id: number): void {
    try {
      this.#media = this.#options.createMedia(
        {
          onEvent: (payload) => {
            if (payload) this.#write({ type: "event", payload });
          },
          onLevels: (input, output) =>
            this.#write(
              { type: "levels", input: clampLevel(input), output: clampLevel(output) },
              true,
            ),
          onFailure: (message) =>
            this.#write({ type: "failure", message: boundedMessage(message) }),
        },
        this.#abort.signal,
      );
    } catch (cause) {
      this.#write({ type: "response", id, ok: false, error: messageOf(cause) });
      void this.#stop(1);
      return;
    }
    this.#write({ type: "response", id, ok: true });
  }

  #request(frame: Request, media: LiveMedia): void {
    if (frame.method === "open") throw new ProtocolError("The media is already open.");
    if (this.#inFlight.has(frame.id) || this.#inFlight.size >= MAX_IN_FLIGHT_REQUESTS) {
      throw new ProtocolError("Duplicate or too many concurrent requests.");
    }
    this.#inFlight.add(frame.id);
    void this.#call(frame, media).then((response) => {
      this.#inFlight.delete(frame.id);
      this.#write(response);
    });
  }

  async #call(frame: Request, media: LiveMedia): Promise<HostFrame> {
    try {
      switch (frame.method) {
        case "createOffer": {
          const sdp = await media.createOffer();
          if (!sdp) throw new Error("The peer returned no SDP offer.");
          return { type: "response", id: frame.id, ok: true, sdp };
        }
        case "acceptAnswer":
          await media.acceptAnswer(frame.sdp);
          break;
        case "waitForOpen":
          await media.waitForOpen(frame.timeoutMs);
          break;
        case "open":
          throw new ProtocolError("The media is already open.");
      }
      return { type: "response", id: frame.id, ok: true };
    } catch (cause) {
      return { type: "response", id: frame.id, ok: false, error: messageOf(cause) };
    }
  }

  #control(action: () => void): void {
    try {
      action();
    } catch (cause) {
      this.#write({ type: "failure", message: messageOf(cause) });
    }
  }

  #write(frame: HostFrame, lossy = false): void {
    if (this.#stopping) return;
    const { output } = this.#options;
    if (lossy && output.writableLength > LEVELS_HIGH_WATER_BYTES) return;
    if (output.writableLength > MAX_PENDING_OUTPUT_BYTES) {
      this.#fatal("The other computer is not reading live media output.", false);
      return;
    }
    try {
      output.write(encodeFrame(frame));
    } catch (cause) {
      this.#diagnose(`Dropped a ${frame.type} frame: ${messageOf(cause)}`);
    }
  }

  #fatal(message: string, report = true): void {
    if (this.#stopping) return;
    this.#diagnose(message);
    if (report) this.#write({ type: "failure", message: boundedMessage(message) });
    void this.#stop(1);
  }

  #diagnose(message: string): void {
    this.#options.diagnostics?.(message);
  }

  #stop(code: number): Promise<number> {
    this.#stopPromise ??= this.#shutdown(code);
    return this.#stopPromise;
  }

  async #shutdown(code: number): Promise<number> {
    this.#stopping = true;
    clearTimeout(this.#lease);
    this.#abort.abort();
    const { input, output } = this.#options;
    input.destroy();
    const media = this.#media;
    this.#media = undefined;
    let exitCode = code;
    if (media) {
      try {
        await closeWithin(media, this.#options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
      } catch (cause) {
        this.#diagnose(`Closing the media failed: ${messageOf(cause)}`);
        exitCode ||= 1;
      }
    }
    await flush(output);
    this.#finish(exitCode);
    return exitCode;
  }
}

/** A media that cannot close must not keep the process, and so the microphone, alive. */
async function closeWithin(media: LiveMedia, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Closing the media timed out.")), timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([media.close(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Gives queued frames a moment to leave, without ever waiting on a reader that has stopped. */
function flush(output: Writable): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
    timer.unref?.();
    try {
      output.write("", () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}
