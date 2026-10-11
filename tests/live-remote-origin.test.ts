import { spawn } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { OriginError, resolveMediaTarget } from "../src/live/remote/origin.ts";
import { sshConnectionOf } from "../src/live/remote/clients.ts";
import { selfNodeId, tailscaleJson } from "../src/live/remote/tailscale.ts";

const API = "/home/u/.config/herdr/herdr.sock";
const CLIENTS = "/home/u/.config/herdr/herdr-client.sock";
const IN_HERDR = { HERDR_SOCKET_PATH: API, HERDR_PANE_ID: "p_1" };
const SERVER = 100;
const FROM_LAPTOP = "100.96.150.40 51234 100.64.0.1 22";
const FROM_DESKTOP = "100.96.150.41 40000 100.64.0.1 22";
const ASKED_AT = 10_000;

const owners = (...pids: number[]) =>
  `users:(${pids.map((pid) => `("herdr",pid=${pid},fd=3)`).join(",")})`;

/** `ss -x -a -n -p` of a machine where one Herdr server runs, with the given clients attached. */
function unixSockets(clients: number[], options: { other?: string[]; api?: number[] } = {}) {
  const lines = [
    `u_str LISTEN 0 4096 ${API} 11 * 0 ${owners(SERVER)}`,
    `u_str LISTEN 0 4096 ${CLIENTS} 12 * 0 ${owners(SERVER)}`,
    `u_str ESTAB 0 0 * 21 * 20 ${owners(SERVER)}`,
    `u_str ESTAB 0 0 * 20 * 21 ${owners(SERVER)}`,
    `u_str ESTAB 0 0 /run/user/1000/bus 30 * 31 users:(("dbus-broker",pid=9,fd=7))`,
    `u_str ESTAB 0 0 * 31 * 30 users:(("steam",pid=8,fd=7))`,
  ];
  clients.forEach((pid, n) => {
    const server = 1000 + n * 2;
    lines.push(`u_str ESTAB 0 0 ${CLIENTS} ${server} * ${server + 1} ${owners(SERVER)}`);
    lines.push(`u_str ESTAB 0 0 * ${server + 1} * ${server} ${owners(pid, pid)}`);
  });
  // A short-lived `herdr pane ...` talks to the API socket, which is not an attached client.
  for (const pid of options.api ?? []) {
    lines.push(`u_str ESTAB 0 0 ${API} 2000 * 2001 ${owners(SERVER)}`);
    lines.push(`u_str ESTAB 0 0 * 2001 * 2000 ${owners(pid)}`);
  }
  return [...lines, ...(options.other ?? [])].join("\n");
}

/** `ss -t -i` for one established connection, as the kernel reports it. */
function tcpInfo(local: string, peer: string, lastrcv: number) {
  return (
    `0 0 ${local} ${peer}\n` +
    `\t cubic wscale:10,10 rto:214 bytes_sent:920066 bytes_received:168550 segs_in:12263 ` +
    `data_segs_in:4466 lastsnd:${lastrcv + 5} lastrcv:${lastrcv} lastack:1975 pacing_rate 1bps\n`
  );
}

interface World {
  unix?: string;
  /** Milliseconds since each connection's peer last sent data, keyed by the SSH_CONNECTION. */
  lastrcv?: Record<string, number>;
  /** SSH_CONNECTION of each client process; a process missing here has none. */
  connections?: Record<number, string>;
  clock?: number;
}

function world(w: World = {}) {
  const ss = vi.fn(async (args: string[]) => {
    if (args.includes("-x")) {
      if (w.unix === undefined)
        throw Object.assign(new Error("spawn ss ENOENT"), { code: "ENOENT" });
      return w.unix;
    }
    const peer = args[args.indexOf("dst") + 1];
    const entry = Object.entries(w.lastrcv ?? {}).find(([connection]) => {
      const [source, port] = connection.split(" ");
      return peer === `${source}:${port}`;
    });
    return entry ? tcpInfo(args[args.indexOf("src") + 1] ?? "", peer ?? "", entry[1]) : "";
  });
  const connectionOf = vi.fn(async (pid: number) => w.connections?.[pid]);
  return {
    ss,
    sshConnectionOf: connectionOf,
    askedAt: ASKED_AT,
    now: () => ASKED_AT + (w.clock ?? 30),
    platform: "linux" as const,
  };
}

