import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import WebSocket, { type RawData } from "ws";
import type { CodexCredentials } from "../codex-auth.ts";
import { generateCodexAttestation } from "./attestation.ts";
import { loadLiveNative, type LiveNativeBindings, type LiveWebRtcPeerInstance } from "./native.ts";
import {
  buildLiveSessionPayload,
  type LiveClientMessage,
  type LiveServerEvent,
  parseLiveServerEvent,
} from "./protocol.ts";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_CLIENT_VERSION = "0.144.1";
const SIGNALING_URL = `${CODEX_BASE_URL}/codex/realtime/calls?intent=quicksilver&architecture=avas`;
const MAX_ERROR_BODY_LENGTH = 2_048;
const SIDEBAND_CONNECT_ATTEMPTS = 5;
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;
const LIVE_ORIGINATOR = "Codex Desktop";
const LIVE_CALL_ID_PATTERN = /^rtc_[\w-]+$/;

type Lifecycle = "idle" | "connecting" | "connected" | "closing" | "closed";

type LiveSignalingResult = {
  answer: string;
  callId: string;
  credentials: CodexCredentials;
  attestation: string | undefined;
};

export interface LiveTransportCallbacks {
  onEvent(event: LiveServerEvent): void;
  onOutputLevel(level: number): void;
}

export interface LiveTransportOptions {
  getCredentials(signal?: AbortSignal): Promise<CodexCredentials | undefined>;
  sessionId: string;
  instructions: string;
  voice: string;
  callbacks: LiveTransportCallbacks;
  signal?: AbortSignal;
  native?: LiveNativeBindings;
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("Live connection aborted", "AbortError");
}

function boundedErrorBody(body: string, statusText: string): string {
  const normalized = body.trim().replaceAll(/\s+/g, " ");
  if (!normalized) return statusText || "empty response body";
  if (normalized.length <= MAX_ERROR_BODY_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_ERROR_BODY_LENGTH)}…`;
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    timeout.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function parseLiveCallId(location: string | null): string | undefined {
  if (!location) return undefined;
  return location
    .split("?", 1)[0]
    ?.split("/")
    .find((segment) => LIVE_CALL_ID_PATTERN.test(segment));
}

export function buildLiveSidebandUrl(callId: string): string {
  const url = new URL(`https://api.openai.com/v1/live/${encodeURIComponent(callId)}`);
  url.protocol = "wss:";
  return url.toString();
}

export function buildLiveHeaders(
  credentials: CodexCredentials,
  sessionId: string,
  realtimeSessionId: string,
  attestation: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    "OpenAI-Alpha": "quicksilver=v2",
    "User-Agent": `Codex Desktop/${CODEX_CLIENT_VERSION}`,
    "x-session-id": realtimeSessionId,
    originator: LIVE_ORIGINATOR,
    version: CODEX_CLIENT_VERSION,
    "session-id": sessionId,
    "thread-id": sessionId,
    "chatgpt-account-id": credentials.accountId,
  };
  if (attestation) headers["x-oai-attestation"] = attestation;
  return headers;
}

export class CodexLiveTransport {
  readonly #options: LiveTransportOptions;
  readonly #native: LiveNativeBindings;
  readonly #realtimeSessionId = crypto.randomUUID();
  readonly #closeController = new AbortController();
  readonly #operationSignal: AbortSignal;
  readonly #abortListener: () => void;
  #peer: LiveWebRtcPeerInstance | undefined;
  #sideband: WebSocket | undefined;
  #state: Lifecycle = "idle";
  #connectPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #sendTail: Promise<void> = Promise.resolve();
  #muted = false;
  #unexpectedFailureReported = false;

