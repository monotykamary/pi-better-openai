import { describe, expect, test, vi } from "vitest";
import { createLocalMediaFactory, LocalLiveMedia, microphoneLevel } from "../src/live/media.ts";
import type { LiveNativeBindings } from "../src/live/native.ts";

type CaptureCallback = (error: Error | null, samples: Float32Array) => void;

function setup(options: { failPeerConstruction?: boolean } = {}) {
  const calls: string[] = [];
  let onAudio: CaptureCallback = () => undefined;
  let sampleRate = 0;
  let onPeerEvent: (error: Error | null, payload: string) => void = () => undefined;
  let onPeerLevel: (error: Error | null, level: number) => void = () => undefined;
  let onPeerFailure: (error: Error | null, message: string) => void = () => undefined;
  const stopCapture = vi.fn(() => void calls.push("capture.stop"));
  const peer = {
    createOffer: vi.fn(async () => "offer"),
    acceptAnswer: vi.fn(async () => undefined),
    waitForOpen: vi.fn(async () => undefined),
    pushAudio: vi.fn(),
    setMuted: vi.fn(),
    close: vi.fn(async () => void calls.push("peer.close")),
  };
  const native = {
    AudioCapture: class {
      constructor(rate: number, callback: CaptureCallback) {
        sampleRate = rate;
        onAudio = callback;
        calls.push("capture.start");
      }
      stop = stopCapture;
    },
    LiveWebRtcPeer: class {
      constructor(
        onEvent: typeof onPeerEvent,
        onLevel: typeof onPeerLevel,
        onFailure: typeof onPeerFailure,
      ) {
        if (options.failPeerConstruction) throw new Error("peer unavailable");
        onPeerEvent = onEvent;
        onPeerLevel = onLevel;
        onPeerFailure = onFailure;
        calls.push("peer.new");
        return peer;
      }
    },
    deviceCheckGenerateToken: vi.fn(),
    __ompInstallTokioRuntime: vi.fn(),
  } as unknown as LiveNativeBindings;
  const callbacks = { onEvent: vi.fn(), onLevels: vi.fn(), onFailure: vi.fn() };
  return {
    native,
    callbacks,
    peer,
    calls,
    stopCapture,
    create: () => new LocalLiveMedia(native, callbacks),
    mic: (samples: Float32Array) => onAudio(null, samples),
    micError: (error: Error) => onAudio(error, new Float32Array()),
    peerEvent: (payload: string) => onPeerEvent(null, payload),
    peerLevel: (level: number) => onPeerLevel(null, level),
    peerFailure: (message: string) => onPeerFailure(null, message),
    sampleRate: () => sampleRate,
  };
}

const QUIET = new Float32Array([0.1, -0.1, 0.1, -0.1]);
const LOUD = new Float32Array([0.8, -0.8, 0.8, -0.8]);

