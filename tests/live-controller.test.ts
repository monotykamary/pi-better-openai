import { describe, expect, test, vi } from "vitest";
import { LiveSessionController } from "../src/live/controller.ts";
import type { LiveNativeBindings } from "../src/live/native.ts";
import type { LiveClientMessage } from "../src/live/protocol.ts";
import type { LiveTransportOptions } from "../src/live/transport.ts";

function fakeNative(): LiveNativeBindings {
  return {
    AudioCapture: class {
      stop(): void {}
    },
    LiveWebRtcPeer: class {
      async createOffer(): Promise<string> {
        return "offer";
      }
      async acceptAnswer(): Promise<void> {}
      async waitForOpen(): Promise<void> {}
      pushAudio(): void {}
      setMuted(): void {}
      async close(): Promise<void> {}
    },
    async deviceCheckGenerateToken() {
      return { supported: false, latencyMs: 0 };
    },
    __ompInstallTokioRuntime() {},
  };
}

async function flushSends(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("LiveSessionController", () => {
  test("delegates coding work and returns commentary plus the final agent result", async () => {
    let transportOptions: LiveTransportOptions | undefined;
    const callOrder: string[] = [];
    const send = vi.fn(async (message: LiveClientMessage) => {
      callOrder.push(`send:${message.type}`);
    });
    const delegate = vi.fn();
    const phases: string[] = [];
    const transcripts: unknown[] = [];
    const terminal = vi.fn();
    const controller = new LiveSessionController({
      sessionId: "session-1",
      voice: "vale",
      native: fakeNative(),
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate,
      createTransport: (options) => {
        transportOptions = options;
        return {
          connect: vi.fn(async () => undefined),
          send,
          pushAudio: vi.fn(),
          setMuted: vi.fn(),
          close: vi.fn(async () => {
            callOrder.push("close");
          }),
        };
      },
      createAudioCapture: () => ({ stop: vi.fn() }),
      callbacks: {
        onPhase: (phase) => phases.push(phase),
        onLevels: vi.fn(),
        onTranscript: (transcript) => transcripts.push(transcript),
        onTerminal: terminal,
      },
    });

    await controller.start();
    expect(transportOptions?.voice).toBe("vale");
    transportOptions?.callbacks.onEvent({
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "delegation-1",
        content: [{ type: "input_text", text: "Fix the failing test." }],
      },
    });
    expect(delegate).toHaveBeenCalledWith("Fix the failing test.");
    expect(phases).toContain("working");

    controller.handleAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "I found the failing assertion." }],
      stopReason: "toolUse",
    });
    controller.handleAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "Fixed the assertion and all tests pass." }],
      stopReason: "stop",
    });
    controller.handleAgentSettled();
    await flushSends();

    const messages = send.mock.calls.map(([message]) => message);
    expect(messages).toContainEqual({
      type: "delegation.context.append",
      delegation_item_id: "delegation-1",
      channel: "commentary",
      content: [{ type: "input_text", text: "I found the failing assertion." }],
    });
    expect(messages).toContainEqual({
      type: "delegation.context.append",
      delegation_item_id: "delegation-1",
      content: [
        {
          type: "input_text",
          text: '"Agent Final Message":\n\nFixed the assertion and all tests pass.',
        },
      ],
    });
    expect(controller.activeDelegationId).toBeUndefined();

    transportOptions?.callbacks.onEvent({
      type: "input_transcript.added",
      item: { text: "Run" },
    });
    transportOptions?.callbacks.onEvent({
      type: "turn.done",
      turn: { role: "user", transcript: "Run the tests." },
    });
    expect(transcripts.at(-1)).toEqual({
      role: "user",
      text: "Run the tests.",
      turn: 1,
      final: true,
    });

    await controller.stop();
    expect(send).toHaveBeenLastCalledWith({ type: "session.close" });
    expect(callOrder.slice(-2)).toEqual(["send:session.close", "close"]);
    expect(terminal).toHaveBeenCalledOnce();
  });

  test("starts microphone capture before transport negotiation completes", async () => {
    let finishConnect: (() => void) | undefined;
    const connect = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const createAudioCapture = vi.fn(() => ({ stop: vi.fn() }));
    const controller = new LiveSessionController({
      sessionId: "session-connecting",
      native: fakeNative(),
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate: vi.fn(),
      createTransport: () => ({
        connect: () => connect,
        send: vi.fn(async () => undefined),
        pushAudio: vi.fn(),
        setMuted: vi.fn(),
        close: vi.fn(async () => undefined),
      }),
      createAudioCapture,
      callbacks: {
        onPhase: vi.fn(),
        onLevels: vi.fn(),
        onTranscript: vi.fn(),
        onTerminal: vi.fn(),
      },
    });

    const start = controller.start();
    expect(createAudioCapture).toHaveBeenCalledOnce();
    finishConnect?.();
    await start;
    await controller.stop();
  });

  test("reports privacy-filtered zero-only microphone input", async () => {
    let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
    const terminal = vi.fn();
    const controller = new LiveSessionController({
      sessionId: "session-silent",
      native: fakeNative(),
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate: vi.fn(),
      createTransport: () => ({
        connect: vi.fn(async () => undefined),
        send: vi.fn(async () => undefined),
        pushAudio: vi.fn(),
        setMuted: vi.fn(),
        close: vi.fn(async () => undefined),
      }),
      createAudioCapture: (_native, callback) => {
        onAudio = callback;
        return { stop: vi.fn() };
      },
      callbacks: {
        onPhase: vi.fn(),
        onLevels: vi.fn(),
        onTranscript: vi.fn(),
        onTerminal: terminal,
      },
    });

    await controller.start();
    onAudio?.(null, new Float32Array(32_000));

    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(terminal.mock.calls[0]?.[0]?.message).toContain("only digital silence");
    await controller.stop();
  });

  test("suppresses likely speaker echo, permits barge-in, and honors mute", async () => {
    let transportOptions: LiveTransportOptions | undefined;
    let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
    const pushAudio = vi.fn();
    const setMuted = vi.fn();
    const controller = new LiveSessionController({
      sessionId: "session-2",
      native: fakeNative(),
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate: vi.fn(),
      createTransport: (options) => {
        transportOptions = options;
        return {
          connect: vi.fn(async () => undefined),
          send: vi.fn(async () => undefined),
          pushAudio,
          setMuted,
          close: vi.fn(async () => undefined),
        };
      },
      createAudioCapture: (_native, callback) => {
        onAudio = callback;
        return { stop: vi.fn() };
      },
      callbacks: {
        onPhase: vi.fn(),
        onLevels: vi.fn(),
        onTranscript: vi.fn(),
        onTerminal: vi.fn(),
      },
    });

    await controller.start();
    transportOptions?.callbacks.onOutputLevel(0.5);
    onAudio?.(null, new Float32Array([0.1, -0.1, 0.1, -0.1]));
    expect(pushAudio).not.toHaveBeenCalled();
    const loud = new Float32Array([0.8, -0.8, 0.8, -0.8]);
    onAudio?.(null, loud);
    expect(pushAudio).toHaveBeenCalledWith(loud);

    controller.toggleMute();
    expect(controller.muted).toBe(true);
    expect(setMuted).toHaveBeenLastCalledWith(true);
    onAudio?.(null, loud);
    expect(pushAudio).toHaveBeenCalledOnce();

    await controller.stop();
  });
});
