import { createRequire } from "node:module";

export interface LiveAudioCapture {
  stop(): void;
}

export interface LiveAudioCaptureConstructor {
  new (
    sampleRate: number,
    onAudio: (error: Error | null, samples: Float32Array) => void,
  ): LiveAudioCapture;
}

export interface LiveWebRtcPeerInstance {
  createOffer(): Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  waitForOpen(timeoutMs?: number): Promise<void>;
  pushAudio(samples: Float32Array): void;
  setMuted(muted: boolean): void;
  close(): Promise<void>;
}

export interface LiveWebRtcPeerConstructor {
  new (
    onEvent: (error: Error | null, payload: string) => void,
    onLevel: (error: Error | null, level: number) => void,
    onFailure: (error: Error | null, message: string) => void,
  ): LiveWebRtcPeerInstance;
}

export type DeviceCheckTokenResult = {
  supported: boolean;
  tokenBase64?: string;
  error?: string;
  latencyMs: number;
};

export interface LiveNativeBindings {
  AudioCapture: LiveAudioCaptureConstructor;
  LiveWebRtcPeer: LiveWebRtcPeerConstructor;
  deviceCheckGenerateToken(): Promise<DeviceCheckTokenResult>;
  __ompInstallTokioRuntime(): void;
}

const NATIVE_PACKAGES = {
  "darwin-arm64": "@oh-my-pi/pi-natives-darwin-arm64",
  "darwin-x64": "@oh-my-pi/pi-natives-darwin-x64",
  "linux-arm64": "@oh-my-pi/pi-natives-linux-arm64",
  "linux-x64": "@oh-my-pi/pi-natives-linux-x64",
  "win32-x64": "@oh-my-pi/pi-natives-win32-x64",
} as const;

const runtimeRequire = createRequire(import.meta.url);
let cachedBindings: LiveNativeBindings | undefined;

type NativeTarget = keyof typeof NATIVE_PACKAGES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function resolveLiveNativePackage(
  platform: NodeJS.Platform | string,
  arch: string,
): string | undefined {
  return NATIVE_PACKAGES[`${platform}-${arch}` as NativeTarget];
}

export function validateLiveNativeBindings(value: unknown): LiveNativeBindings {
  if (
    !isRecord(value) ||
    typeof value.AudioCapture !== "function" ||
    typeof value.LiveWebRtcPeer !== "function" ||
    typeof value.deviceCheckGenerateToken !== "function" ||
    typeof value.__ompInstallTokioRuntime !== "function"
  ) {
    throw new Error(
      "The installed live native package does not expose the required audio/WebRTC API.",
    );
  }
  return value as unknown as LiveNativeBindings;
}

export function loadLiveNative(
  requirePackage: (packageName: string) => unknown = runtimeRequire,
): LiveNativeBindings {
  if (cachedBindings && requirePackage === runtimeRequire) return cachedBindings;
  const packageName = resolveLiveNativePackage(process.platform, process.arch);
  if (!packageName) {
    throw new Error(
      `Live voice is not available on ${process.platform}-${process.arch}. Supported targets: ${Object.keys(NATIVE_PACKAGES).join(", ")}.`,
    );
  }

  let loaded: unknown;
  try {
    loaded = requirePackage(packageName);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Unable to load ${packageName}: ${detail}`, { cause });
  }

  const bindings = validateLiveNativeBindings(loaded);
  bindings.__ompInstallTokioRuntime();
  if (requirePackage === runtimeRequire) cachedBindings = bindings;
  return bindings;
}

export const LIVE_NATIVE_TARGETS = Object.keys(NATIVE_PACKAGES);
