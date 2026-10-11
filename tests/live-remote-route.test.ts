import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { HOST_LAUNCHER_COMMAND } from "../src/live/remote/host.ts";
import { OriginError } from "../src/live/remote/origin.ts";
import { encodeFrame, parseClientFrame, FrameDecoder } from "../src/live/remote/protocol.ts";
import { resolveLiveMedia, sshArguments } from "../src/live/remote/route.ts";

class FakeSsh extends EventEmitter {
  readonly pid = 4321;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  });
  readonly written: unknown[] = [];

  constructor() {
    super();
    const decoder = new FrameDecoder(parseClientFrame);
    this.stdin.on("data", (chunk: Buffer) => this.written.push(...decoder.push(chunk)));
  }
}

const callbacks = () => ({ onEvent: vi.fn(), onLevels: vi.fn(), onFailure: vi.fn() });

describe("ssh to the media host", () => {
  test("is non-interactive, bounded, and cannot take the host for an option", () => {
    expect(sshArguments("omarchybook")).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=3",
      "--",
      "omarchybook",
      HOST_LAUNCHER_COMMAND,
    ]);
    expect(HOST_LAUNCHER_COMMAND).toBe("exec ~/.pi/agent/live-host/media-host");
  });

  test.each(["-oProxyCommand=x", "a b", "", "a;b", "x".repeat(64)])(
    "refuses the host %j before building a command",
    (host) => {
      expect(() => sshArguments(host)).toThrow(OriginError);
    },
  );
});

describe("resolveLiveMedia", () => {
  test("this computer keeps the local media and starts nothing", async () => {
    const spawn = vi.fn();
    await expect(
      resolveLiveMedia({ resolveTarget: async () => ({ kind: "local" }), spawn }),
    ).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  test("a refusal reaches the caller and nothing is started", async () => {
    const spawn = vi.fn();
    await expect(
      resolveLiveMedia({
        resolveTarget: async () => {
          throw new OriginError("Herdr cannot tell");
        },
        spawn,
      }),
    ).rejects.toThrow("Herdr cannot tell");
    expect(spawn).not.toHaveBeenCalled();
  });

  test("a remote computer is reached over ssh and must answer as the computer that typed", async () => {
    const ssh = new FakeSsh();
    const spawn = vi.fn(() => ssh);
    const createMedia = await resolveLiveMedia({
      resolveTarget: async () => ({ kind: "remote", host: "omarchybook", node: "nLAPTOP" }),
      spawn,
    });
    expect(spawn).not.toHaveBeenCalled();
    const media = createMedia!(callbacks());
    expect(spawn).toHaveBeenCalledWith("ssh", sshArguments("omarchybook"), expect.anything());

    const offer = media.createOffer();
    ssh.stdout.write(encodeFrame({ type: "hello", node: "nSOMEONE-ELSE" }));
    await expect(offer).rejects.toThrow("not the computer");
    expect(ssh.written).toEqual([]);

    const right = new FakeSsh();
    spawn.mockReturnValueOnce(right);
    const accepted = createMedia!(callbacks());
    void accepted.createOffer().catch(() => undefined);
    right.stdout.write(encodeFrame({ type: "hello", node: "nLAPTOP" }));
    await vi.waitFor(() => expect(right.written[0]).toMatchObject({ method: "open" }));
    await accepted.close().catch(() => undefined);
  });
});
