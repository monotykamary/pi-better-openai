import type { LiveAudioCapture, LiveNativeBindings, LiveWebRtcPeerInstance } from "./native.ts";

export const OUTPUT_ACTIVE_LEVEL = 0.015;
const MIN_BARGE_IN_LEVEL = 0.04;
const OUTPUT_ECHO_RATIO = 0.65;
const DIGITAL_SILENCE_SAMPLE_LIMIT = 32_000;
const CAPTURE_SAMPLE_RATE = 16_000;

export interface LiveMediaCallbacks {
  /** A realtime server event from the WebRTC data channel, as raw JSON. */
  onEvent(payload: string): void;
  onLevels(input: number, output: number): void;
  onFailure(message: string): void;
}

/**
 * Everything that touches the audio devices: capture, the microphone filter and the
 * WebRTC peer that also plays the reply. Signaling, auth and the sideband stay with the
 * transport, so a media implementation only ever sees SDP, control and levels.
 */
export interface LiveMedia {
  createOffer(): Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  waitForOpen(timeoutMs?: number): Promise<void>;
  /** Starts forwarding the microphone once the session is connected. */
  activate(): void;
  setMuted(muted: boolean): void;
  close(): Promise<void>;
}

export type LiveMediaFactory = (callbacks: LiveMediaCallbacks, signal?: AbortSignal) => LiveMedia;

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function clampLevel(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.min(1, level);
}

export function microphoneLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sumSquares += sample * sample;
  }
  return clampLevel(Math.sqrt(sumSquares / samples.length));
}

export class LocalLiveMedia implements LiveMedia {
  readonly #callbacks: LiveMediaCallbacks;
  readonly #capture: LiveAudioCapture;
  readonly #peer: LiveWebRtcPeerInstance;
  #active = false;
  #answered = false;
  #muted = false;
  #failed = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #inputLevel = 0;
  #outputLevel = 0;
  #digitalSilenceSampleCount = 0;
  #microphoneSignalDetected = false;

  constructor(native: LiveNativeBindings, callbacks: LiveMediaCallbacks) {
    this.#callbacks = callbacks;
    this.#capture = new native.AudioCapture(CAPTURE_SAMPLE_RATE, (error, samples) => {
      if (error) this.#fail(error.message);
      else this.#handleMicrophoneAudio(samples);
    });
    try {
      this.#peer = new native.LiveWebRtcPeer(
        (error, payload) => {
          if (error) this.#fail(error.message);
          else if (!this.#closed) callbacks.onEvent(payload);
        },
        (error, level) => {
          if (error) this.#fail(error.message);
          else this.#handleOutputLevel(level);
        },
        (error, message) => this.#fail(error?.message ?? message),
      );
    } catch (cause) {
      try {
        this.#capture.stop();
      } catch {
        // The peer failure is the one worth reporting.
      }
      throw cause;
    }
  }

  createOffer(): Promise<string> {
    return this.#peer.createOffer();
  }

  async acceptAnswer(sdp: string): Promise<void> {
    await this.#peer.acceptAnswer(sdp);
    this.#answered = true;
    this.#peer.setMuted(this.#muted);
  }

  waitForOpen(timeoutMs?: number): Promise<void> {
    return this.#peer.waitForOpen(timeoutMs);
  }

  activate(): void {
    this.#active = true;
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (muted) this.#inputLevel = 0;
    if (this.#answered && !this.#closed) this.#peer.setMuted(muted);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#active = false;
    let captureError: Error | undefined;
    try {
      this.#capture.stop();
    } catch (cause) {
      captureError = errorFrom(cause);
    }
    try {
      await this.#peer.close();
    } catch {
      // Closing is best-effort after a terminal transport failure.
    }
    if (captureError) throw captureError;
  }

  #fail(message: string): void {
    if (this.#closed || this.#failed) return;
    this.#failed = true;
    this.#callbacks.onFailure(message);
  }

  #handleOutputLevel(level: number): void {
    if (this.#closed || !this.#active || !Number.isFinite(level)) return;
    this.#outputLevel = clampLevel(level);
    this.#callbacks.onLevels(this.#inputLevel, this.#outputLevel);
  }

  #handleMicrophoneAudio(samples: Float32Array): void {
    if (this.#closed || this.#failed || this.#muted) return;
    if (!this.#microphoneSignalDetected) {
      const hasSignal = samples.some((sample) => sample !== 0);
      if (hasSignal) {
        this.#microphoneSignalDetected = true;
      } else {
        this.#digitalSilenceSampleCount += samples.length;
        if (this.#digitalSilenceSampleCount >= DIGITAL_SILENCE_SAMPLE_LIMIT) {
          const localtermHint =
            process.platform === "darwin" && process.env.LOCALTERM
              ? " Run `localterm install`, restart LocalTerm, and allow its microphone prompt."
              : " Check your operating system microphone permission and selected input device.";
          this.#fail(`Microphone input contains only digital silence.${localtermHint}`);
          return;
        }
      }
    }
    this.#inputLevel = microphoneLevel(samples);
    this.#callbacks.onLevels(this.#inputLevel, this.#outputLevel);
    const outputActive = this.#outputLevel > OUTPUT_ACTIVE_LEVEL;
    const echoThreshold = Math.max(MIN_BARGE_IN_LEVEL, this.#outputLevel * OUTPUT_ECHO_RATIO);
    if (!this.#active || samples.length === 0) return;
    if (outputActive && this.#inputLevel < echoThreshold) return;
    try {
      this.#peer.pushAudio(samples);
    } catch (cause) {
      this.#fail(errorFrom(cause).message);
    }
  }
}

export function createLocalMediaFactory(native: LiveNativeBindings): LiveMediaFactory {
  return (callbacks) => new LocalLiveMedia(native, callbacks);
}
