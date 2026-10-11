import type { CodexCredentials } from "../codex-auth.ts";
import { type LiveMediaFactory, OUTPUT_ACTIVE_LEVEL } from "./media.ts";
import { loadLiveNative, type LiveNativeBindings } from "./native.ts";
import {
  buildDelegationContextAppend,
  buildSessionClose,
  chunkLiveContext,
  type LiveClientMessage,
  type LiveServerEvent,
} from "./protocol.ts";
import { CodexLiveTransport, type LiveTransportOptions } from "./transport.ts";
import { DEFAULT_LIVE_VOICE } from "./voices.ts";

const LIVE_INSTRUCTIONS = `You are Better OpenAI Live, the realtime voice surface of one unified coding assistant.

The user is speaking to you. Respond directly, briefly, conversationally, and in speech-friendly language. Never use markdown, code blocks, or long lists unless the user explicitly asks you to read technical detail aloud.

You and the client coding agent are one assistant, not separate agents. The client has the active repository context, coding model, and tools. You must promptly create a client delegation for coding, repository investigation, tool use, commands, or verification. Include the complete request and relevant conversational context. Keep conversation natural while work runs.

Treat delegation context as your own internal progress and result. Never mention a backend, delegation, protocol, or another assistant. Commentary context is silent progress and must not be recited. Context beginning with "Agent Final Message": is the final visible answer from your execution surface; present its useful result naturally as your own.

For greetings, clarification, or ordinary conversation that needs no tools, answer directly without delegating. Preserve one-assistant continuity: converse here, delegate execution, then communicate the returned result as your own.`;

export type LivePhase =
  | "standby"
  | "connecting"
  | "listening"
  | "working"
  | "speaking"
  | "muted"
  | "error";

export interface LiveTranscript {
  role: "user" | "assistant";
  text: string;
  turn: number;
  final: boolean;
}

export interface LiveSessionCallbacks {
  onPhase(phase: LivePhase): void;
  onLevels(input: number, output: number): void;
  onTranscript(transcript: LiveTranscript | undefined): void;
  onTerminal(error?: Error): void;
}

export interface LiveTransport {
  connect(): Promise<void>;
  send(message: LiveClientMessage): Promise<void>;
  setMuted(muted: boolean): void;
  close(): Promise<void>;
}

export interface LiveSessionControllerOptions {
  sessionId: string;
  getCredentials(signal?: AbortSignal): Promise<CodexCredentials | undefined>;
  delegate(request: string): void;
  callbacks: LiveSessionCallbacks;
  voice?: string;
  signal?: AbortSignal;
  native?: LiveNativeBindings;
  createTransport?: (options: LiveTransportOptions) => LiveTransport;
  /**
   * Chooses where the media of this session lives, each time it starts. Undefined keeps the
   * default, this computer; a refusal fails the start before anything is opened.
   */
  resolveMedia?(signal?: AbortSignal): Promise<LiveMediaFactory | undefined>;
}

type AssistantSnapshot = {
  text: string;
  stopReason: string | undefined;
  errorMessage: string | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function extractAssistantSnapshot(message: unknown): AssistantSnapshot | undefined {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  const text = message.content
    .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => String(item.text))
    .join("\n")
    .trim();
  return {
    text,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
  };
}

export class LiveSessionController {
  readonly #options: LiveSessionControllerOptions;
  readonly #callbacks: LiveSessionCallbacks;
  readonly #voice: string;
  readonly #createTransport: (options: LiveTransportOptions) => LiveTransport;
  #native: LiveNativeBindings | undefined;
  #transport: LiveTransport | undefined;
  #sendChain: Promise<void> = Promise.resolve();
  #stopPromise: Promise<void> | undefined;
  #started = false;
  #stopped = false;
  #terminalEmitted = false;
  #failure: Error | undefined;
  #muted = false;
  #phase: LivePhase = "connecting";
  #inputLevel = 0;
  #outputLevel = 0;
  #activeDelegationId: string | undefined;
  #pendingAgentFinal = "";
  #userTranscript = "";
  #assistantTranscript = "";
  #userTranscriptFinal = false;
  #assistantTranscriptFinal = false;
  #userTranscriptTurn = 0;
  #assistantTranscriptTurn = 0;
  #lastTranscript: LiveTranscript | undefined;

  constructor(options: LiveSessionControllerOptions) {
    this.#options = options;
    this.#callbacks = options.callbacks;
    this.#voice = options.voice?.trim() || DEFAULT_LIVE_VOICE;
    this.#native = options.native;
    this.#createTransport =
      options.createTransport ?? ((transportOptions) => new CodexLiveTransport(transportOptions));
  }

