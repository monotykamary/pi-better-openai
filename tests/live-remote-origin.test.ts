import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createHerdrClient,
  type HerdrClient,
  OriginError,
  resolveMediaTarget,
} from "../src/live/remote/origin.ts";
import { selfNodeId, tailscaleJson } from "../src/live/remote/tailscale.ts";

const IN_HERDR = { HERDR_SOCKET_PATH: "/herdr.sock", HERDR_PANE_ID: "p_1" };
const TYPED_LOCALLY = { source: "client", client: { connected: true, via: "local" } };
const typedOver = (sshConnection: string, via = "ssh_bridge") => ({
  source: "client",
  client: { connected: true, via, ssh_connection: sshConnection },
});
const FROM_LAPTOP = "100.96.150.40 51234 100.64.0.1 22";

function herdr(input: unknown = TYPED_LOCALLY, capabilities: unknown = { pane_last_input: true }) {
  const client = {
    capabilities: vi.fn(async () => capabilities as Record<string, unknown>),
    lastInput: vi.fn(async () => {
      if (input instanceof Error) throw input;
      return input;
    }),
  };
  return client satisfies HerdrClient;
}

/** A tailnet where this computer is nB, owned by user 7, with a laptop, a Mac and a stranger's box. */
function tailnet(whois: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const run = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === "whois") {
      return {
        Node: { StableID: "nLAPTOP", Name: "omarchybook.tailb4e5ae.ts.net.", User: 7, ...whois },
      };
    }
    return {
      Self: { ID: "nB", UserID: 7 },
      Peer: {
        "key:1": { ID: "nLAPTOP", OS: "linux" },
        "key:2": { ID: "nMAC", OS: "macOS" },
        "key:3": { ID: "nWIN", OS: "windows" },
      },
    };
  });
  return { run, calls };
}

async function resolve(
  env: NodeJS.ProcessEnv,
  options: { herdr?: HerdrClient; tailscale?: ReturnType<typeof tailnet>["run"] } = {},
) {
  return resolveMediaTarget({ env, herdr: options.herdr ?? herdr(), tailscale: options.tailscale });
}

