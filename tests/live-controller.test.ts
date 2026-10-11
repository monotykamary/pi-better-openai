import { describe, expect, test, vi } from "vitest";
import {
  LiveSessionController,
  type LiveSessionControllerOptions,
} from "../src/live/controller.ts";
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
          setMuted: vi.fn(),
          close: vi.fn(async () => {
            callOrder.push("close");
          }),
        };
      },
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

  test("owns no capture: the transport alone is created and connected on start", async () => {
    const createTransport = vi.fn((_options: LiveTransportOptions) => ({
      connect: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      setMuted: vi.fn(),
      close: vi.fn(async () => undefined),
    }));
    const native = fakeNative();
    const captureSpy = vi.spyOn(native, "AudioCapture");
    const controller = new LiveSessionController({
      sessionId: "session-no-capture",
      native,
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate: vi.fn(),
      createTransport,
      callbacks: {
        onPhase: vi.fn(),
        onLevels: vi.fn(),
        onTranscript: vi.fn(),
        onTerminal: vi.fn(),
      },
    });

    await controller.start();
    expect(createTransport).toHaveBeenCalledOnce();
    expect(createTransport.mock.calls[0]?.[0].native).toBe(native);
    expect(captureSpy).not.toHaveBeenCalled();
    await controller.stop();
  });

  test("turns transport levels into UI levels and the speaking phase, without leaving connecting early", async () => {
    let transportOptions: LiveTransportOptions | undefined;
    let finishConnect: (() => void) | undefined;
    const connect = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const phases: string[] = [];
    const onLevels = vi.fn();
    const controller = new LiveSessionController({
      sessionId: "session-levels",
      native: fakeNative(),
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate: vi.fn(),
      createTransport: (options) => {
        transportOptions = options;
        return {
          connect: () => connect,
          send: vi.fn(async () => undefined),
          setMuted: vi.fn(),
          close: vi.fn(async () => undefined),
        };
      },
      callbacks: {
        onPhase: (phase) => phases.push(phase),
        onLevels,
        onTranscript: vi.fn(),
        onTerminal: vi.fn(),
      },
    });

    const start = controller.start();
    transportOptions?.callbacks.onLevels(0.4, 0);
    expect(onLevels).toHaveBeenLastCalledWith(0.4, 0);
    expect(phases).toEqual(["connecting"]);

    finishConnect?.();
    await start;
    expect(controller.phase).toBe("listening");
    transportOptions?.callbacks.onLevels(0.1, 0.5);
    expect(onLevels).toHaveBeenLastCalledWith(0.1, 0.5);
    expect(controller.phase).toBe("speaking");
    transportOptions?.callbacks.onLevels(0.1, 0);
    expect(controller.phase).toBe("listening");
    await controller.stop();
  });

  test("mute zeroes the input level, informs the transport, and wins over speaking", async () => {
    let transportOptions: LiveTransportOptions | undefined;
    const setMuted = vi.fn();
    const onLevels = vi.fn();
    const controller = new LiveSessionController({
      sessionId: "session-mute",
      native: fakeNative(),
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate: vi.fn(),
      createTransport: (options) => {
        transportOptions = options;
        return {
          connect: vi.fn(async () => undefined),
          send: vi.fn(async () => undefined),
          setMuted,
          close: vi.fn(async () => undefined),
        };
      },
      callbacks: {
        onPhase: vi.fn(),
        onLevels,
        onTranscript: vi.fn(),
        onTerminal: vi.fn(),
      },
    });

    await controller.start();
    expect(setMuted).toHaveBeenLastCalledWith(false);
    transportOptions?.callbacks.onLevels(0.4, 0.2);
    controller.toggleMute();
    expect(controller.muted).toBe(true);
    expect(controller.phase).toBe("muted");
    expect(onLevels).toHaveBeenLastCalledWith(0, 0.2);
    expect(setMuted).toHaveBeenLastCalledWith(true);
    await controller.stop();
  });

  test("silences the transport microphone before queued sends drain, then closes it last", async () => {
    const order: string[] = [];
    const controller = new LiveSessionController({
      sessionId: "session-stop-order",
      native: fakeNative(),
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate: vi.fn(),
      createTransport: () => ({
        connect: vi.fn(async () => undefined),
        send: vi.fn(async (message: LiveClientMessage) => {
          order.push(`send:${message.type}`);
        }),
        setMuted: vi.fn((muted: boolean) => order.push(`muted:${muted}`)),
        close: vi.fn(async () => {
          order.push("close");
        }),
      }),
      callbacks: {
        onPhase: vi.fn(),
        onLevels: vi.fn(),
        onTranscript: vi.fn(),
        onTerminal: vi.fn(),
      },
    });

    await controller.start();
    order.length = 0;
    await controller.stop();
    expect(order).toEqual(["muted:true", "send:session.close", "close"]);
  });

  test("reports a transport media failure as the terminal error", async () => {
    let transportOptions: LiveTransportOptions | undefined;
    const terminal = vi.fn();
    const controller = new LiveSessionController({
      sessionId: "session-failure",
      native: fakeNative(),
      getCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
      delegate: vi.fn(),
      createTransport: (options) => {
        transportOptions = options;
        return {
          connect: vi.fn(async () => undefined),
          send: vi.fn(async () => undefined),
          setMuted: vi.fn(),
          close: vi.fn(async () => undefined),
        };
      },
      callbacks: {
        onPhase: vi.fn(),
        onLevels: vi.fn(),
        onTranscript: vi.fn(),
        onTerminal: terminal,
      },
    });

    await controller.start();
    transportOptions?.callbacks.onEvent({
      type: "error",
      message: "Microphone input contains only digital silence.",
    });
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0]?.[0]?.message).toContain("only digital silence");
    await controller.stop();
  });

  describe("where the media lives", () => {
    function startable(overrides: Partial<LiveSessionControllerOptions>) {
      const created: LiveTransportOptions[] = [];
      const terminal = vi.fn();
      const controller = new LiveSessionController({
        sessionId: "session-1",
        native: fakeNative(),
        getCredentials: vi.fn(async () => undefined),
        delegate: vi.fn(),
        createTransport: (options) => {
          created.push(options);
          return {
            connect: vi.fn(async () => undefined),
            send: vi.fn(async () => undefined),
            setMuted: vi.fn(),
            close: vi.fn(async () => undefined),
          };
        },
        callbacks: {
          onPhase: vi.fn(),
          onLevels: vi.fn(),
          onTranscript: vi.fn(),
          onTerminal: terminal,
        },
        ...overrides,
      });
      return { controller, created, terminal };
    }

    test("asks at each start and gives the transport the media it was told to use", async () => {
      const createMedia = vi.fn();
      const resolveMedia = vi.fn(async () => createMedia);
      const { controller, created } = startable({ resolveMedia });
      await controller.start();
      expect(resolveMedia).toHaveBeenCalledOnce();
      expect(created[0]?.createMedia).toBe(createMedia);
    });

    test("keeps the transport's own local media when nothing else is chosen", async () => {
      const { controller, created } = startable({ resolveMedia: async () => undefined });
      await controller.start();
      expect(created[0]).toBeDefined();
      expect(created[0]?.createMedia).toBeUndefined();
      const plain = startable({});
      await plain.controller.start();
      expect(plain.created[0]?.createMedia).toBeUndefined();
    });

    test("a refused route fails the start without creating any transport", async () => {
      const refusal = new Error("Herdr cannot tell which computer typed");
      const { controller, created, terminal } = startable({
        resolveMedia: async () => {
          throw refusal;
        },
      });
      await expect(controller.start()).rejects.toBe(refusal);
      expect(created).toEqual([]);
      expect(terminal).toHaveBeenCalledOnce();
      expect(terminal).toHaveBeenCalledWith(refusal);
    });

    test("stopping while the route is being worked out leaves nothing behind", async () => {
      let answer!: (media: undefined) => void;
      const { controller, created } = startable({
        resolveMedia: () => new Promise((resolve) => (answer = resolve)),
      });
      const starting = controller.start();
      starting.catch(() => undefined);
      await controller.stop();
      answer(undefined);
      await expect(starting).rejects.toThrow();
      expect(created).toEqual([]);
    });
  });
});
