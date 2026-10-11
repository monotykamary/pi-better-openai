import type { Readable, Writable } from "node:stream";
import type { LiveMedia, LiveMediaCallbacks, LiveMediaFactory } from "../media.ts";
import {
  type ClientFrame,
  encodeFrame,
  FrameDecoder,
  type HostFrame,
  LIVE_MEDIA_PING_MS,
  MAX_REQUEST_TIMEOUT_MS,
  parseHostFrame,
} from "./protocol.ts";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_OPEN_WAIT_MS = 60_000;
const STDERR_TAIL_CHARS = 1_024;
// eslint-disable-next-line no-control-regex -- diagnostics from another computer must not carry terminal control characters
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]+/g;

/** The part of a child process the client needs, so tests can supply plain streams. */
export interface RemoteMediaProcess {
  /** Undefined when the process never started. */
  pid?: number | undefined;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface RemoteMediaOptions {
  handshakeMs?: number;
  requestMs?: number;
  closeMs?: number;
  /** How often the host is pinged so it knows this side is alive. */
  pingMs?: number;
  /**
   * The Tailscale node id of the computer being typed on; no device opens on any other host.
   * Unset when the user named the host, which is then trusted.
   */
  expectedNode?: string;
}

type Pending = {
  resolve(sdp: string | undefined): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export function createRemoteMediaFactory(
  spawn: () => RemoteMediaProcess,
  timeouts: RemoteMediaOptions = {},
): LiveMediaFactory {
  return (callbacks, signal) => new RemoteLiveMedia(spawn(), callbacks, timeouts, signal);
}

/**
 * Media that lives in a process on another computer. The process starts on construction, its
 * hello is version-checked before it is asked to open any device, and every failure, exit or
 * abort ends in one failure report and a stopped process.
 */
class RemoteLiveMedia implements LiveMedia {
  readonly #process: RemoteMediaProcess;
  readonly #callbacks: LiveMediaCallbacks;
  readonly #handshakeMs: number;
  readonly #requestMs: number;
  readonly #closeMs: number;
  readonly #pingMs: number;
  readonly #expectedNode: string | undefined;
  readonly #decoder = new FrameDecoder(parseHostFrame);
  readonly #pending = new Map<number, Pending>();
  readonly #ready: Promise<void>;
  readonly #exited: Promise<void>;
  #resolveExited!: () => void;
  #hello!: { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout };
  #helloSeen = false;
  #nextId = 1;
  #closed = false;
  #exitedAlready = false;
  #reported = false;
  #failure = new Error("Live media is closed.");
  #stderrTail = "";
  #stopPromise: Promise<void> | undefined;
  #pinger: NodeJS.Timeout | undefined;

  constructor(
    child: RemoteMediaProcess,
    callbacks: LiveMediaCallbacks,
    timeouts: RemoteMediaOptions,
    signal?: AbortSignal,
  ) {
    this.#process = child;
    this.#callbacks = callbacks;
    this.#handshakeMs = timeouts.handshakeMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#requestMs = timeouts.requestMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#closeMs = timeouts.closeMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#pingMs = timeouts.pingMs ?? LIVE_MEDIA_PING_MS;
    this.#expectedNode = timeouts.expectedNode;
    this.#exited = new Promise((resolve) => (this.#resolveExited = resolve));

    const hello = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.#fail("Live media host did not start in time."),
        this.#handshakeMs,
      );
      timer.unref?.();
      this.#hello = { resolve, reject, timer };
    });
    this.#ready = this.#handshake(hello);
    this.#ready.catch(() => undefined);

    child.stdout.on("data", (chunk: Buffer | string) => this.#onData(chunk));
    child.stdout.on("error", (error) =>
      this.#fail(`Live media host output failed: ${error.message}`),
    );
    // A host that stops talking without exiting would otherwise leave the session open for good.
    // A destroyed stream closes without ending, so both are watched; failing is idempotent.
    const outputGone = () => this.#fail(`Live media host closed its output${this.#tail()}`);
    child.stdout.on("end", outputGone);
    child.stdout.on("close", outputGone);
    child.stdin.on("error", (error) =>
      this.#fail(`Live media host input failed: ${error.message}`),
    );
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.#stderrTail = (this.#stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });
    // Diagnostics are best-effort; an unhandled stream error must not take Pi down.
    child.stderr?.on("error", () => undefined);
    child.once("exit", (code, exitSignal) => this.#onExit(code, exitSignal));
    child.once("error", (error) => {
      // Also emitted when a running process could not be killed, which is not an exit.
      const started = child.pid !== undefined;
      this.#fail(`Live media host ${started ? "failed" : "could not start"}: ${error.message}`);
      if (!started) this.#onExited();
    });
    const closeQuietly = () => void this.close().catch(() => undefined);
    if (signal?.aborted) closeQuietly();
    else signal?.addEventListener("abort", closeQuietly, { once: true });
  }

  async #handshake(hello: Promise<void>): Promise<void> {
    await hello;
    await this.#request("open", (id) => ({ type: "request", id, method: "open" }), this.#requestMs);
  }

