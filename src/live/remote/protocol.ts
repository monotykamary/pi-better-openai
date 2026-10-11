/**
 * Wire protocol between the Pi host and a media host on another computer: newline-delimited JSON
 * over stdio, one frame per line, every frame carrying the protocol version.
 *
 * The protocol moves SDP, control, levels and server events only. It has no field for
 * credentials, attestation or audio, and unknown fields are rejected, so none can be added by
 * accident. Errors never repeat the offending content.
 */

export const LIVE_MEDIA_PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_FAILURE_MESSAGE_LENGTH = 2_048;
export const MAX_REQUEST_TIMEOUT_MS = 120_000;
/** The Pi host pings this often; a media host hearing nothing for the lease closes the devices. */
export const LIVE_MEDIA_PING_MS = 5_000;
export const LIVE_MEDIA_LEASE_MS = 20_000;
const MAX_NODE_ID_LENGTH = 256;

export type ClientFrame =
  | { type: "request"; id: number; method: "open" | "createOffer" }
  | { type: "request"; id: number; method: "acceptAnswer"; sdp: string }
  | { type: "request"; id: number; method: "waitForOpen"; timeoutMs?: number }
  | { type: "activate" }
  | { type: "mute"; muted: boolean }
  | { type: "ping" }
  | { type: "close" };

export type HostFrame =
  /** `node` is the media host's own Tailscale node id, so the Pi host can check who answered. */
  | { type: "hello"; node?: string }
  | { type: "response"; id: number; ok: true; sdp?: string }
  | { type: "response"; id: number; ok: false; error: string }
  | { type: "event"; payload: string }
  | { type: "levels"; input: number; output: number }
  | { type: "failure"; message: string };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export class ProtocolVersionError extends ProtocolError {
  readonly remoteVersion: number;

  constructor(remoteVersion: number) {
    super(
      `Live media protocol version ${remoteVersion} is not supported (expected ${LIVE_MEDIA_PROTOCOL_VERSION}). Update @monotykamary/pi-better-openai on both computers.`,
    );
    this.name = "ProtocolVersionError";
    this.remoteVersion = remoteVersion;
  }
}

type Check = (value: unknown) => boolean;
type Shape = { required?: Record<string, Check>; optional?: Record<string, Check> };

const isId: Check = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText: Check = (value) => typeof value === "string" && value.length > 0;
const isMessage: Check = (value) =>
  isText(value) && (value as string).length <= MAX_FAILURE_MESSAGE_LENGTH;
const isLevel: Check = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const isBoolean: Check = (value) => typeof value === "boolean";
const isNodeId: Check = (value) => isText(value) && (value as string).length <= MAX_NODE_ID_LENGTH;
const isTimeout: Check = (value) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= MAX_REQUEST_TIMEOUT_MS;

const CLIENT_SHAPES = new Map<string, Shape>([
  ["activate", {}],
  ["close", {}],
  ["ping", {}],
  ["mute", { required: { muted: isBoolean } }],
]);

const REQUEST_SHAPES = new Map<string, Shape>([
  ["open", {}],
  ["createOffer", {}],
  ["acceptAnswer", { required: { sdp: isText } }],
  ["waitForOpen", { optional: { timeoutMs: isTimeout } }],
]);

const HOST_SHAPES = new Map<string, Shape>([
  ["hello", { optional: { node: isNodeId } }],
  ["event", { required: { payload: isText } }],
  ["levels", { required: { input: isLevel, output: isLevel } }],
  ["failure", { required: { message: isMessage } }],
]);

const RESPONSE_SHAPES = new Map<boolean, Shape>([
  [true, { optional: { sdp: isText } }],
  [false, { required: { error: isMessage } }],
]);

function parseObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("Frame is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError("Frame is not a JSON object.");
  }
  const frame = value as Record<string, unknown>;
  const version = frame.v;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new ProtocolError("Frame has no integer protocol version.");
  }
  if (version !== LIVE_MEDIA_PROTOCOL_VERSION) throw new ProtocolVersionError(version);
  return frame;
}

