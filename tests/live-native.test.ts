import { describe, expect, test, vi } from "vitest";
import {
  loadLiveNative,
  resolveLiveNativePackage,
  validateLiveNativeBindings,
} from "../src/live/native.ts";

describe("live native loader", () => {
  test("maps every supported Node platform target to its optional package", () => {
    expect(resolveLiveNativePackage("darwin", "arm64")).toBe("@oh-my-pi/pi-natives-darwin-arm64");
    expect(resolveLiveNativePackage("linux", "x64")).toBe("@oh-my-pi/pi-natives-linux-x64");
    expect(resolveLiveNativePackage("win32", "x64")).toBe("@oh-my-pi/pi-natives-win32-x64");
    expect(resolveLiveNativePackage("freebsd", "x64")).toBeUndefined();
  });

  test("loads the installed platform addon without opening media devices", () => {
    if (!resolveLiveNativePackage(process.platform, process.arch)) return;
    const bindings = loadLiveNative();
    expect(typeof bindings.AudioCapture).toBe("function");
    expect(typeof bindings.LiveWebRtcPeer).toBe("function");
  });

  test("rejects incomplete native exports", () => {
    expect(() => validateLiveNativeBindings({ AudioCapture: class {} })).toThrow(
      "does not expose the required audio/WebRTC API",
    );
  });

  test("loads the platform package and initializes its runtime", () => {
    const installRuntime = vi.fn();
    const bindings = {
      AudioCapture: class {},
      LiveWebRtcPeer: class {},
      deviceCheckGenerateToken: vi.fn(),
      __ompInstallTokioRuntime: installRuntime,
    };
    const requirePackage = vi.fn(() => bindings);

    expect(loadLiveNative(requirePackage)).toBe(bindings);
    expect(requirePackage).toHaveBeenCalledWith(
      resolveLiveNativePackage(process.platform, process.arch),
    );
    expect(installRuntime).toHaveBeenCalledOnce();
  });
});