describe("which computer's microphone /live uses", () => {
  test("outside Herdr and SSH it is this computer, without asking anyone", async () => {
    const h = herdr();
    const t = tailnet();
    await expect(resolve({}, { herdr: h, tailscale: t.run })).resolves.toEqual({ kind: "local" });
    await expect(
      resolve({ HERDR_SOCKET_PATH: "/herdr.sock" }, { herdr: h, tailscale: t.run }),
    ).resolves.toEqual({ kind: "local" });
    expect(h.capabilities).not.toHaveBeenCalled();
    expect(t.run).not.toHaveBeenCalled();
  });

  test.each(["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"])(
    "outside Herdr, %s changes nothing: it is this computer, as before",
    async (marker) => {
      const h = herdr();
      const t = tailnet();
      await expect(resolve({ [marker]: "x" }, { herdr: h, tailscale: t.run })).resolves.toEqual({
        kind: "local",
      });
      expect(h.capabilities).not.toHaveBeenCalled();
      expect(t.run).not.toHaveBeenCalled();
    },
  );

  test("a Herdr that does not report who typed changes nothing: it is this computer", async () => {
    for (const capabilities of [{}, { pane_last_input: false }, { pane_last_input: "yes" }]) {
      const h = herdr(typedOver(FROM_LAPTOP), capabilities);
      const t = tailnet();
      await expect(
        resolve({ ...IN_HERDR, SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, { herdr: h, tailscale: t.run }),
      ).resolves.toEqual({ kind: "local" });
      expect(h.lastInput).not.toHaveBeenCalled();
      expect(t.run).not.toHaveBeenCalled();
    }
  });

  test("a Herdr that cannot be asked is a Herdr that does not report it: this computer", async () => {
    const unreachable = herdr();
    unreachable.capabilities.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(resolve(IN_HERDR, { herdr: unreachable })).resolves.toEqual({ kind: "local" });
  });

  test("a client that typed locally is this computer, whatever the environment says", async () => {
    const h = herdr();
    await expect(
      resolve({ ...IN_HERDR, SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, { herdr: h }),
    ).resolves.toEqual({ kind: "local" });
    expect(h.lastInput).toHaveBeenCalledWith("p_1");
  });

  test.each([
    ["nothing typed by a client", { source: "agent" }, /Type in this Herdr pane/],
    ["no record at all", null, /Type in this Herdr pane/],
    [
      "a disconnected client",
      { source: "client", client: { connected: false, via: "local" } },
      /disconnected/,
    ],
    [
      "an unknown connection type",
      { source: "client", client: { connected: true, via: "web" } },
      /does not know/,
    ],
    [
      "an SSH client without its address",
      { source: "client", client: { connected: true, via: "ssh_bridge" } },
      /does not know/,
    ],
    ["a failed lookup", new Error("boom"), /could not tell/i],
  ])("%s refuses instead of guessing a microphone", async (_name, input, message) => {
    const t = tailnet();
    await expect(resolve(IN_HERDR, { herdr: herdr(input), tailscale: t.run })).rejects.toThrow(
      message,
    );
    expect(t.run).not.toHaveBeenCalled();
  });

  test("an SSH client on the same tailnet and account is the laptop it came from", async () => {
    const t = tailnet();
    await expect(
      resolve(IN_HERDR, { herdr: herdr(typedOver(FROM_LAPTOP)), tailscale: t.run }),
    ).resolves.toEqual({ kind: "remote", host: "omarchybook", node: "nLAPTOP" });
    expect(t.calls).toContainEqual(["whois", "--json", "100.96.150.40"]);
  });

  test("a local proxy's source port, not its loopback address, names the peer", async () => {
    for (const [connection, endpoint] of [
      ["127.0.0.1 40000 127.0.0.1 22", "127.0.0.1:40000"],
      ["::1 40000 ::1 22", "[::1]:40000"],
    ] as const) {
      const t = tailnet();
      await resolve(IN_HERDR, { herdr: herdr(typedOver(connection, "local")), tailscale: t.run });
      expect(t.calls).toContainEqual(["whois", "--json", endpoint]);
    }
  });

  test.each([
    "garbage",
    "100.96.150.40 51234 100.64.0.1",
    "100.96.150.40 51234 100.64.0.1 22 extra",
    "not-an-ip 51234 100.64.0.1 22",
    "100.96.150.40 0 100.64.0.1 22",
    "100.96.150.40 51234 100.64.0.1 70000",
    "100.96.150.40 51234 ; 22",
  ])("a malformed SSH connection (%s) refuses before asking Tailscale", async (connection) => {
    const t = tailnet();
    await expect(
      resolve(IN_HERDR, { herdr: herdr(typedOver(connection)), tailscale: t.run }),
    ).rejects.toThrow(OriginError);
    expect(t.run).not.toHaveBeenCalled();
  });

  test("the typing computer being this one means this computer's microphone", async () => {
    const t = tailnet({ StableID: "nB" });
    await expect(
      resolve(IN_HERDR, { herdr: herdr(typedOver(FROM_LAPTOP)), tailscale: t.run }),
    ).resolves.toEqual({ kind: "local" });
  });

  test.each([
    ["another Tailscale user's computer", { User: 8 }, /another Tailscale user/],
    ["a tagged computer", { User: 99, Tags: ["tag:server"] }, /another Tailscale user/],
    ["a computer missing from the peer list", { StableID: "nUNKNOWN" }, /peer list/],
    ["a Mac, which is not supported yet", { StableID: "nMAC" }, /macOS.*yet/],
    ["a Windows PC, which is not supported yet", { StableID: "nWIN" }, /windows.*yet/],
    [
      "a name that could become an ssh option",
      { Name: "-oProxyCommand=x.ts.net." },
      /cannot be used/,
    ],
    ["a name with spaces", { Name: "my laptop.ts.net." }, /cannot be used/],
    ["no stable id", { StableID: undefined }, /did not identify/],
  ])("%s refuses", async (_name, whois, message) => {
    await expect(
      resolve(IN_HERDR, { herdr: herdr(typedOver(FROM_LAPTOP)), tailscale: tailnet(whois).run }),
    ).rejects.toThrow(message);
  });

  test("missing or failing Tailscale refuses, never falls back to this computer", async () => {
    const failing = vi.fn(async () => {
      throw new Error("The Tailscale CLI was not found.");
    });
    await expect(
      resolve(IN_HERDR, { herdr: herdr(typedOver(FROM_LAPTOP)), tailscale: failing }),
    ).rejects.toThrow(/Tailscale could not identify.*not found/);
  });
});

describe("Tailscale lookups", () => {
  test("self node id comes from status, and any failure is simply no id", async () => {
    await expect(selfNodeId(async () => ({ Self: { ID: "nABC" } }))).resolves.toBe("nABC");
    await expect(selfNodeId(async () => ({ Self: {} }))).resolves.toBeUndefined();
    await expect(
      selfNodeId(async () => {
        throw new Error("down");
      }),
    ).resolves.toBeUndefined();
  });

  test("finds the CLI on PATH, then in the app locations, and reports a missing one", async () => {
    const tried: string[] = [];
    const exec = async (file: string) => {
      tried.push(file);
      if (file.includes("Applications")) return { stdout: '{"Self":{"ID":"nMAC"}}' };
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    };
    await expect(tailscaleJson(["status", "--json"], exec)).resolves.toEqual({
      Self: { ID: "nMAC" },
    });
    expect(tried[0]).toBe("tailscale");
    await expect(
      tailscaleJson(["status"], async () => {
        throw Object.assign(new Error("nope"), { code: "ENOENT" });
      }),
    ).rejects.toThrow("Tailscale CLI was not found");
    await expect(
      tailscaleJson(["status"], async () => {
        throw new Error("exit 1");
      }),
    ).rejects.toThrow("exit 1");
  });
});

describe("Herdr transport", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function fakeHerdr(
    answer: (request: { id: string; method: string; params: unknown }) => string,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "hd-"));
    dirs.push(dir);
    const path = join(dir, "herdr.sock");
    const requests: Array<{ method: string; params: unknown }> = [];
    const server = createServer((socket) => {
      // The client hangs up as soon as it has what it needs, which can reset this side.
      socket.on("error", () => undefined);
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString());
        requests.push(request);
        socket.end(answer(request));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return { path, requests };
  }

  describe.skipIf(process.platform === "win32")("over a unix socket", () => {
    test("asks over the socket and unwraps the result", async () => {
      const fake = await fakeHerdr(
        (request) =>
          `${JSON.stringify({
            id: request.id,
            result:
              request.method === "ping"
                ? { capabilities: { pane_last_input: true } }
                : { last_input: TYPED_LOCALLY },
          })}\n`,
      );
      const client = createHerdrClient({ env: { HERDR_SOCKET_PATH: fake.path } });
      await expect(client.capabilities()).resolves.toEqual({ pane_last_input: true });
      await expect(client.lastInput("p_9")).resolves.toEqual(TYPED_LOCALLY);
      expect(fake.requests.map((r) => r.method)).toEqual(["ping", "pane.last_input"]);
      expect(fake.requests[1]?.params).toEqual({ pane_id: "p_9" });
    });

    test.each([
      ["an error answer", (id: string) => `${JSON.stringify({ id, error: { code: "x" } })}\n`],
      ["an answer for another request", () => `${JSON.stringify({ id: "other", result: {} })}\n`],
      ["an unterminated answer", (id: string) => JSON.stringify({ id, result: {} })],
      ["an oversized answer", () => `${"x".repeat(1_100_000)}\n`],
    ])("rejects %s", async (_name, reply) => {
      const fake = await fakeHerdr((request) => reply(request.id));
      const client = createHerdrClient({ env: { HERDR_SOCKET_PATH: fake.path } });
      await expect(client.capabilities()).rejects.toThrow();
    });
  });

  test("on Windows it uses Herdr's own CLI, which knows the named pipe", async () => {
    const run = vi.fn(
      async (args: string[]): Promise<Record<string, unknown>> =>
        args[0] === "status"
          ? { running: true, capabilities: { pane_last_input: true } }
          : { result: { type: "pane_last_input", pane_id: "p_9", last_input: TYPED_LOCALLY } },
    );
    const client = createHerdrClient({ env: {}, platform: "win32", runCli: run });
    await expect(client.capabilities()).resolves.toEqual({ pane_last_input: true });
    await expect(client.lastInput("p_9")).resolves.toEqual(TYPED_LOCALLY);
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["status", "server", "--json"],
      ["pane", "last-input", "p_9"],
    ]);

    run.mockResolvedValueOnce({ running: false });
    await expect(client.capabilities()).rejects.toThrow(/unavailable/);
    run.mockResolvedValueOnce({ result: { type: "pane_last_input", pane_id: "other" } });
    await expect(client.lastInput("p_9")).rejects.toThrow(/unexpected/);
  });
});
