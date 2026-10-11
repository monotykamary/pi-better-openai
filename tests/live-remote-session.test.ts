import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { createRemoteMediaFactory, type RemoteMediaProcess } from "../src/live/remote/client.ts";
import {
  LEVELS_HIGH_WATER_BYTES,
  MAX_PENDING_OUTPUT_BYTES,
  runCompanion,
} from "../src/live/remote/companion.ts";
import {
  type ClientFrame,
  encodeFrame,
  FrameDecoder,
  type HostFrame,
  MAX_FRAME_BYTES,
  parseClientFrame,
  parseHostFrame,
} from "../src/live/remote/protocol.ts";
import {
  createLocalMediaFactory,
  type LiveMedia,
  type LiveMediaCallbacks,
  microphoneLevel,
} from "../src/live/media.ts";
import type { LiveNativeBindings } from "../src/live/native.ts";

function fakeMedia() {
  let callbacks!: LiveMediaCallbacks;
  const calls: Array<[string, ...unknown[]]> = [];
  const media: LiveMedia = {
    createOffer: vi.fn(async () => (calls.push(["createOffer"]), "offer-sdp")),
    acceptAnswer: vi.fn(async (sdp: string) => void calls.push(["acceptAnswer", sdp])),
    waitForOpen: vi.fn(async (timeoutMs?: number) => void calls.push(["waitForOpen", timeoutMs])),
    activate: vi.fn(() => void calls.push(["activate"])),
    setMuted: vi.fn((muted: boolean) => void calls.push(["setMuted", muted])),
    close: vi.fn(async () => void calls.push(["close"])),
  };
  const createMedia = vi.fn((next: LiveMediaCallbacks, signal?: AbortSignal) => {
    callbacks = next;
    calls.push(["create", signal instanceof AbortSignal]);
    return media;
  });
  return { media, createMedia, calls, callbacks: () => callbacks };
}

function startHost(
  options: {
    createMedia?: ReturnType<typeof fakeMedia>["createMedia"];
    output?: Writable;
    closeTimeoutMs?: number;
    nodeId?: string;
    leaseMs?: number;
  } = {},
) {
  const input = new PassThrough();
  const output = options.output ?? new PassThrough();
  const frames: HostFrame[] = [];
  const decoder = new FrameDecoder(parseHostFrame);
  output.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
  const fake = fakeMedia();
  const createMedia = options.createMedia ?? fake.createMedia;
  const diagnostics = vi.fn();
  const abort = new AbortController();
  const done = runCompanion({
    input,
    output,
    createMedia,
    diagnostics,
    signal: abort.signal,
    closeTimeoutMs: options.closeTimeoutMs,
    nodeId: options.nodeId,
    leaseMs: options.leaseMs,
  });
  return {
    input,
    output,
    frames,
    fake,
    createMedia,
    diagnostics,
    abort,
    done,
    send: (frame: ClientFrame) => input.write(encodeFrame(frame)),
    open: async () => {
      input.write(encodeFrame({ type: "request", id: 1, method: "open" }));
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "response", id: 1, ok: true }));
    },
  };
}

