import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { HOST_LAUNCHER_COMMAND } from "../src/live/remote/host.ts";
import { OriginCancelled, OriginError } from "../src/live/remote/origin.ts";
import { encodeFrame, parseClientFrame, FrameDecoder } from "../src/live/remote/protocol.ts";
import { resolveLiveMedia, resolveLiveTarget, sshArguments } from "../src/live/remote/route.ts";

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
    // A real host leaves when its input ends.
    this.stdin.once("end", () => queueMicrotask(() => this.emit("exit", 0, null)));
  }
}

const callbacks = () => ({ onEvent: vi.fn(), onLevels: vi.fn(), onFailure: vi.fn() });

describe("ssh to the media host", () => {
  test("is non-interactive, bounded, and cannot take the host for an option", () => {
    expect(sshArguments("laptop")).toEqual([
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
      "laptop",
      HOST_LAUNCHER_COMMAND,
    ]);
    expect(HOST_LAUNCHER_COMMAND).toBe("exec ~/.pi/agent/live-host/media-host");
  });

  test.each([
    "audio-pc",
    "audio_pc.local",
    "pc.example.com",
    "me@192.168.0.5",
    "first.last@audio-pc",
  ])("accepts the SSH host %j: a name, an ssh config alias, an address or user@host", (host) => {
    expect(sshArguments(host).slice(-2)).toEqual([host, HOST_LAUNCHER_COMMAND]);
  });

  test.each([
    "-oProxyCommand=x",
    "me@-oProxyCommand=x",
    "-me@host",
    "a b",
    "",
    "a;b",
    "$(x)",
    "a\nb",
    "@host",
    "me@",
    "me@@host",
    "a:22",
  ])("refuses the host %j before building a command, naming what is allowed", (host) => {
    expect(() => sshArguments(host)).toThrow(OriginError);
    expect(() => sshArguments(host)).toThrow(/host name, an ssh config alias, or user@host/);
  });
});

describe("resolveLiveTarget", () => {
  test("only auto looks anything up, and it hands the chooser to the lookup", async () => {
    const choose = vi.fn(async () => "laptop");
    const resolveTarget = vi.fn(async (_choose?: unknown) => ({
      kind: "remote" as const,
      host: "laptop",
      node: "nLAPTOP",
    }));
    await expect(
      resolveLiveTarget({ audioHost: " auto ", resolveTarget, choose }),
    ).resolves.toEqual({ kind: "remote", host: "laptop", node: "nLAPTOP" });
    expect(resolveTarget).toHaveBeenCalledWith(choose);
    for (const audioHost of [undefined, "", "  ", "laptop", "me@audio-pc"]) {
      await expect(
        resolveLiveTarget({ audioHost, resolveTarget, choose }),
      ).resolves.toBeUndefined();
    }
    expect(resolveTarget).toHaveBeenCalledOnce();
  });

  test("a cancelled choice and a refusal reach the caller", async () => {
    for (const reason of [new OriginCancelled(), new OriginError("no")]) {
      await expect(
        resolveLiveTarget({
          audioHost: "auto",
          resolveTarget: async () => {
            throw reason;
          },
        }),
      ).rejects.toBe(reason);
    }
  });
});

describe("resolveLiveMedia", () => {
  test("this computer keeps the local media and starts nothing", async () => {
    const spawn = vi.fn();
    await expect(
      resolveLiveMedia({
        audioHost: "auto",
        resolveTarget: async () => ({ kind: "local" }),
        spawn,
      }),
    ).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  test("a refusal reaches the caller and nothing is started", async () => {
    const spawn = vi.fn();
    await expect(
      resolveLiveMedia({
        audioHost: "auto",
        resolveTarget: async () => {
          throw new OriginError("cannot tell");
        },
        spawn,
      }),
    ).rejects.toThrow("cannot tell");
    expect(spawn).not.toHaveBeenCalled();
  });

  test("a remote computer is reached over ssh and must answer as the computer that typed", async () => {
    const ssh = new FakeSsh();
    const spawn = vi.fn(() => ssh);
    const createMedia = await resolveLiveMedia({
      audioHost: "auto",
      resolveTarget: async () => ({ kind: "remote", host: "laptop", node: "nLAPTOP" }),
      spawn,
    });
    expect(spawn).not.toHaveBeenCalled();
    const media = createMedia!(callbacks());
    expect(spawn).toHaveBeenCalledWith("ssh", sshArguments("laptop"), expect.anything());

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

  describe("with an audio host chosen in the settings", () => {
    test("goes over ssh to that host, with no Herdr or Tailscale question", async () => {
      const ssh = new FakeSsh();
      const spawn = vi.fn(() => ssh);
      const resolveTarget = vi.fn(async () => ({ kind: "local" }) as const);
      const createMedia = await resolveLiveMedia({
        audioHost: "me@audio-pc",
        resolveTarget,
        spawn,
      });
      expect(resolveTarget).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();

      const media = createMedia!(callbacks());
      expect(spawn).toHaveBeenCalledWith("ssh", sshArguments("me@audio-pc"), expect.anything());
      void media.createOffer().catch(() => undefined);
      // Any computer may answer, with or without a Tailscale node; the hello is still required.
      ssh.stdout.write(encodeFrame({ type: "hello" }));
      await vi.waitFor(() => expect(ssh.written[0]).toMatchObject({ method: "open" }));
      await media.close().catch(() => undefined);
    });

    test("still refuses a host that speaks before its hello", async () => {
      const ssh = new FakeSsh();
      const createMedia = await resolveLiveMedia({ audioHost: "audio-pc", spawn: () => ssh });
      const media = createMedia!(callbacks());
      const offer = media.createOffer();
      ssh.stdout.write(encodeFrame({ type: "levels", input: 0, output: 0 }));
      await expect(offer).rejects.toThrow(/before its hello/);
      expect(ssh.written).toEqual([]);
    });

    test("an unusable host name is an error, and nothing is started or guessed instead", async () => {
      const spawn = vi.fn();
      const resolveTarget = vi.fn(async () => ({ kind: "local" }) as const);
      await expect(
        resolveLiveMedia({ audioHost: "-oProxyCommand=x", resolveTarget, spawn }),
      ).rejects.toThrow(/cannot be used as an SSH host name/);
      expect(resolveTarget).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    test.each([undefined, "", "  "])(
      "an unset setting (%j) is this computer, and nothing is looked up or started",
      async (audioHost) => {
        const spawn = vi.fn();
        const resolveTarget = vi.fn(
          async () => ({ kind: "remote", host: "x", node: "n" }) as const,
        );
        await expect(
          resolveLiveMedia({ audioHost, resolveTarget, spawn }),
        ).resolves.toBeUndefined();
        expect(resolveTarget).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
      },
    );

    test("auto looks the computer up once", async () => {
      const resolveTarget = vi.fn(async () => ({ kind: "local" }) as const);
      await expect(resolveLiveMedia({ audioHost: "auto", resolveTarget })).resolves.toBeUndefined();
      expect(resolveTarget).toHaveBeenCalledOnce();
    });

    test("only the exact word auto asks; a host that merely starts with it is a host", async () => {
      const resolveTarget = vi.fn(async () => ({ kind: "local" }) as const);
      const createMedia = await resolveLiveMedia({ audioHost: "automation-pc", resolveTarget });
      expect(createMedia).toBeTypeOf("function");
      expect(resolveTarget).not.toHaveBeenCalled();
    });
  });
});
