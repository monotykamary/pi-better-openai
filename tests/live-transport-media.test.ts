import { beforeEach, describe, expect, test, vi } from "vitest";
import type { LiveMedia, LiveMediaCallbacks } from "../src/live/media.ts";
import type { LiveNativeBindings } from "../src/live/native.ts";
import { CodexLiveTransport } from "../src/live/transport.ts";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  attestation: vi.fn(),
  sockets: [] as unknown[],
}));

vi.mock("undici", () => ({
  fetch: mocks.fetch,
  ProxyAgent: class {
    close = async () => undefined;
  },
}));

vi.mock("../src/live/attestation.ts", () => ({ generateCodexAttestation: mocks.attestation }));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    send = vi.fn();
    close = vi.fn(() => {
      this.readyState = 3;
    });
    terminate = vi.fn();
    constructor() {
      super();
      mocks.sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }
  }
  return { default: FakeWebSocket };
});

const SECRET = "secret-access-token";
const native = {
  AudioCapture: class {},
  LiveWebRtcPeer: class {
    constructor() {
      throw new Error("the default local peer must not be built when media is injected");
    }
  },
  deviceCheckGenerateToken: vi.fn(),
  __ompInstallTokioRuntime: vi.fn(),
} as unknown as LiveNativeBindings;

function fakeMedia() {
  const calls: Array<[string, ...unknown[]]> = [];
  let callbacks: LiveMediaCallbacks | undefined;
  let signal: AbortSignal | undefined;
  const media: LiveMedia = {
    createOffer: vi.fn(async () => {
      calls.push(["createOffer"]);
      return "offer-sdp";
    }),
    acceptAnswer: vi.fn(async (sdp: string) => void calls.push(["acceptAnswer", sdp])),
    waitForOpen: vi.fn(async () => void calls.push(["waitForOpen"])),
    activate: vi.fn(() => void calls.push(["activate"])),
    setMuted: vi.fn((muted: boolean) => void calls.push(["setMuted", muted])),
    close: vi.fn(async () => void calls.push(["close"])),
  };
  const createMedia = vi.fn((next: LiveMediaCallbacks, nextSignal?: AbortSignal) => {
    callbacks = next;
    signal = nextSignal;
    calls.push(["create"]);
    return media;
  });
  return { media, createMedia, calls, callbacks: () => callbacks!, signal: () => signal };
}

function makeTransport(media: ReturnType<typeof fakeMedia>) {
  const callbacks = { onEvent: vi.fn(), onLevels: vi.fn() };
  const transport = new CodexLiveTransport({
    getCredentials: async () => ({ accessToken: SECRET, accountId: "acct_test" }),
    sessionId: "pi-session",
    instructions: "be brief",
    voice: "vale",
    callbacks,
    native,
    createMedia: media.createMedia,
  });
  return { transport, callbacks };
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.attestation.mockReset();
  mocks.sockets.length = 0;
  mocks.attestation.mockResolvedValue("host-attestation");
  mocks.fetch.mockImplementation(
    async () =>
      new Response("answer-sdp", {
        status: 201,
        headers: { location: "https://api.openai.com/v1/live/rtc_call-1" },
      }),
  );
});