describe("runCompanion (media host)", () => {
  test("says hello first and opens nothing until asked", async () => {
    const host = startHost();
    await vi.waitFor(() => expect(host.frames).toEqual([{ type: "hello" }]));
    expect(host.createMedia).not.toHaveBeenCalled();
    host.input.end();
    await expect(host.done).resolves.toBe(0);
    expect(host.createMedia).not.toHaveBeenCalled();
  });

  test("says which computer it is when it knows", async () => {
    const host = startHost({ nodeId: "nABC123" });
    await vi.waitFor(() => expect(host.frames).toEqual([{ type: "hello", node: "nABC123" }]));
    host.input.end();
    await expect(host.done).resolves.toBe(0);
  });

  test("closes the media and ends when the Pi host goes silent, and pings keep it alive", async () => {
    const host = startHost({ leaseMs: 120 });
    await host.open();
    for (let beat = 0; beat < 5; beat += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      host.send({ type: "ping" });
    }
    expect(host.fake.media.close).not.toHaveBeenCalled();
    await expect(host.done).resolves.toBe(1);
    expect(host.fake.media.close).toHaveBeenCalledOnce();
    expect(host.diagnostics).toHaveBeenCalledWith(expect.stringContaining("silent"));
  });

  test("a host that never hears from the Pi host does not wait forever either", async () => {
    const host = startHost({ leaseMs: 60 });
    await expect(host.done).resolves.toBe(1);
    expect(host.createMedia).not.toHaveBeenCalled();
  });

  test("rejects a version mismatch before opening any device", async () => {
    const host = startHost();
    host.input.write('{"v":2,"type":"request","id":1,"method":"open"}\n');
    await expect(host.done).resolves.toBe(1);
    expect(host.createMedia).not.toHaveBeenCalled();
    const failure = host.frames.find((frame) => frame.type === "failure");
    expect(failure).toMatchObject({ message: expect.stringContaining("version 2") });
  });

  test.each([
    ["a non-open first frame", encodeFrame({ type: "activate" })],
    ["a non-open first request", encodeFrame({ type: "request", id: 1, method: "createOffer" })],
    ["garbage", "hello there\n"],
    ["an oversized line", `${"x".repeat(MAX_FRAME_BYTES + 1)}\n`],
    ["unknown fields", '{"v":1,"type":"request","id":1,"method":"open","accessToken":"t"}\n'],
  ])("fails closed on %s without opening devices", async (_name, text) => {
    const host = startHost();
    host.input.write(text);
    await expect(host.done).resolves.toBe(1);
    expect(host.createMedia).not.toHaveBeenCalled();
    expect(host.frames.at(-1)?.type).toBe("failure");
  });

  test("opens once, answers each call, and applies controls while a call is still pending", async () => {
    const host = startHost();
    await host.open();
    expect(host.fake.calls).toEqual([["create", true]]);

    let finishOpen!: () => void;
    vi.mocked(host.fake.media.waitForOpen).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishOpen = resolve)),
    );
    host.send({ type: "request", id: 2, method: "createOffer" });
    host.send({ type: "request", id: 3, method: "acceptAnswer", sdp: "answer-sdp" });
    host.send({ type: "request", id: 4, method: "waitForOpen", timeoutMs: 5_000 });
    host.send({ type: "mute", muted: true });
    host.send({ type: "activate" });
    await vi.waitFor(() => expect(host.fake.calls.at(-1)).toEqual(["activate"]));
    await vi.waitFor(() =>
      expect(host.frames).toContainEqual({ type: "response", id: 3, ok: true }),
    );
    expect(host.frames).toContainEqual({ type: "response", id: 2, ok: true, sdp: "offer-sdp" });
    expect(host.frames).not.toContainEqual(expect.objectContaining({ id: 4 }));
    expect(host.fake.calls).toContainEqual(["acceptAnswer", "answer-sdp"]);
    expect(host.fake.media.waitForOpen).toHaveBeenCalledExactlyOnceWith(5_000);
    expect(host.fake.calls).toContainEqual(["setMuted", true]);

    finishOpen();
    await vi.waitFor(() =>
      expect(host.frames).toContainEqual({ type: "response", id: 4, ok: true }),
    );
    host.input.end();
    await expect(host.done).resolves.toBe(0);
  });

  test("reports a failing call as an error response without ending the session", async () => {
    const host = startHost();
    await host.open();
    vi.mocked(host.fake.media.createOffer).mockRejectedValueOnce(new Error("no encoder"));
    host.send({ type: "request", id: 2, method: "createOffer" });
    await vi.waitFor(() =>
      expect(host.frames).toContainEqual({
        type: "response",
        id: 2,
        ok: false,
        error: "no encoder",
      }),
    );
    host.input.end();
    await expect(host.done).resolves.toBe(0);
  });

  test("answers a failed open with an error and ends", async () => {
    const createMedia = vi.fn(() => {
      throw new Error("microphone unavailable");
    });
    const host = startHost({ createMedia });
    host.send({ type: "request", id: 1, method: "open" });
    await expect(host.done).resolves.toBe(1);
    expect(host.frames).toContainEqual({
      type: "response",
      id: 1,
      ok: false,
      error: "microphone unavailable",
    });
  });

  test("rejects a second open and a duplicate in-flight id, closing the media", async () => {
    const host = startHost();
    await host.open();
    host.send({ type: "request", id: 2, method: "open" });
    await expect(host.done).resolves.toBe(1);
    expect(host.fake.media.close).toHaveBeenCalledOnce();

    const second = startHost();
    await second.open();
    vi.mocked(second.fake.media.waitForOpen).mockImplementation(() => new Promise(() => undefined));
    second.send({ type: "request", id: 5, method: "waitForOpen" });
    second.send({ type: "request", id: 5, method: "waitForOpen" });
    await expect(second.done).resolves.toBe(1);
    expect(second.fake.media.close).toHaveBeenCalledOnce();
  });

  test("forwards media events, levels and failures in order", async () => {
    const host = startHost();
    await host.open();
    const callbacks = host.fake.callbacks();
    callbacks.onEvent('{"type":"a"}');
    callbacks.onLevels(0.5, 0.25);
    callbacks.onEvent('{"type":"b"}');
    callbacks.onFailure("x".repeat(5_000));
    await vi.waitFor(() => expect(host.frames).toHaveLength(6));
    expect(host.frames.slice(2, 5)).toEqual([
      { type: "event", payload: '{"type":"a"}' },
      { type: "levels", input: 0.5, output: 0.25 },
      { type: "event", payload: '{"type":"b"}' },
    ]);
    expect(host.frames[5]).toMatchObject({ type: "failure" });
    expect((host.frames[5] as { message: string }).message).toHaveLength(2_048);
    host.input.end();
    await host.done;
  });

  test("closes the media and ends on a close frame, EOF, abort or a broken output", async () => {
    for (const trigger of ["close", "eof", "abort", "output-error", "output-closed"] as const) {
      const host = startHost();
      await host.open();
      if (trigger === "close") host.send({ type: "close" });
      else if (trigger === "eof") host.input.end();
      else if (trigger === "abort") host.abort.abort();
      else if (trigger === "output-error") host.output.emit("error", new Error("EPIPE"));
      else host.output.destroy();
      const code = await host.done;
      expect(code, trigger).toBe(trigger.startsWith("output") ? 1 : 0);
      expect(host.fake.media.close, trigger).toHaveBeenCalledOnce();
      expect(host.fake.calls.at(-1), trigger).toEqual(["close"]);
      host.fake.callbacks().onEvent("{}");
      host.fake.callbacks().onFailure("late");
    }
  });

  test("still ends when closing the media throws, with a diagnostic and a failing code", async () => {
    const host = startHost();
    await host.open();
    vi.mocked(host.fake.media.close).mockRejectedValueOnce(new Error("device busy"));
    host.send({ type: "close" });
    await expect(host.done).resolves.toBe(1);
    expect(host.diagnostics).toHaveBeenCalledWith(expect.stringContaining("device busy"));
  });

  test("does not wait forever for a media that cannot close, so the process can still exit", async () => {
    const host = startHost({ closeTimeoutMs: 30 });
    await host.open();
    vi.mocked(host.fake.media.close).mockImplementation(() => new Promise(() => undefined));
    host.send({ type: "close" });
    await expect(host.done).resolves.toBe(1);
    expect(host.diagnostics).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  test("sheds levels, then stops, when the other side does not read", async () => {
    const stuck = new Writable({ highWaterMark: 1, write: () => undefined });
    const host = startHost({ output: stuck });
    host.send({ type: "request", id: 1, method: "open" });
    await vi.waitFor(() => expect(host.createMedia).toHaveBeenCalledOnce());
    expect(stuck.writableLength).toBeGreaterThan(0);
    const callbacks = host.fake.callbacks();

    for (let index = 0; index < 5_000; index += 1) callbacks.onLevels(0.5, 0.5);
    expect(stuck.writableLength).toBeLessThan(LEVELS_HIGH_WATER_BYTES + 200);

    const payload = "x".repeat(512 * 1024);
    for (let index = 0; index <= MAX_PENDING_OUTPUT_BYTES / payload.length + 1; index += 1) {
      callbacks.onEvent(payload);
    }
    await expect(host.done).resolves.toBe(1);
    expect(host.fake.media.close).toHaveBeenCalledOnce();
    expect(host.diagnostics).toHaveBeenCalledWith(expect.stringContaining("not reading"));
  });
});