  constructor(options: LiveTransportOptions) {
    this.#options = options;
    this.#native = options.native ?? loadLiveNative();
    this.#operationSignal = options.signal
      ? AbortSignal.any([options.signal, this.#closeController.signal])
      : this.#closeController.signal;
    this.#abortListener = () => {
      void this.close();
    };
    if (!options.signal?.aborted) {
      options.signal?.addEventListener("abort", this.#abortListener, { once: true });
    }
  }

  connect(): Promise<void> {
    if (this.#state === "connected") return Promise.resolve();
    if (this.#connectPromise) return this.#connectPromise;
    if (this.#state === "closing" || this.#state === "closed") {
      return Promise.reject(new Error("Live transport is closed."));
    }
    if (this.#operationSignal.aborted) return Promise.reject(abortReason(this.#operationSignal));
    this.#state = "connecting";
    const operation = this.#connect().catch(async (cause) => {
      await this.close();
      throw cause;
    });
    this.#connectPromise = operation;
    return operation;
  }

  async #connect(): Promise<void> {
    const peer = new this.#native.LiveWebRtcPeer(
      (error, payload) => {
        if (error) this.#handlePeerFailure(error.message);
        else this.#handleServerEvent(payload);
      },
      (error, level) => {
        if (error) this.#handlePeerFailure(error.message);
        else this.#handleOutputLevel(level);
      },
      (error, message) => this.#handlePeerFailure(error?.message ?? message),
    );
    this.#peer = peer;
    const offer = await peer.createOffer();
    if (this.#state !== "connecting") throw abortReason(this.#operationSignal);
    const signaling = await this.#signal(offer);
    await peer.acceptAnswer(signaling.answer);
    peer.setMuted(this.#muted);
    await peer.waitForOpen();
    if (this.#state !== "connecting") throw abortReason(this.#operationSignal);
    await this.#connectSideband(signaling.callId, signaling.credentials, signaling.attestation);
    if (this.#state !== "connecting") throw abortReason(this.#operationSignal);
    this.#state = "connected";
  }

  async #signal(offer: string): Promise<LiveSignalingResult> {
    const credentials = await this.#options.getCredentials(this.#operationSignal);
    if (!credentials) {
      throw new Error("Missing openai-codex OAuth credentials. Run /login openai-codex.");
    }
    const attestation = await generateCodexAttestation(this.#native);
    const headers = buildLiveHeaders(
      credentials,
      this.#options.sessionId,
      this.#realtimeSessionId,
      attestation,
    );
    const proxyUrl = getProxyForUrl(SIGNALING_URL);
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
    try {
      const response = await undiciFetch(SIGNALING_URL, {
        method: "POST",
        headers: {
          ...headers,
          Accept: "*/*",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sdp: offer,
          session: buildLiveSessionPayload(this.#options.instructions, this.#options.voice),
        }),
        signal: this.#operationSignal,
        ...(dispatcher ? { dispatcher } : {}),
      });
      const responseBody = await response.text();
      if (!response.ok) {
        const detail = boundedErrorBody(responseBody, response.statusText);
        throw new Error(`Codex live signaling failed (${response.status}): ${detail}`);
      }
      if (!responseBody.trim()) {
        throw new Error("Codex live signaling returned an empty SDP answer.");
      }
      const callId = parseLiveCallId(response.headers.get("location"));
      if (!callId) throw new Error("Codex live signaling returned no valid call ID.");
      return { answer: responseBody, callId, credentials, attestation };
    } finally {
      await dispatcher?.close();
    }
  }

  async #connectSideband(
    callId: string,
    credentials: CodexCredentials,
    attestation: string | undefined,
  ): Promise<void> {
    let failure = new Error("Codex live sideband connection failed.");
    for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt += 1) {
      try {
        await this.#openSideband(callId, credentials, attestation);
        return;
      } catch (cause) {
        failure = errorFrom(cause);
        if (this.#operationSignal.aborted) throw abortReason(this.#operationSignal);
        if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) {
          await wait(200 * 2 ** attempt, this.#operationSignal);
        }
      }
    }
    throw failure;
  }

  #openSideband(
    callId: string,
    credentials: CodexCredentials,
    attestation: string | undefined,
  ): Promise<void> {
    const url = buildLiveSidebandUrl(callId);
    const proxyUrl = getProxyForUrl(url);
    const socket = new WebSocket(url, {
      headers: buildLiveHeaders(
        credentials,
        this.#options.sessionId,
        this.#realtimeSessionId,
        attestation,
      ),
      ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
    });
    return new Promise((resolve, reject) => {
      let opened = false;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const cleanupConnect = () => {
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
        this.#operationSignal.removeEventListener("abort", onAbort);
      };
      const rejectConnect = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupConnect();
        reject(error);
      };
      const onAbort = () => {
        socket.close(1000, "aborted");
        rejectConnect(abortReason(this.#operationSignal));
      };

      socket.once("open", () => {
        if (settled) {
          socket.close(1000, "stale");
          return;
        }
        opened = true;
        settled = true;
        cleanupConnect();
        this.#sideband = socket;
        resolve();
      });
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          this.#reportFailure("Codex live sideband returned an unexpected binary frame.");
          return;
        }
        this.#handleSidebandEvent(data.toString());
      });
      socket.on("error", (cause) => {
        const detail = cause.message ? `: ${cause.message}` : "";
        if (!opened) {
          rejectConnect(new Error(`Codex live sideband connection failed${detail}`));
          socket.terminate();
          return;
        }
        this.#reportFailure(`Codex live sideband failed${detail}`);
      });
      socket.on("close", (code, reason) => {
        if (!opened) {
          rejectConnect(new Error(`Codex live sideband closed before connecting (${code}).`));
          return;
        }
        if (this.#sideband !== socket) return;
        this.#sideband = undefined;
        if (this.#state === "connecting" || this.#state === "connected") {
          const detail = reason.length > 0 ? `: ${reason.toString()}` : "";
          this.#reportFailure(`Codex live sideband closed (${code})${detail}`);
        }
      });

      if (this.#operationSignal.aborted) {
        onAbort();
      } else {
        this.#operationSignal.addEventListener("abort", onAbort, { once: true });
        timeout = setTimeout(() => {
          socket.close(1000, "connect timeout");
          rejectConnect(new Error("Codex live sideband connection timed out."));
        }, SIDEBAND_CONNECT_TIMEOUT_MS);
        timeout.unref?.();
      }
    });
  }

  #handleSidebandEvent(payload: string): void {
    if (this.#state === "closing" || this.#state === "closed") return;
    const event = parseLiveServerEvent(payload);
    if (!event) return;
    try {
      this.#options.callbacks.onEvent(event);
    } catch {
      // UI callbacks are isolated from the transport lifecycle.
    }
  }

  #handleServerEvent(payload: string): void {
    if (this.#state === "closing" || this.#state === "closed") return;
    const event = parseLiveServerEvent(payload);
    if (!event || (this.#sideband?.readyState === WebSocket.OPEN && event.type !== "error")) return;
    try {
      this.#options.callbacks.onEvent(event);
    } catch {
      // UI callbacks are isolated from the transport lifecycle.
    }
  }

  #handleOutputLevel(level: number): void {
    if (this.#state !== "connected" || !Number.isFinite(level)) return;
    try {
      this.#options.callbacks.onOutputLevel(Math.min(1, Math.max(0, level)));
    } catch {
      // UI callbacks are isolated from the transport lifecycle.
    }
  }

  #handlePeerFailure(message: string): void {
    this.#reportFailure(message);
  }

  #reportFailure(message: string): void {
    if (
      (this.#state !== "connecting" && this.#state !== "connected") ||
      this.#unexpectedFailureReported
    ) {
      return;
    }
    this.#unexpectedFailureReported = true;
    try {
      this.#options.callbacks.onEvent({ type: "error", message });
    } catch {
      // UI callbacks are isolated from the transport lifecycle.
    }
  }

  send(message: LiveClientMessage): Promise<void> {
    const operation = this.#sendTail.then(() => {
      if (this.#state !== "connected") throw new Error("Live transport is not connected.");
      const sideband = this.#sideband;
      if (!sideband || sideband.readyState !== WebSocket.OPEN) {
        throw new Error("Codex live sideband is not connected.");
      }
      sideband.send(JSON.stringify(message));
    });
    this.#sendTail = operation.catch(() => undefined);
    return operation;
  }

  pushAudio(samples: Float32Array): void {
    if (this.#state !== "connected" || this.#muted || samples.length === 0) return;
    this.#peer?.pushAudio(samples);
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (this.#state === "connected") this.#peer?.setMuted(muted);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#state = "closing";
    this.#closeController.abort(new DOMException("Live transport closed", "AbortError"));
    const operation = this.#close();
    this.#closePromise = operation;
    return operation;
  }

  async #close(): Promise<void> {
    this.#options.signal?.removeEventListener("abort", this.#abortListener);
    const sideband = this.#sideband;
    const peer = this.#peer;
    this.#sideband = undefined;
    this.#peer = undefined;
    if (
      sideband &&
      (sideband.readyState === WebSocket.OPEN || sideband.readyState === WebSocket.CONNECTING)
    ) {
      sideband.close(1000, "done");
    }
    if (peer) {
      try {
        await peer.close();
      } catch {
        // Closing is best-effort after a terminal transport failure.
      }
    }
    this.#state = "closed";
  }
}
