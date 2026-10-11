import { describe, expect, test } from "vitest";
import {
  boundedMessage,
  type ClientFrame,
  encodeFrame,
  FrameDecoder,
  type HostFrame,
  LIVE_MEDIA_PROTOCOL_VERSION,
  MAX_FAILURE_MESSAGE_LENGTH,
  MAX_FRAME_BYTES,
  parseClientFrame,
  parseHostFrame,
  ProtocolError,
  ProtocolVersionError,
} from "../src/live/remote/protocol.ts";

const CLIENT_FRAMES: ClientFrame[] = [
  { type: "request", id: 1, method: "open" },
  { type: "request", id: 2, method: "createOffer" },
  { type: "request", id: 3, method: "acceptAnswer", sdp: "v=0\r\n" },
  { type: "request", id: 4, method: "waitForOpen" },
  { type: "request", id: 5, method: "waitForOpen", timeoutMs: 15_000 },
  { type: "activate" },
  { type: "mute", muted: true },
  { type: "close" },
];

const HOST_FRAMES: HostFrame[] = [
  { type: "hello" },
  { type: "response", id: 1, ok: true },
  { type: "response", id: 2, ok: true, sdp: "v=0\r\n" },
  { type: "response", id: 3, ok: false, error: "no microphone" },
  { type: "event", payload: '{"type":"session.started"}' },
  { type: "levels", input: 0, output: 1 },
  { type: "failure", message: "ice failed" },
];

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe("live media protocol framing", () => {
  test("round-trips every frame as one versioned JSON line", () => {
    expect(encodeFrame({ type: "mute", muted: true })).toBe(
      `{"v":${LIVE_MEDIA_PROTOCOL_VERSION},"type":"mute","muted":true}\n`,
    );
    for (const frame of CLIENT_FRAMES) {
      expect(new FrameDecoder(parseClientFrame).push(encodeFrame(frame))).toEqual([frame]);
    }
    for (const frame of HOST_FRAMES) {
      expect(new FrameDecoder(parseHostFrame).push(encodeFrame(frame))).toEqual([frame]);
    }
  });

  test("reassembles frames split across chunks, including inside a multibyte character", () => {
    const frames: HostFrame[] = [
      { type: "event", payload: "héllo 🎤" },
      { type: "levels", input: 0.5, output: 0.25 },
    ];
    const bytes = Buffer.from(frames.map(encodeFrame).join("\n\n"));
    const decoder = new FrameDecoder(parseHostFrame);
    const decoded: HostFrame[] = [];
    for (let index = 0; index < bytes.length; index += 3) {
      decoded.push(...decoder.push(bytes.subarray(index, index + 3)));
    }
    expect(decoded).toEqual(frames);
  });

  test("returns several frames from one chunk, skipping blank lines, and holds a partial one back", () => {
    const decoder = new FrameDecoder(parseClientFrame);
    const text = `${encodeFrame({ type: "activate" })}\n${encodeFrame({ type: "close" })}{"v":1,"ty`;
    expect(decoder.push(text)).toEqual([{ type: "activate" }, { type: "close" }]);
    expect(decoder.push('pe":"activate"}\n')).toEqual([{ type: "activate" }]);
  });

  test("accepts a frame of exactly the limit and rejects one byte more", () => {
    const overhead = Buffer.byteLength(encodeFrame({ type: "event", payload: "" })) - 1;
    const fits = encodeFrame({ type: "event", payload: "x".repeat(MAX_FRAME_BYTES - overhead) });
    expect(new FrameDecoder(parseHostFrame).push(fits)).toHaveLength(1);
    const tooBig = { type: "event" as const, payload: "x".repeat(MAX_FRAME_BYTES - overhead + 1) };
    expect(() => encodeFrame(tooBig)).toThrow(ProtocolError);
    expect(() => new FrameDecoder(parseHostFrame).push(line({ v: 1, ...tooBig }) + "\n")).toThrow(
      "too large",
    );
  });

  test("bounds a line that never ends and then refuses further input", () => {
    const decoder = new FrameDecoder(parseHostFrame);
    const chunk = Buffer.alloc(64 * 1024, "a");
    expect(() => {
      for (let sent = 0; sent <= MAX_FRAME_BYTES; sent += chunk.length) decoder.push(chunk);
    }).toThrow("too large");
    expect(() => decoder.push(encodeFrame({ type: "hello" }))).toThrow("too large");
  });

  test("rejects invalid UTF-8", () => {
    expect(() => new FrameDecoder(parseHostFrame).push(Buffer.from([0xc3, 0x28, 0x0a]))).toThrow(
      ProtocolError,
    );
  });
});