  get phase(): LivePhase {
    return this.#phase;
  }

  get muted(): boolean {
    return this.#muted;
  }

  get activeDelegationId(): string | undefined {
    return this.#activeDelegationId;
  }

  async start(): Promise<void> {
    if (this.#stopped) {
      throw this.#failure ?? new Error("This live session has already stopped.");
    }
    if (this.#started) return;
    this.#started = true;
    this.#emitPhase("connecting", true);
    this.#emitTranscript(undefined);

    try {
      // Awaited only when there is something to wait for, so the default path keeps its timing.
      const createMedia = this.#options.resolveMedia
        ? await this.#options.resolveMedia(this.#options.signal)
        : undefined;
      if (this.#stopped) {
        throw this.#failure ?? new Error("The live session stopped while connecting.");
      }
      const native = this.#native ?? loadLiveNative();
      this.#native = native;
      const transport = this.#createTransport({
        getCredentials: this.#options.getCredentials,
        sessionId: this.#options.sessionId,
        instructions: LIVE_INSTRUCTIONS,
        voice: this.#voice,
        signal: this.#options.signal,
        native,
        ...(createMedia ? { createMedia } : {}),
        callbacks: {
          onEvent: (event) => this.#guardEvent(() => this.#handleLiveEvent(event)),
          onLevels: (input, output) => this.#guardEvent(() => this.#handleLevels(input, output)),
        },
      });
      this.#transport = transport;
      await transport.connect();
      if (this.#stopped)
        throw this.#failure ?? new Error("The live session stopped while connecting.");
      transport.setMuted(this.#muted);
      this.#refreshAudioPhase();
    } catch (cause) {
      const error = errorFrom(cause);
      this.#reportFailure(error);
      await this.stop();
      throw error;
    }
  }

  toggleMute(): void {
    if (this.#stopped) return;
    this.#muted = !this.#muted;
    if (this.#muted) {
      this.#inputLevel = 0;
      this.#emitLevels();
    }
    this.#refreshAudioPhase();
    try {
      this.#transport?.setMuted(this.#muted);
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  handleAgentMessage(message: unknown): void {
    if (!this.#activeDelegationId || this.#stopped) return;
    const snapshot = extractAssistantSnapshot(message);
    if (!snapshot) return;
    if (snapshot.stopReason === "toolUse") {
      if (!snapshot.text) return;
      for (const chunk of chunkLiveContext(snapshot.text)) {
        this.#queueSend(
          buildDelegationContextAppend(this.#activeDelegationId, chunk, "commentary"),
        );
      }
      return;
    }
    if (snapshot.text) this.#pendingAgentFinal = snapshot.text;
    else if (snapshot.errorMessage) this.#pendingAgentFinal = snapshot.errorMessage;
  }

  handleAgentSettled(): void {
    const delegationId = this.#activeDelegationId;
    if (!delegationId || this.#stopped) return;
    const finalText =
      this.#pendingAgentFinal || "The requested coding task ended without a final response.";
    const context = `"Agent Final Message":\n\n${finalText}`;
    for (const chunk of chunkLiveContext(context)) {
      this.#queueSend(buildDelegationContextAppend(delegationId, chunk));
    }
    this.#activeDelegationId = undefined;
    this.#pendingAgentFinal = "";
    this.#refreshAudioPhase();
  }

  stop(): Promise<void> {
    if (!this.#stopPromise) this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#stopped = true;
    let cleanupError: Error | undefined;
    // Stop forwarding the microphone now; the transport releases capture when it closes.
    try {
      this.#transport?.setMuted(true);
    } catch (cause) {
      cleanupError = errorFrom(cause);
    }

    await this.#sendChain;
    const transport = this.#transport;
    this.#transport = undefined;
    if (transport) {
      try {
        await transport.send(buildSessionClose());
      } catch (cause) {
        cleanupError ??= errorFrom(cause);
      }
      try {
        await transport.close();
      } catch (cause) {
        cleanupError ??= errorFrom(cause);
      }
    }
    if (cleanupError) this.#emitPhaseSafely("error");
    this.#emitTerminal(this.#failure ?? cleanupError);
  }

  #guardEvent(handler: () => void): void {
    if (this.#stopped) return;
    try {
      handler();
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  #handleLiveEvent(event: LiveServerEvent): void {
    switch (event.type) {
      case "session.started":
        this.#emitPhase("listening");
        break;
      case "input_transcript.added":
        this.#addTranscript("user", event.item.text);
        break;
      case "output_transcript.added":
        this.#addTranscript("assistant", event.item.text);
        break;
      case "turn.done":
        this.#finishTranscript(event.turn.role, event.turn.transcript);
        break;
      case "delegation.created":
        this.#handleDelegation(event);
        break;
      case "error":
        this.#reportFailure(new Error(event.message));
        break;
      case "session.updated":
      case "output_audio.delta":
      case "unknown":
        break;
    }
  }

  #handleDelegation(event: Extract<LiveServerEvent, { type: "delegation.created" }>): void {
    const request = event.item.content
      .filter((content) => content.type === "input_text")
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (!request) return;
    this.#activeDelegationId = event.item.id;
    this.#pendingAgentFinal = "";
    this.#emitPhase("working");
    try {
      this.#options.delegate(request);
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  #handleLevels(input: number, output: number): void {
    const outputChanged = output !== this.#outputLevel;
    this.#inputLevel = input;
    this.#outputLevel = output;
    this.#emitLevels();
    if (outputChanged && !this.#activeDelegationId) this.#refreshAudioPhase();
  }

  #addTranscript(role: LiveTranscript["role"], text: string): void {
    if (!text) return;
    const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
    const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
    let next: string;
    if (!current) {
      this.#startTranscriptTurn(role);
      next = text;
    } else if (wasFinal) {
      if (text === current || current.endsWith(text)) return;
      this.#startTranscriptTurn(role);
      next = text;
    } else if (text.startsWith(current)) {
      next = text;
    } else if (current.endsWith(text)) {
      next = current;
    } else {
      next = current + text;
    }
    this.#storeTranscript(role, next, false);
  }

  #finishTranscript(role: LiveTranscript["role"], text: string): void {
    if (!text) return;
    const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
    const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
    if (!current) this.#startTranscriptTurn(role);
    else if (wasFinal) {
      if (text === current) return;
      this.#startTranscriptTurn(role);
    }
    const next =
      !wasFinal && current.startsWith(text) && current.length > text.length ? current : text;
    this.#storeTranscript(role, next, true);
  }

  #startTranscriptTurn(role: LiveTranscript["role"]): void {
    if (role === "user") this.#userTranscriptTurn += 1;
    else this.#assistantTranscriptTurn += 1;
  }

  #storeTranscript(role: LiveTranscript["role"], text: string, final: boolean): void {
    const normalized = text.trim();
    if (!normalized) return;
    const turn = role === "user" ? this.#userTranscriptTurn : this.#assistantTranscriptTurn;
    if (role === "user") {
      this.#userTranscript = normalized;
      this.#userTranscriptFinal = final;
    } else {
      this.#assistantTranscript = normalized;
      this.#assistantTranscriptFinal = final;
    }
    if (
      this.#lastTranscript?.role === role &&
      this.#lastTranscript.turn === turn &&
      this.#lastTranscript.text === normalized &&
      this.#lastTranscript.final === final
    ) {
      return;
    }
    this.#emitTranscript({ role, turn, text: normalized, final });
  }

  #queueSend(message: LiveClientMessage): void {
    const transport = this.#transport;
    if (!transport || this.#stopped) return;
    this.#sendChain = this.#sendChain
      .then(async () => {
        if (!this.#stopped) await transport.send(message);
      })
      .catch((cause) => this.#reportFailure(errorFrom(cause)));
  }

  #refreshAudioPhase(): void {
    if (this.#stopped) return;
    if (this.#muted) this.#emitPhase("muted");
    else if (this.#activeDelegationId) this.#emitPhase("working");
    else if (this.#outputLevel > OUTPUT_ACTIVE_LEVEL) this.#emitPhase("speaking");
    else this.#emitPhase("listening");
  }

  #emitPhase(phase: LivePhase, force = false): void {
    if (!force && this.#phase === phase) return;
    this.#phase = phase;
    try {
      this.#callbacks.onPhase(phase);
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  #emitPhaseSafely(phase: LivePhase): void {
    this.#phase = phase;
    try {
      this.#callbacks.onPhase(phase);
    } catch {
      // The terminal callback is the final UI error boundary.
    }
  }

  #emitLevels(): void {
    try {
      this.#callbacks.onLevels(this.#inputLevel, this.#outputLevel);
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  #emitTranscript(transcript: LiveTranscript | undefined): void {
    this.#lastTranscript = transcript;
    try {
      this.#callbacks.onTranscript(transcript);
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  #reportFailure(error: Error): void {
    if (this.#terminalEmitted) return;
    this.#failure = error;
    this.#emitPhaseSafely("error");
    this.#emitTerminal(error);
    void this.stop();
  }

  #emitTerminal(error?: Error): void {
    if (this.#terminalEmitted) return;
    this.#terminalEmitted = true;
    try {
      this.#callbacks.onTerminal(error);
    } catch {
      // Nothing remains above the terminal callback to receive its error.
    }
  }
}