class FakeProcess extends EventEmitter implements RemoteMediaProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined;
  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    queueMicrotask(() => this.exit(null, signal ?? "SIGTERM"));
    return true;
  });
  readonly written: ClientFrame[] = [];

  constructor() {
    super();
    const decoder = new FrameDecoder(parseClientFrame);
    this.stdin.on("data", (chunk: Buffer) => this.written.push(...decoder.push(chunk)));
  }

  host(frame: HostFrame): void {
    this.stdout.write(encodeFrame(frame));
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

const FAST = { handshakeMs: 200, requestMs: 200, closeMs: 100 };

function clientSetup(extra: { expectedNode?: string; pingMs?: number } = {}) {
  const proc = new FakeProcess();
  const callbacks = { onEvent: vi.fn(), onLevels: vi.fn(), onFailure: vi.fn() };
  const spawn = vi.fn(() => proc);
  const abort = new AbortController();
  const media = createRemoteMediaFactory(spawn, { ...FAST, ...extra })(callbacks, abort.signal);
  return { proc, callbacks, spawn, media, abort };
}

/** Answers the open request the way a healthy host does. */
function acceptOpen(proc: FakeProcess): void {
  proc.host({ type: "hello" });
  void vi
    .waitFor(() => expect(proc.written[0]).toMatchObject({ method: "open" }))
    .then(() =>
      proc.host({ type: "response", id: (proc.written[0] as { id: number }).id, ok: true }),
    );
}

describe("RemoteLiveMedia (client)", () => {
  test("spawns at once, waits for hello, and only then asks the host to open", async () => {
    const { proc, spawn, media } = clientSetup();
    expect(spawn).toHaveBeenCalledOnce();
    const offer = media.createOffer();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(proc.written).toEqual([]);

    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(2));
    expect(proc.written[1]).toMatchObject({ type: "request", method: "createOffer" });
    proc.host({
      type: "response",
      id: (proc.written[1] as { id: number }).id,
      ok: true,
      sdp: "v=0",
    });
    await expect(offer).resolves.toBe("v=0");
  });

  test("rejects an incompatible host from its hello, before sending open", async () => {
    const { proc, callbacks, media } = clientSetup();
    const offer = media.createOffer();
    proc.stdout.write('{"v":2,"type":"hello"}\n');
    await expect(offer).rejects.toThrow("version 2");
    expect(proc.written).toEqual([]);
    expect(callbacks.onFailure).toHaveBeenCalledOnce();
    expect(callbacks.onFailure.mock.calls[0]?.[0]).toContain(
      "Update @monotykamary/pi-better-openai",
    );
    expect(proc.kill).toHaveBeenCalled();
  });

  test("asks the host to open only when its node id is the expected computer", async () => {
    const { proc, media } = clientSetup({ expectedNode: "nTYPIST" });
    const offer = media.createOffer();
    offer.catch(() => undefined);
    proc.host({ type: "hello", node: "nTYPIST" });
    await vi.waitFor(() => expect(proc.written[0]).toMatchObject({ method: "open" }));
  });

  test.each([
    ["another computer", { type: "hello", node: "nSOMEONE" } as HostFrame, "not the computer"],
    ["a host that cannot say who it is", { type: "hello" } as HostFrame, "Tailscale must be"],
  ])("never opens devices on %s", async (_name, hello, reason) => {
    const { proc, callbacks, media } = clientSetup({ expectedNode: "nTYPIST" });
    const offer = media.createOffer();
    proc.host(hello);
    await expect(offer).rejects.toThrow(reason);
    expect(proc.written).toEqual([]);
    expect(callbacks.onFailure).toHaveBeenCalledOnce();
    expect(JSON.stringify(callbacks.onFailure.mock.calls)).not.toContain("nSOMEONE");
    expect(proc.kill).toHaveBeenCalled();
  });

  test("pings the host while the session lives and stops when it closes", async () => {
    const { proc, media } = clientSetup({ pingMs: 20 });
    void media.createOffer().catch(() => undefined);
    acceptOpen(proc);
    await vi.waitFor(() =>
      expect(proc.written.filter((frame) => frame.type === "ping").length).toBeGreaterThanOrEqual(
        2,
      ),
    );
    const closing = media.close();
    proc.exit(0);
    await closing;
    const sent = proc.written.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(proc.written).toHaveLength(sent);
  });

  test("fails closed on garbage or a frame before hello", async () => {
    for (const bytes of [
      "Welcome to the host!\n",
      encodeFrame({ type: "levels", input: 0, output: 0 }),
    ]) {
      const { proc, callbacks, media } = clientSetup();
      const offer = media.createOffer();
      proc.stdout.write(bytes);
      await expect(offer).rejects.toThrow();
      expect(callbacks.onFailure).toHaveBeenCalledOnce();
      expect(proc.written).toEqual([]);
    }
  });

  test("keeps notifications sent before the open completes, in order", async () => {
    const { proc, media } = clientSetup();
    media.setMuted(true);
    media.activate();
    media.setMuted(false);
    expect(proc.written).toEqual([]);
    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(4));
    expect(proc.written.slice(1)).toEqual([
      { type: "mute", muted: true },
      { type: "activate" },
      { type: "mute", muted: false },
    ]);
  });

  test("passes events, levels and host failures to the callbacks, isolating throwing ones", async () => {
    const { proc, callbacks } = clientSetup();
    callbacks.onEvent.mockImplementationOnce(() => {
      throw new Error("ui bug");
    });
    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(1));
    proc.host({ type: "event", payload: "one" });
    proc.host({ type: "event", payload: "two" });
    proc.host({ type: "levels", input: 0.1, output: 0.2 });
    proc.host({ type: "failure", message: "microphone lost" });
    proc.host({ type: "failure", message: "again" });
    await vi.waitFor(() => expect(callbacks.onFailure).toHaveBeenCalledOnce());
    expect(callbacks.onEvent.mock.calls.map(([payload]) => payload)).toEqual(["one", "two"]);
    expect(callbacks.onLevels).toHaveBeenCalledExactlyOnceWith(0.1, 0.2);
    expect(callbacks.onFailure).toHaveBeenCalledWith("microphone lost");
  });

  test("an unexpected exit rejects pending calls and reports one failure with the stderr tail", async () => {
    const { proc, callbacks, media } = clientSetup();
    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(1));
    const pending = media.acceptAnswer("answer");
    await vi.waitFor(() => expect(proc.written).toHaveLength(2));
    proc.stderr.write("Error: cannot load native addon\n");
    await new Promise((resolve) => setTimeout(resolve, 10));
    proc.exit(3);
    await expect(pending).rejects.toThrow("exited unexpectedly (code 3)");
    expect(callbacks.onFailure).toHaveBeenCalledOnce();
    expect(callbacks.onFailure.mock.calls[0]?.[0]).toContain("cannot load native addon");
    await expect(media.createOffer()).rejects.toThrow();
  });

  test("a spawn error is a failure, and an unanswered request times out", async () => {
    const failed = clientSetup();
    const offer = failed.media.createOffer();
    failed.proc.emit("error", new Error("spawn ssh ENOENT"));
    await expect(offer).rejects.toThrow("ENOENT");
    expect(failed.callbacks.onFailure).toHaveBeenCalledOnce();

    const slow = clientSetup();
    acceptOpen(slow.proc);
    await vi.waitFor(() => expect(slow.proc.written).toHaveLength(1));
    await expect(slow.media.createOffer()).rejects.toThrow("did not answer createOffer");
    expect(slow.callbacks.onFailure).toHaveBeenCalledOnce();
    expect(slow.proc.kill).toHaveBeenCalled();
  });

  test("a host that never says hello is given up on", async () => {
    const { proc, callbacks, media } = clientSetup();
    await expect(media.createOffer()).rejects.toThrow("did not start");
    expect(callbacks.onFailure).toHaveBeenCalledOnce();
    expect(proc.kill).toHaveBeenCalled();
  });

  test("close asks the host to stop, ends stdin, waits for exit once, and stays quiet", async () => {
    const { proc, callbacks, media } = clientSetup();
    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(1));
    const first = media.close();
    const second = media.close();
    await vi.waitFor(() => expect(proc.written.at(-1)).toEqual({ type: "close" }));
    expect(proc.stdin.writableEnded).toBe(true);
    proc.exit(0);
    await Promise.all([first, second]);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(callbacks.onFailure).not.toHaveBeenCalled();
    await expect(media.createOffer()).rejects.toThrow("closed");
  });

  test("close kills a host that ignores it, and aborting the signal closes too", async () => {
    const stubborn = clientSetup();
    acceptOpen(stubborn.proc);
    await vi.waitFor(() => expect(stubborn.proc.written).toHaveLength(1));
    stubborn.proc.kill.mockImplementation(() => {
      queueMicrotask(() => stubborn.proc.exit(null, "SIGKILL"));
      return true;
    });
    await stubborn.media.close();
    expect(stubborn.proc.kill).toHaveBeenCalledOnce();

    const aborted = clientSetup();
    aborted.abort.abort();
    await vi.waitFor(() => expect(aborted.proc.stdin.writableEnded).toBe(true));
    expect(aborted.proc.written).toEqual([{ type: "close" }]);
    await aborted.media.close();
  });

  test("the host closing its output ends the session even with nothing pending", async () => {
    const { proc, callbacks, media } = clientSetup();
    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(1));
    media.activate();
    await vi.waitFor(() => expect(proc.written).toHaveLength(2));
    proc.stdout.end();
    await vi.waitFor(() => expect(callbacks.onFailure).toHaveBeenCalledOnce());
    expect(callbacks.onFailure.mock.calls[0]?.[0]).toContain("closed its output");
    expect(proc.stdin.writableEnded).toBe(true);
    expect(proc.kill).toHaveBeenCalled();
    await expect(media.createOffer()).rejects.toThrow();
  });

  test("a destroyed host output, which closes without ending, ends the session too", async () => {
    const { proc, callbacks, media } = clientSetup();
    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(1));
    proc.stdout.destroy();
    await vi.waitFor(() => expect(callbacks.onFailure).toHaveBeenCalledOnce());
    expect(proc.stdin.writableEnded).toBe(true);
    expect(proc.kill).toHaveBeenCalled();
    await expect(media.createOffer()).rejects.toThrow();
  });

  test("closing from the failure callback waits for the host to be gone", async () => {
    const { proc, callbacks, media } = clientSetup();
    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(1));
    let exited = false;
    proc.once("exit", () => (exited = true));
    proc.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") queueMicrotask(() => proc.exit(null, "SIGKILL"));
      return true;
    });
    let reentrant: Promise<void> | undefined;
    callbacks.onFailure.mockImplementation(() => {
      reentrant = media.close();
    });
    proc.stdout.write("this is not a protocol frame\n");
    await vi.waitFor(() => expect(reentrant).toBeDefined());
    await reentrant;
    expect(exited).toBe(true);
    expect(proc.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("closing from the failure callback still sees a host that cannot be stopped", async () => {
    const { proc, callbacks, media } = clientSetup();
    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(1));
    proc.kill.mockImplementation(() => true);
    let reentrant: Promise<void> | undefined;
    callbacks.onFailure.mockImplementation(() => {
      reentrant = media.close();
    });
    proc.stdout.write("this is not a protocol frame\n");
    await vi.waitFor(() => expect(reentrant).toBeDefined());
    await expect(reentrant).rejects.toThrow("did not exit");
  });

  test("close escalates to SIGKILL when the host ignores SIGTERM, and waits for the exit", async () => {
    const { proc, media } = clientSetup();
    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(1));
    proc.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") queueMicrotask(() => proc.exit(null, "SIGKILL"));
      return true;
    });
    await media.close();
    expect(proc.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("close rejects, rather than succeeding, when the host cannot be made to exit", async () => {
    const { proc, media } = clientSetup();
    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(1));
    proc.kill.mockImplementation(() => true);
    await expect(media.close()).rejects.toThrow("did not exit");
    expect(proc.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(media.close()).rejects.toThrow("did not exit");
  });

  test("a failure escalates to SIGKILL too, and close then reports the exit", async () => {
    const { proc, callbacks, media } = clientSetup();
    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(1));
    proc.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") queueMicrotask(() => proc.exit(null, "SIGKILL"));
      return true;
    });
    proc.stdout.write("this is not a protocol frame\n");
    await vi.waitFor(() => expect(callbacks.onFailure).toHaveBeenCalledOnce());
    await media.close();
    expect(proc.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("an error event on a running host is not mistaken for its exit", async () => {
    const { proc, media } = clientSetup();
    proc.pid = 4242;
    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(1));
    proc.kill.mockImplementation(() => true);
    proc.emit("error", new Error("kill EPERM"));
    await expect(media.close()).rejects.toThrow("did not exit");
  });

  test("aborting while the host will not exit leaves no unhandled rejection", async () => {
    const { proc, abort } = clientSetup();
    acceptOpen(proc);
    await vi.waitFor(() => expect(proc.written).toHaveLength(1));
    proc.kill.mockImplementation(() => true);
    abort.abort();
    await vi.waitFor(() => expect(proc.kill).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  test("a spawn that throws surfaces from the factory", () => {
    const factory = createRemoteMediaFactory(() => {
      throw new Error("no ssh");
    }, FAST);
    expect(() => factory({ onEvent: vi.fn(), onLevels: vi.fn(), onFailure: vi.fn() })).toThrow(
      "no ssh",
    );
  });
});

function fakeNative() {
  const log: string[] = [];
  let onAudio: (error: Error | null, samples: Float32Array) => void = () => undefined;
  let onPeerEvent: (error: Error | null, payload: string) => void = () => undefined;
  const pushAudio = vi.fn();
  const native = {
    AudioCapture: class {
      constructor(_rate: number, callback: typeof onAudio) {
        onAudio = callback;
        log.push("capture.start");
      }
      stop() {
        log.push("capture.stop");
      }
    },
    LiveWebRtcPeer: class {
      constructor(event: typeof onPeerEvent) {
        onPeerEvent = event;
        log.push("peer.new");
      }
      createOffer = async () => "native-offer";
      acceptAnswer = async () => undefined;
      waitForOpen = async () => undefined;
      pushAudio = pushAudio;
      setMuted = () => undefined;
      close = async () => void log.push("peer.close");
    },
    deviceCheckGenerateToken: vi.fn(),
    __ompInstallTokioRuntime: vi.fn(),
  } as unknown as LiveNativeBindings;
  return {
    native,
    log,
    pushAudio,
    mic: (samples: Float32Array) => onAudio(null, samples),
    peerEvent: (payload: string) => onPeerEvent(null, payload),
  };
}

describe("remote media end to end (client, host and local media over pipes)", () => {
  test("negotiates, relays events and levels in order, and releases the devices on close", async () => {
    const native = fakeNative();
    const proc = new FakeProcess();
    const wire: string[] = [];
    proc.stdin.on("data", (chunk: Buffer) => wire.push(chunk.toString()));
    proc.stdout.on("data", (chunk: Buffer) => wire.push(chunk.toString()));
    const callbacks = { onEvent: vi.fn(), onLevels: vi.fn(), onFailure: vi.fn() };
    const media = createRemoteMediaFactory(() => proc, FAST)(callbacks);
    const hostDone = runCompanion({
      input: proc.stdin,
      output: proc.stdout,
      createMedia: createLocalMediaFactory(native.native),
    }).then((code) => proc.exit(code));
    await expect(media.createOffer()).resolves.toBe("native-offer");
    await media.acceptAnswer("SDP-ANSWER");
    await media.waitForOpen();
    media.activate();

    const loud = new Float32Array([0.9, -0.5, 0.9, -0.5]);
    // Activation travels asynchronously; audio is only forwarded once the host has applied it.
    await vi.waitFor(() => {
      native.mic(loud);
      expect(native.pushAudio).toHaveBeenCalledWith(loud);
    });
    native.peerEvent('{"type":"first"}');
    native.peerEvent('{"type":"second"}');
    await vi.waitFor(() => expect(callbacks.onEvent).toHaveBeenCalledTimes(2));
    expect(callbacks.onEvent.mock.calls.map(([payload]) => payload)).toEqual([
      '{"type":"first"}',
      '{"type":"second"}',
    ]);
    expect(callbacks.onLevels).toHaveBeenCalledWith(microphoneLevel(loud), 0);

    await media.close();
    await hostDone;
    expect(native.log).toEqual(["capture.start", "peer.new", "capture.stop", "peer.close"]);
    expect(callbacks.onFailure).not.toHaveBeenCalled();
    // Only SDP and control cross the wire; raw samples never do.
    const everything = wire.join("");
    expect(everything).toContain("SDP-ANSWER");
    expect(everything).not.toContain("0.9");
    expect(everything).not.toContain("-0.5");
    expect(everything).not.toMatch(/token|attestation|authorization|samples|pcm/i);
  });

  test("a host that cannot start the devices fails the session before any audio flows", async () => {
    const proc = new FakeProcess();
    const callbacks = { onEvent: vi.fn(), onLevels: vi.fn(), onFailure: vi.fn() };
    const media = createRemoteMediaFactory(() => proc, FAST)(callbacks);
    const hostDone = runCompanion({
      input: proc.stdin,
      output: proc.stdout,
      createMedia: () => {
        throw new Error("Unable to load the native addon");
      },
    }).then((code) => proc.exit(code));
    await expect(media.createOffer()).rejects.toThrow("Unable to load the native addon");
    await hostDone;
    await media.close();
  });
});