describe("LocalLiveMedia", () => {
  test("starts 16 kHz capture and the peer as soon as it is created", () => {
    const harness = setup();
    harness.create();
    expect(harness.sampleRate()).toBe(16_000);
    expect(harness.calls).toEqual(["capture.start", "peer.new"]);
  });

  test("stops capture again when the peer cannot be created", () => {
    const harness = setup({ failPeerConstruction: true });
    expect(() => harness.create()).toThrow("peer unavailable");
    expect(harness.stopCapture).toHaveBeenCalledOnce();
  });

  test("delegates offer, answer and open to the peer", async () => {
    const harness = setup();
    const media = harness.create();
    await expect(media.createOffer()).resolves.toBe("offer");
    await media.acceptAnswer("answer");
    await media.waitForOpen(1_000);
    expect(harness.peer.acceptAnswer).toHaveBeenCalledWith("answer");
    expect(harness.peer.waitForOpen).toHaveBeenCalledWith(1_000);
  });

  test("measures the microphone before activation but only forwards it afterwards", () => {
    const harness = setup();
    const media = harness.create();
    harness.mic(LOUD);
    expect(harness.callbacks.onLevels).toHaveBeenCalledWith(microphoneLevel(LOUD), 0);
    expect(harness.peer.pushAudio).not.toHaveBeenCalled();

    media.activate();
    harness.mic(LOUD);
    expect(harness.peer.pushAudio).toHaveBeenCalledExactlyOnceWith(LOUD);
  });

  test("never forwards empty chunks", () => {
    const harness = setup();
    harness.create().activate();
    harness.mic(new Float32Array());
    expect(harness.peer.pushAudio).not.toHaveBeenCalled();
  });

  test("suppresses likely speaker echo but lets a louder voice barge in", () => {
    const harness = setup();
    harness.create().activate();
    harness.peerLevel(0.5);
    expect(harness.callbacks.onLevels).toHaveBeenLastCalledWith(0, 0.5);

    harness.mic(QUIET);
    expect(harness.peer.pushAudio).not.toHaveBeenCalled();
    harness.mic(LOUD);
    expect(harness.peer.pushAudio).toHaveBeenCalledExactlyOnceWith(LOUD);
  });

  test("ignores output levels before activation and non-finite or out-of-range values", () => {
    const harness = setup();
    const media = harness.create();
    harness.peerLevel(0.9);
    expect(harness.callbacks.onLevels).not.toHaveBeenCalled();

    media.activate();
    harness.peerLevel(Number.NaN);
    expect(harness.callbacks.onLevels).not.toHaveBeenCalled();
    harness.peerLevel(7);
    expect(harness.callbacks.onLevels).toHaveBeenLastCalledWith(0, 1);
  });

  test("honors mute: no levels or audio, and the peer is muted only once the answer is accepted", async () => {
    const harness = setup();
    const media = harness.create();
    media.activate();
    harness.mic(LOUD);
    harness.callbacks.onLevels.mockClear();
    harness.peer.pushAudio.mockClear();

    media.setMuted(true);
    expect(harness.peer.setMuted).not.toHaveBeenCalled();
    harness.mic(LOUD);
    expect(harness.peer.pushAudio).not.toHaveBeenCalled();
    expect(harness.callbacks.onLevels).not.toHaveBeenCalled();

    await media.acceptAnswer("answer");
    expect(harness.peer.setMuted).toHaveBeenLastCalledWith(true);
    media.setMuted(false);
    expect(harness.peer.setMuted).toHaveBeenLastCalledWith(false);
    harness.mic(LOUD);
    // Mute must not leave a stale input level behind for output-level updates.
    expect(harness.callbacks.onLevels).toHaveBeenLastCalledWith(microphoneLevel(LOUD), 0);
  });

  test("reports a stale input level of zero after mute when output levels arrive", () => {
    const harness = setup();
    const media = harness.create();
    media.activate();
    harness.mic(LOUD);
    media.setMuted(true);
    harness.peerLevel(0.3);
    expect(harness.callbacks.onLevels).toHaveBeenLastCalledWith(0, 0.3);
  });

  test("fails once on privacy-filtered zero-only microphone input and then ignores audio", () => {
    const harness = setup();
    const media = harness.create();
    media.activate();
    harness.mic(new Float32Array(32_000));
    expect(harness.callbacks.onFailure).toHaveBeenCalledOnce();
    expect(harness.callbacks.onFailure.mock.calls[0]?.[0]).toContain("only digital silence");

    harness.mic(LOUD);
    expect(harness.callbacks.onFailure).toHaveBeenCalledOnce();
    expect(harness.peer.pushAudio).not.toHaveBeenCalled();
  });

  test("does not call silence a failure once real signal has been heard", () => {
    const harness = setup();
    harness.create().activate();
    harness.mic(LOUD);
    harness.mic(new Float32Array(64_000));
    expect(harness.callbacks.onFailure).not.toHaveBeenCalled();
  });

  test("reports capture errors as failures", () => {
    const harness = setup();
    harness.create().activate();
    harness.micError(new Error("device lost"));
    expect(harness.callbacks.onFailure).toHaveBeenCalledExactlyOnceWith("device lost");
  });

  test("reports a peer that rejects audio as a failure and stops forwarding", () => {
    const harness = setup();
    harness.create().activate();
    harness.peer.pushAudio.mockImplementationOnce(() => {
      throw new Error("encoder stopped");
    });
    harness.mic(LOUD);
    harness.mic(LOUD);
    expect(harness.callbacks.onFailure).toHaveBeenCalledExactlyOnceWith("encoder stopped");
    expect(harness.peer.pushAudio).toHaveBeenCalledOnce();
  });

  test("forwards peer events and failures", () => {
    const harness = setup();
    harness.create();
    harness.peerEvent('{"type":"session.started"}');
    harness.peerFailure("ice failed");
    expect(harness.callbacks.onEvent).toHaveBeenCalledExactlyOnceWith('{"type":"session.started"}');
    expect(harness.callbacks.onFailure).toHaveBeenCalledExactlyOnceWith("ice failed");
  });

  test("closes capture before the peer, once, and goes quiet", async () => {
    const harness = setup();
    const media = harness.create();
    media.activate();
    await Promise.all([media.close(), media.close()]);
    expect(harness.calls.slice(-2)).toEqual(["capture.stop", "peer.close"]);
    expect(harness.stopCapture).toHaveBeenCalledOnce();
    expect(harness.peer.close).toHaveBeenCalledOnce();

    harness.mic(LOUD);
    harness.peerEvent("{}");
    harness.peerFailure("late");
    expect(harness.peer.pushAudio).not.toHaveBeenCalled();
    expect(harness.callbacks.onEvent).not.toHaveBeenCalled();
    expect(harness.callbacks.onFailure).not.toHaveBeenCalled();
  });

  test("still closes the peer when stopping capture throws", async () => {
    const harness = setup();
    const media = harness.create();
    harness.stopCapture.mockImplementationOnce(() => {
      throw new Error("stop failed");
    });
    await expect(media.close()).rejects.toThrow("stop failed");
    expect(harness.peer.close).toHaveBeenCalledOnce();
  });

  test("the local factory binds the native bindings and ignores the signal", () => {
    const harness = setup();
    const media = createLocalMediaFactory(harness.native)(harness.callbacks);
    expect(media).toBeInstanceOf(LocalLiveMedia);
    expect(harness.calls).toEqual(["capture.start", "peer.new"]);
  });
});

describe("microphoneLevel", () => {
  test("is the clamped RMS of the samples", () => {
    expect(microphoneLevel(new Float32Array())).toBe(0);
    expect(microphoneLevel(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(microphoneLevel(new Float32Array([4, 4]))).toBe(1);
  });
});