describe("live media protocol validation", () => {
  test("rejects anything that is not a JSON object with an integer version", () => {
    for (const text of [
      "not json",
      "[]",
      "null",
      '"hello"',
      "42",
      "{}",
      '{"v":"1","type":"hello"}',
    ]) {
      expect(() => parseHostFrame(text)).toThrow(ProtocolError);
    }
  });

  test("reports a version mismatch distinctly, before looking at anything else", () => {
    for (const parse of [parseHostFrame, parseClientFrame]) {
      let caught: unknown;
      try {
        parse(line({ v: 2, type: "not-a-frame", anything: 1 }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProtocolVersionError);
      expect((caught as ProtocolVersionError).remoteVersion).toBe(2);
      expect((caught as Error).message).toContain("version 2");
    }
  });

  test("rejects unknown frame types and frames that belong to the other side", () => {
    expect(() => parseHostFrame(line({ v: 1, type: "nope" }))).toThrow("Unknown");
    expect(() => parseHostFrame(line({ v: 1, type: "close" }))).toThrow(ProtocolError);
    expect(() => parseClientFrame(line({ v: 1, type: "levels", input: 0, output: 0 }))).toThrow(
      ProtocolError,
    );
    expect(() => parseClientFrame(line({ v: 1, type: "hello" }))).toThrow(ProtocolError);
  });

  test("has no field that could carry credentials, attestation or audio", () => {
    const smuggled: Array<[string, Record<string, unknown>]> = [
      ["accessToken", { type: "request", id: 1, method: "open", accessToken: "secret" }],
      ["attestation", { type: "request", id: 2, method: "createOffer", attestation: "v1.x" }],
      ["authorization", { type: "activate", authorization: "Bearer secret" }],
      ["samples", { type: "mute", muted: true, samples: [0.1] }],
      ["pcm", { type: "close", pcm: "AAAA" }],
    ];
    for (const [name, frame] of smuggled) {
      expect(() => parseClientFrame(line({ v: 1, ...frame })), name).toThrow("Unexpected field");
    }
    expect(() =>
      parseHostFrame(line({ v: 1, type: "levels", input: 0, output: 0, audio: "x" })),
    ).toThrow("Unexpected field");
  });

  test("rejects malformed field values", () => {
    const badClient: unknown[] = [
      { type: "request", id: -1, method: "open" },
      { type: "request", id: 1.5, method: "open" },
      { type: "request", id: "1", method: "open" },
      { type: "request", id: 1, method: "restart" },
      { type: "request", id: 1, method: "open", sdp: "v=0" },
      { type: "request", id: 1, method: "acceptAnswer" },
      { type: "request", id: 1, method: "acceptAnswer", sdp: "" },
      { type: "request", id: 1, method: "waitForOpen", timeoutMs: 0 },
      { type: "request", id: 1, method: "waitForOpen", timeoutMs: 1e9 },
      { type: "request", id: 1, method: "waitForOpen", timeoutMs: 1.5 },
      { type: "mute" },
      { type: "mute", muted: "yes" },
    ];
    for (const frame of badClient) {
      expect(() => parseClientFrame(line({ v: 1, ...(frame as object) })), line(frame)).toThrow(
        ProtocolError,
      );
    }
    const badHost: unknown[] = [
      { type: "levels", input: 1.5, output: 0 },
      { type: "levels", input: 0, output: -0.1 },
      { type: "levels", input: "0", output: 0 },
      { type: "levels", input: 0 },
      { type: "event", payload: "" },
      { type: "event", payload: 7 },
      { type: "response", id: 1 },
      { type: "response", id: 1, ok: false },
      { type: "response", id: 1, ok: false, error: "" },
      { type: "response", id: 1, ok: true, sdp: "" },
      { type: "response", id: 1, ok: true, error: "both" },
      { type: "failure", message: "" },
      { type: "failure", message: "x".repeat(MAX_FAILURE_MESSAGE_LENGTH + 1) },
    ];
    for (const frame of badHost) {
      expect(() => parseHostFrame(line({ v: 1, ...(frame as object) })), line(frame)).toThrow(
        ProtocolError,
      );
    }
  });

  test("never echoes the offending content in an error message", () => {
    try {
      parseHostFrame(line({ v: 1, type: "secret-looking-token-abc123" }));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("abc123");
    }
  });

  test("boundedMessage trims to the failure limit and never returns an empty message", () => {
    expect(boundedMessage("x".repeat(5_000))).toHaveLength(MAX_FAILURE_MESSAGE_LENGTH);
    expect(boundedMessage("")).toBe("Unknown live media failure.");
    expect(boundedMessage("short")).toBe("short");
  });
});

describe("host identity and lease frames", () => {
  test("hello may carry the media host's node id, and nothing else", () => {
    const hello = { type: "hello", node: "nABCDEF123CNTRL" } as const;
    expect(new FrameDecoder(parseHostFrame).push(encodeFrame(hello))).toEqual([hello]);
    for (const bad of [{ node: "" }, { node: 7 }, { node: "x".repeat(257) }, { token: "t" }]) {
      expect(() => parseHostFrame(line({ v: 1, type: "hello", ...bad })), line(bad)).toThrow(
        ProtocolError,
      );
    }
  });

  test("ping is a bare client frame", () => {
    expect(new FrameDecoder(parseClientFrame).push(encodeFrame({ type: "ping" }))).toEqual([
      { type: "ping" },
    ]);
    expect(() => parseClientFrame(line({ v: 1, type: "ping", extra: 1 }))).toThrow(ProtocolError);
  });
});