function validate(
  frame: Record<string, unknown>,
  common: Record<string, Check>,
  shape: Shape | undefined,
): void {
  if (!shape) throw new ProtocolError("Unknown frame type.");
  const fields = { ...common, ...shape.required, ...shape.optional };
  for (const key of Object.keys(frame)) {
    if (key !== "v" && key !== "type" && !Object.hasOwn(fields, key)) {
      throw new ProtocolError("Unexpected field in frame.");
    }
  }
  for (const [key, check] of Object.entries(fields)) {
    const present = Object.hasOwn(frame, key);
    const required = Object.hasOwn(common, key) || Object.hasOwn(shape.required ?? {}, key);
    if (!present && required) throw new ProtocolError(`Frame is missing ${key}.`);
    if (present && !check(frame[key])) throw new ProtocolError(`Frame has an invalid ${key}.`);
  }
}

function withoutVersion<T>(frame: Record<string, unknown>): T {
  const { v: _version, ...rest } = frame;
  return rest as T;
}

export function parseClientFrame(text: string): ClientFrame {
  const frame = parseObject(text);
  const type = typeof frame.type === "string" ? frame.type : "";
  if (type === "request") {
    const method = typeof frame.method === "string" ? frame.method : "";
    validate(frame, { id: isId, method: isText }, REQUEST_SHAPES.get(method));
  } else {
    validate(frame, {}, CLIENT_SHAPES.get(type));
  }
  return withoutVersion<ClientFrame>(frame);
}

export function parseHostFrame(text: string): HostFrame {
  const frame = parseObject(text);
  const type = typeof frame.type === "string" ? frame.type : "";
  if (type === "response") {
    const ok = typeof frame.ok === "boolean" ? frame.ok : undefined;
    validate(
      frame,
      { id: isId, ok: isBoolean },
      ok === undefined ? undefined : RESPONSE_SHAPES.get(ok),
    );
  } else {
    validate(frame, {}, HOST_SHAPES.get(type));
  }
  return withoutVersion<HostFrame>(frame);
}

export function encodeFrame(frame: ClientFrame | HostFrame): string {
  const text = JSON.stringify({ v: LIVE_MEDIA_PROTOCOL_VERSION, ...frame });
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new ProtocolError("Frame is too large.");
  return `${text}\n`;
}

/** Trims a diagnostic so it always fits a `failure` or error `response` frame. */
export function boundedMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "Unknown live media failure.";
  return trimmed.slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Splits a byte stream into frames without ever holding more than one frame's worth of input. */
export class FrameDecoder<T> {
  readonly #parse: (text: string) => T;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #failure: Error | undefined;

  constructor(parse: (text: string) => T) {
    this.#parse = parse;
  }

  push(chunk: Uint8Array | string): T[] {
    if (this.#failure) throw this.#failure;
    try {
      return this.#push(
        typeof chunk === "string"
          ? Buffer.from(chunk)
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    } catch (cause) {
      this.#failure = cause instanceof Error ? cause : new ProtocolError(String(cause));
      throw this.#failure;
    }
  }

  #push(data: Buffer): T[] {
    const frames: T[] = [];
    let start = 0;
    for (;;) {
      const end = data.indexOf(0x0a, start);
      const lineBytes = this.#pendingBytes + (end === -1 ? data.length : end) - start;
      if (lineBytes > MAX_FRAME_BYTES) throw new ProtocolError("Frame is too large.");
      if (end === -1) {
        if (start < data.length) {
          this.#pending.push(Buffer.from(data.subarray(start)));
          this.#pendingBytes = lineBytes;
        }
        return frames;
      }
      const line = Buffer.concat([...this.#pending, data.subarray(start, end)]);
      this.#pending = [];
      this.#pendingBytes = 0;
      start = end + 1;
      let text: string;
      try {
        text = utf8.decode(line);
      } catch {
        throw new ProtocolError("Frame is not valid UTF-8.");
      }
      if (text.trim()) frames.push(this.#parse(text));
    }
  }
}