/** A tailnet where this computer is nB, owned by user 7, with a laptop, a desktop, a Mac and a stranger's box. */
function tailnet() {
  const calls: string[][] = [];
  const nodes: Record<string, { StableID: string; Name: string; User?: number }> = {
    "100.96.150.40": { StableID: "nLAPTOP", Name: "laptop.example.ts.net." },
    "100.96.150.41": { StableID: "nDESKTOP", Name: "desktop.example.ts.net." },
    "100.96.150.42": { StableID: "nMAC", Name: "mac.example.ts.net." },
    "100.96.150.43": { StableID: "nWIN", Name: "win.example.ts.net." },
    "100.96.150.44": { StableID: "nSTRANGER", Name: "box.example.ts.net.", User: 8 },
    "100.96.150.45": { StableID: "nB", Name: "this.example.ts.net." },
  };
  const run = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === "whois") {
      const node = nodes[String(args[2])] ?? { StableID: "", Name: "" };
      return { Node: { User: 7, ...node } };
    }
    return {
      Self: { ID: "nB", UserID: 7 },
      Peer: {
        "key:1": { ID: "nLAPTOP", OS: "linux" },
        "key:2": { ID: "nDESKTOP", OS: "linux" },
        "key:3": { ID: "nMAC", OS: "macOS" },
        "key:4": { ID: "nWIN", OS: "windows" },
        "key:5": { ID: "nSTRANGER", OS: "linux" },
      },
    };
  });
  return { run, calls };
}

const from = (address: string) => `${address} 51234 100.64.0.1 22`;

async function resolve(
  env: NodeJS.ProcessEnv,
  options: { tailscale?: ReturnType<typeof tailnet>["run"]; w?: World } = {},
) {
  const t = tailnet();
  return resolveMediaTarget({ env, tailscale: options.tailscale ?? t.run, ...world(options.w) });
}