describe("CodexLiveTransport media seam", () => {
  test("creates the media synchronously on connect, then negotiates and activates it once connected", async () => {
    const media = fakeMedia();
    const { transport } = makeTransport(media);

    const connecting = transport.connect();
    expect(media.createMedia).toHaveBeenCalledOnce();
    expect(media.calls).toEqual([["create"], ["setMuted", false], ["createOffer"]]);
    expect(media.signal()).toBeInstanceOf(AbortSignal);

    await connecting;
    expect(media.calls).toEqual([
      ["create"],
      ["setMuted", false],
      ["createOffer"],
      ["acceptAnswer", "answer-sdp"],
      ["waitForOpen"],
      ["activate"],
    ]);
    await transport.close();
  });

  test("keeps credentials and attestation on the host: the media only sees SDP", async () => {
    const media = fakeMedia();
    const { transport } = makeTransport(media);
    await transport.connect();

    expect(mocks.attestation).toHaveBeenCalledExactlyOnceWith(native);
    const [url, init] = mocks.fetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain("/codex/realtime/calls");
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(init.headers["x-oai-attestation"]).toBe("host-attestation");

    const everythingTheMediaSaw = JSON.stringify([
      media.createMedia.mock.calls.map(([callbacks]) => Object.keys(callbacks)),
      media.calls,
    ]);
    expect(everythingTheMediaSaw).not.toContain(SECRET);
    expect(everythingTheMediaSaw).not.toContain("host-attestation");
    expect(everythingTheMediaSaw).not.toContain("acct_test");
    await transport.close();
  });

  test("applies a mute chosen before or during negotiation", async () => {
    const media = fakeMedia();
    const { transport } = makeTransport(media);
    transport.setMuted(true);
    await transport.connect();
    expect(media.calls).toContainEqual(["setMuted", true]);
    transport.setMuted(false);
    expect(media.media.setMuted).toHaveBeenLastCalledWith(false);
    await transport.close();
  });

  test("routes peer events, levels and failures to the session callbacks", async () => {
    const media = fakeMedia();
    const { transport, callbacks } = makeTransport(media);
    await transport.connect();
    // The sideband is open, so only errors may arrive through the media event channel.
    media.callbacks().onEvent('{"type":"session.started"}');
    expect(callbacks.onEvent).not.toHaveBeenCalled();

    media.callbacks().onLevels(0.25, 0.75);
    expect(callbacks.onLevels).toHaveBeenCalledExactlyOnceWith(0.25, 0.75);
    media.callbacks().onLevels(Number.NaN, 2);
    expect(callbacks.onLevels).toHaveBeenLastCalledWith(0, 1);

    media.callbacks().onFailure("microphone lost");
    media.callbacks().onFailure("second failure is not repeated");
    expect(callbacks.onEvent).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      message: "microphone lost",
    });
    await transport.close();
  });

  test("closes the media on close, goes quiet afterwards, and surfaces a close error once", async () => {
    const media = fakeMedia();
    const { transport, callbacks } = makeTransport(media);
    await transport.connect();
    vi.mocked(media.media.close).mockRejectedValueOnce(new Error("capture stop failed"));

    await expect(transport.close()).rejects.toThrow("capture stop failed");
    await expect(transport.close()).rejects.toThrow("capture stop failed");
    expect(media.media.close).toHaveBeenCalledOnce();
    media.callbacks().onLevels(0.5, 0.5);
    media.callbacks().onFailure("late");
    expect(callbacks.onLevels).not.toHaveBeenCalled();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
  });

  test("closes the media and rethrows the original cause when signaling fails", async () => {
    const media = fakeMedia();
    const { transport } = makeTransport(media);
    mocks.fetch.mockResolvedValueOnce(new Response("nope", { status: 500, statusText: "boom" }));

    await expect(transport.connect()).rejects.toThrow("Codex live signaling failed (500)");
    expect(media.media.close).toHaveBeenCalledOnce();
    expect(media.media.activate).not.toHaveBeenCalled();
  });

  test("aborting the session signal closes the media without an unhandled rejection", async () => {
    const media = fakeMedia();
    const controller = new AbortController();
    const transport = new CodexLiveTransport({
      getCredentials: async () => ({ accessToken: SECRET, accountId: "acct_test" }),
      sessionId: "pi-session",
      instructions: "",
      voice: "vale",
      callbacks: { onEvent: vi.fn(), onLevels: vi.fn() },
      native,
      signal: controller.signal,
      createMedia: media.createMedia,
    });
    await transport.connect();
    vi.mocked(media.media.close).mockRejectedValueOnce(new Error("capture stop failed"));
    controller.abort();
    await vi.waitFor(() => expect(media.media.close).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