  async createOffer(): Promise<string> {
    await this.#ready;
    const sdp = await this.#request(
      "createOffer",
      (id) => ({ type: "request", id, method: "createOffer" }),
      this.#requestMs,
    );
    if (!sdp) throw new Error("Live media host returned no SDP offer.");
    return sdp;
  }

  async acceptAnswer(sdp: string): Promise<void> {
    await this.#ready;
    await this.#request(
      "acceptAnswer",
      (id) => ({ type: "request", id, method: "acceptAnswer", sdp }),
      this.#requestMs,
    );
  }

  async waitForOpen(timeoutMs?: number): Promise<void> {
    await this.#ready;
    const bounded =
      timeoutMs === undefined
        ? undefined
        : Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1, Math.round(timeoutMs)));
    await this.#request(
      "waitForOpen",
      (id) => ({
        type: "request",
        id,
        method: "waitForOpen",
        ...(bounded === undefined ? {} : { timeoutMs: bounded }),
      }),
      (bounded ?? DEFAULT_OPEN_WAIT_MS) + this.#requestMs,
    );
  }

  activate(): void {
    this.#notify({ type: "activate" });
  }

  setMuted(muted: boolean): void {
    this.#notify({ type: "mute", muted });
  }

  /** Resolves once the process has exited; rejects if it could not be made to. */
  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#rejectAll(this.#failure);
      this.#stopPromise = this.#stopProcess(true);
    }
    return this.#stopPromise ?? Promise.resolve();
  }

  /** Asks politely when the session is healthy, then escalates until the process is gone. */
  async #stopProcess(graceful: boolean): Promise<void> {
    if (graceful && !this.#exitedAlready) this.#write({ type: "close" });
    this.#endInput();
    if (graceful && (await this.#exitedWithin(this.#closeMs))) return;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      this.#kill(signal);
      if (await this.#exitedWithin(this.#closeMs)) return;
    }
    throw new Error("Live media host did not exit.");
  }

  #notify(frame: ClientFrame): void {
    void this.#ready.then(
      () => {
        if (!this.#closed) this.#write(frame);
      },
      () => undefined,
    );
  }

  #request(
    label: string,
    build: (id: number) => ClientFrame,
    timeoutMs: number,
  ): Promise<string | undefined> {
    if (this.#closed) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.#fail(`Live media host did not answer ${label} in time.`),
        timeoutMs,
      );
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#write(build(id));
    });
  }

  #write(frame: ClientFrame): void {
    try {
      this.#process.stdin.write(encodeFrame(frame));
    } catch (cause) {
      this.#fail(`Live media host input failed: ${cause instanceof Error ? cause.message : cause}`);
    }
  }

  #onData(chunk: Buffer | string): void {
    if (this.#closed) return;
    try {
      for (const frame of this.#decoder.push(chunk)) {
        this.#onFrame(frame);
        if (this.#closed) return;
      }
    } catch (cause) {
      this.#fail(`${cause instanceof Error ? cause.message : cause}${this.#tail()}`);
    }
  }

  #onFrame(frame: HostFrame): void {
    if (!this.#helloSeen) {
      if (frame.type !== "hello") {
        this.#fail("Live media host sent a frame before its hello.");
        return;
      }
      if (this.#expectedNode !== undefined && frame.node !== this.#expectedNode) {
        // Neither id is reported: a wrong ssh alias must fail without teaching anything.
        this.#fail(
          frame.node === undefined
            ? "Live media host cannot tell which computer it is; Tailscale must be installed and running there."
            : "Live media host is not the computer you are typing from.",
        );
        return;
      }
      this.#helloSeen = true;
      clearTimeout(this.#hello.timer);
      this.#hello.resolve();
      this.#pinger = setInterval(() => this.#write({ type: "ping" }), this.#pingMs);
      this.#pinger.unref?.();
      return;
    }
    switch (frame.type) {
      case "hello":
        this.#fail("Live media host sent a second hello.");
        break;
      case "response":
        this.#settle(frame);
        break;
      case "event":
        this.#isolated(() => this.#callbacks.onEvent(frame.payload));
        break;
      case "levels":
        this.#isolated(() => this.#callbacks.onLevels(frame.input, frame.output));
        break;
      case "failure":
        this.#report(frame.message);
        break;
    }
  }

  #settle(frame: Extract<HostFrame, { type: "response" }>): void {
    const pending = this.#pending.get(frame.id);
    if (!pending) {
      this.#fail("Live media host answered a request that was not asked.");
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.sdp);
    else pending.reject(new Error(frame.error));
  }

  #onExited(): void {
    this.#exitedAlready = true;
    this.#resolveExited();
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#onExited();
    if (this.#closed) return;
    const how = code === null ? `signal ${signal}` : `code ${code}`;
    this.#fail(`Live media host exited unexpectedly (${how})${this.#tail()}`);
  }

  /** Ends the session after a failure: reject everything, report once, stop the process. */
  #fail(message: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = new Error(message);
    this.#rejectAll(this.#failure);
    // Before the callback, which may call close() and must get this promise, not a settled one.
    this.#stopPromise = this.#stopProcess(false);
    this.#stopPromise.catch(() => undefined);
    this.#report(message);
  }

  #report(message: string): void {
    if (this.#reported) return;
    this.#reported = true;
    this.#isolated(() => this.#callbacks.onFailure(message));
  }

  #rejectAll(error: Error): void {
    clearInterval(this.#pinger);
    clearTimeout(this.#hello.timer);
    this.#hello.reject(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #endInput(): void {
    try {
      this.#process.stdin.end();
    } catch {
      // The process may already be gone.
    }
  }

  #kill(signal: NodeJS.Signals): void {
    if (this.#exitedAlready) return;
    try {
      this.#process.kill(signal);
    } catch {
      // The process may already be gone.
    }
  }

  #exitedWithin(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
      void this.#exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  #isolated(action: () => void): void {
    try {
      action();
    } catch {
      // UI callbacks are isolated from the connection's lifecycle.
    }
  }

  #tail(): string {
    const text = this.#stderrTail.replaceAll(CONTROL_CHARACTERS, " ").trim();
    return text ? `: ${text}` : "";
  }
}