describe("outside Herdr, the computer you are connected from", () => {
  test("with nothing to go on is this computer, and nobody is asked", async () => {
    const t = tailnet();
    const w = world();
    await expect(resolveMediaTarget({ env: {}, tailscale: t.run, ...w })).resolves.toEqual({
      kind: "local",
    });
    // A Herdr socket without a pane is not a pane: Pi is not typed into through it.
    await expect(
      resolveMediaTarget({ env: { HERDR_SOCKET_PATH: API }, tailscale: t.run, ...w }),
    ).resolves.toEqual({ kind: "local" });
    expect(t.run).not.toHaveBeenCalled();
    expect(w.ss).not.toHaveBeenCalled();
  });

  test("an SSH session from another tailnet computer is that computer", async () => {
    const t = tailnet();
    await expect(
      resolve({ SSH_CONNECTION: from("100.96.150.40") }, { tailscale: t.run }),
    ).resolves.toEqual({ kind: "remote", host: "laptop", node: "nLAPTOP" });
    expect(t.calls).toContainEqual(["whois", "--json", "100.96.150.40"]);
  });

  test("a local proxy's source port, not its loopback address, names the peer", async () => {
    for (const [connection, endpoint] of [
      ["127.0.0.1 40000 127.0.0.1 22", "127.0.0.1:40000"],
      ["::1 40000 ::1 22", "[::1]:40000"],
    ] as const) {
      const t = tailnet();
      await resolve({ SSH_CONNECTION: connection }, { tailscale: t.run });
      expect(t.calls).toContainEqual(["whois", "--json", endpoint]);
    }
  });

  test("an SSH session from this very computer is this computer", async () => {
    await expect(resolve({ SSH_CONNECTION: from("100.96.150.45") })).resolves.toEqual({
      kind: "local",
    });
  });

  test.each(["SSH_CLIENT", "SSH_TTY"])(
    "%s without a connection to look up cannot be identified, so it refuses",
    async (marker) => {
      await expect(resolve({ [marker]: "x" })).rejects.toThrow(OriginError);
      await expect(resolve({ [marker]: "x" })).rejects.toThrow(/cannot be told/);
    },
  );

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
    await expect(resolve({ SSH_CONNECTION: connection }, { tailscale: t.run })).rejects.toThrow(
      OriginError,
    );
    expect(t.run).not.toHaveBeenCalled();
  });

  test.each([
    ["another Tailscale user's computer", "100.96.150.44", /another Tailscale user/],
    ["a Mac, which is not supported yet", "100.96.150.42", /macOS.*audio computer yet.*Linux/],
    ["a Windows PC, which is not supported yet", "100.96.150.43", /windows.*audio computer yet/],
    ["a computer Tailscale does not know", "100.96.150.99", /did not identify/],
  ])("%s refuses", async (_name, address, message) => {
    await expect(resolve({ SSH_CONNECTION: from(address) })).rejects.toThrow(message);
  });

  test.each([
    ["a name that could become an ssh option", "-oProxyCommand=x.ts.net."],
    ["a name with spaces", "my laptop.ts.net."],
  ])("%s refuses", async (_name, Name) => {
    const t = tailnet();
    const run = vi.fn(async (args: string[]) =>
      args[0] === "whois" ? { Node: { StableID: "nLAPTOP", Name, User: 7 } } : t.run(args),
    );
    await expect(
      resolve({ SSH_CONNECTION: from("100.96.150.40") }, { tailscale: run }),
    ).rejects.toThrow(/cannot be used/);
  });

  test("missing or failing Tailscale refuses, never falls back to this computer", async () => {
    const failing = vi.fn(async () => {
      throw new Error("The Tailscale CLI was not found.");
    });
    await expect(
      resolve({ SSH_CONNECTION: from("100.96.150.40") }, { tailscale: failing }),
    ).rejects.toThrow(/Tailscale could not identify.*not found/);
  });

  test.each(["TMUX", "STY", "ZELLIJ"])(
    "inside %s a stale SSH variable cannot say who types, so it refuses and names the setting",
    async (multiplexer) => {
      const env = { [multiplexer]: "1", SSH_CONNECTION: from("100.96.150.40") };
      await expect(resolve(env)).rejects.toThrow(/live\.audioHost/);
    },
  );

  test("inside tmux with no SSH variables it is this computer", async () => {
    await expect(resolve({ TMUX: "/tmp/tmux-1000/default,1,0" })).resolves.toEqual({
      kind: "local",
    });
  });
});

describe("inside Herdr, the computer attached to this pane's server", () => {
  const laptopOnly = () => ({
    unix: unixSockets([200]),
    connections: { 200: FROM_LAPTOP },
    lastrcv: { [FROM_LAPTOP]: 3000 },
  });

  test("ignores the SSH variables Pi inherited: panes carry the server's, not the typist's", async () => {
    const t = tailnet();
    await expect(
      resolve(
        { ...IN_HERDR, SSH_CONNECTION: from("100.96.150.40"), SSH_TTY: "/dev/pts/3" },
        { tailscale: t.run, w: { unix: unixSockets([300]) } },
      ),
    ).resolves.toEqual({ kind: "local" });
    expect(t.run).not.toHaveBeenCalled();
  });

  test("one remote client, over SSH, is the computer it came from", async () => {
    const t = tailnet();
    const w = world(laptopOnly());
    await expect(resolveMediaTarget({ env: IN_HERDR, tailscale: t.run, ...w })).resolves.toEqual({
      kind: "remote",
      host: "laptop",
      node: "nLAPTOP",
    });
    // Only the one client exists, so nobody has to measure who typed.
    expect(w.ss.mock.calls.every(([args]) => args.includes("-x"))).toBe(true);
  });

  test("one local client is this computer, without asking Tailscale", async () => {
    const t = tailnet();
    await expect(
      resolve(IN_HERDR, { tailscale: t.run, w: { unix: unixSockets([300]) } }),
    ).resolves.toEqual({ kind: "local" });
    expect(t.run).not.toHaveBeenCalled();
  });

  test("several local clients are still this computer", async () => {
    await expect(resolve(IN_HERDR, { w: { unix: unixSockets([300, 301]) } })).resolves.toEqual({
      kind: "local",
    });
  });

  test("a client's other end only counts on this pane's server, not on its API or another server", async () => {
    const anotherServer = [
      `u_str LISTEN 0 4096 /home/u/other/herdr-client.sock 41 * 0 ${owners(900)}`,
      `u_str ESTAB 0 0 /home/u/other/herdr-client.sock 3000 * 3001 ${owners(900)}`,
      `u_str ESTAB 0 0 * 3001 * 3000 ${owners(500)}`,
    ];
    // 400 is a one-off CLI on the API socket, 500 is attached to another session's server.
    await expect(
      resolve(IN_HERDR, {
        w: {
          unix: unixSockets([300], { api: [400], other: anotherServer }),
          connections: { 400: FROM_LAPTOP, 500: FROM_LAPTOP },
        },
      }),
    ).resolves.toEqual({ kind: "local" });
  });

  test("refuses when it cannot find this pane's server or any client of it", async () => {
    await expect(
      resolve({ ...IN_HERDR, HERDR_SOCKET_PATH: "/elsewhere/herdr.sock" }, { w: laptopOnly() }),
    ).rejects.toThrow(/Herdr server/);
    await expect(resolve(IN_HERDR, { w: { unix: unixSockets([]) } })).rejects.toThrow(
      /no Herdr client/,
    );
  });

  test("refuses, naming the setting, when a client's origin cannot be read", async () => {
    // The process exists but its environment is not readable: it could be anywhere.
    const unreadable = world({ unix: unixSockets([200]) });
    unreadable.sshConnectionOf.mockRejectedValue(new Error("EACCES"));
    await expect(
      resolveMediaTarget({ env: IN_HERDR, tailscale: tailnet().run, ...unreadable }),
    ).rejects.toThrow(/live\.audioHost/);
  });

  test("refuses without Linux's /proc and ss, and says what would work", async () => {
    await expect(
      resolveMediaTarget({
        env: IN_HERDR,
        tailscale: tailnet().run,
        ...world(laptopOnly()),
        platform: "darwin",
      }),
    ).rejects.toThrow(/needs Linux.*live\.audioHost/s);
    await expect(resolve(IN_HERDR, { w: {} })).rejects.toThrow(/`ss`/);
  });

  describe("with several computers attached, whoever's keystroke just arrived", () => {
    const both = (lastrcv: Record<string, number>) => ({
      unix: unixSockets([200, 300]),
      connections: { 200: FROM_LAPTOP },
      lastrcv,
    });

    test("the remote one whose connection just received data typed", async () => {
      await expect(resolve(IN_HERDR, { w: both({ [FROM_LAPTOP]: 12 }) })).resolves.toEqual({
        kind: "remote",
        host: "laptop",
        node: "nLAPTOP",
      });
    });

    test("data that arrived before the keystroke is a heartbeat, so the local client typed", async () => {
      // 4 s ago: well before the 30 ms between the keystroke and this lookup.
      await expect(resolve(IN_HERDR, { w: both({ [FROM_LAPTOP]: 4_000 }) })).resolves.toEqual({
        kind: "local",
      });
      // 300 ms is still before the keystroke, even allowing for Herdr's own latency.
      await expect(resolve(IN_HERDR, { w: both({ [FROM_LAPTOP]: 300 }) })).resolves.toEqual({
        kind: "local",
      });
    });

    test("tolerates the delay from the network to the pane, but not more", async () => {
      // Arrived 140 ms before the lookup started, 110 ms before the keystroke.
      await expect(resolve(IN_HERDR, { w: both({ [FROM_LAPTOP]: 140 }) })).resolves.toMatchObject({
        kind: "remote",
      });
      await expect(resolve(IN_HERDR, { w: both({ [FROM_LAPTOP]: 190 }) })).resolves.toEqual({
        kind: "local",
      });
    });

    test("a connection the kernel no longer lists did not type", async () => {
      await expect(resolve(IN_HERDR, { w: both({}) })).resolves.toEqual({ kind: "local" });
    });

    test("two remote computers: the one that just received data typed", async () => {
      const w = {
        unix: unixSockets([200, 201]),
        connections: { 200: FROM_LAPTOP, 201: FROM_DESKTOP },
      };
      await expect(
        resolve(IN_HERDR, { w: { ...w, lastrcv: { [FROM_LAPTOP]: 3_000, [FROM_DESKTOP]: 8 } } }),
      ).resolves.toMatchObject({ kind: "remote", host: "desktop" });
    });

    test("two remote computers that both just received data are ambiguous, and it says who", async () => {
      const w = {
        unix: unixSockets([200, 201, 300]),
        connections: { 200: FROM_LAPTOP, 201: FROM_DESKTOP },
        lastrcv: { [FROM_LAPTOP]: 8, [FROM_DESKTOP]: 20 },
      };
      const refusal = resolve(IN_HERDR, { w });
      await expect(refusal).rejects.toThrow(/laptop.*desktop|desktop.*laptop/);
      await expect(refusal).rejects.toThrow(/live\.audioHost/);
    });

    test("only remote computers and none just typed: refuses rather than guess", async () => {
      const w = {
        unix: unixSockets([200, 201]),
        connections: { 200: FROM_LAPTOP, 201: FROM_DESKTOP },
        lastrcv: { [FROM_LAPTOP]: 3_000, [FROM_DESKTOP]: 4_000 },
      };
      await expect(resolve(IN_HERDR, { w })).rejects.toThrow(/laptop.*desktop|desktop.*laptop/);
    });

    test("data that arrives after the keystroke is not the keystroke", async () => {
      // The lookup ran 5 s late; a heartbeat 12 ms ago says nothing about what was typed at ASKED_AT.
      const w = both({ [FROM_LAPTOP]: 12 });
      await expect(resolve(IN_HERDR, { w: { ...w, clock: 5_030 } })).resolves.toEqual({
        kind: "local",
      });
    });

    test("asks the kernel about exactly the connection the client came in on", async () => {
      const w = world(both({ [FROM_LAPTOP]: 12 }));
      await resolveMediaTarget({ env: IN_HERDR, tailscale: tailnet().run, ...w });
      const tcp = w.ss.mock.calls.map(([args]) => args).filter((args) => args.includes("-t"));
      expect(tcp).toEqual([
        [
          "-H",
          "-n",
          "-t",
          "-i",
          "state",
          "established",
          "src",
          "100.64.0.1:22",
          "dst",
          "100.96.150.40:51234",
        ],
      ]);
    });
  });
});

describe("the SSH connection of a process", () => {
  test.skipIf(process.platform !== "linux")(
    "is read from that process's environment, and nothing else is",
    async () => {
      const child = spawn("sleep", ["30"], {
        env: { PATH: process.env.PATH, SSH_CONNECTION: FROM_LAPTOP, SSH_CLIENT: "other" },
        stdio: "ignore",
      });
      try {
        await expect(sshConnectionOf(child.pid ?? 0)).resolves.toBe(FROM_LAPTOP);
      } finally {
        child.kill("SIGKILL");
      }
      const bare = spawn("sleep", ["30"], { env: { PATH: process.env.PATH }, stdio: "ignore" });
      try {
        await expect(sshConnectionOf(bare.pid ?? 0)).resolves.toBeUndefined();
      } finally {
        bare.kill("SIGKILL");
      }
    },
  );
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
