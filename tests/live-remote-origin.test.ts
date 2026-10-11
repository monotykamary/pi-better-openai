import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { describe, expect, test, vi } from "vitest";
import { OriginCancelled, OriginError, resolveMediaTarget } from "../src/live/remote/origin.ts";
import {
  type ProcessInfo,
  hasTerminal,
  herdrClientPids,
  isLocalHerdrClient,
  parseProcessTable,
  remoteHerdrClients,
  runProcessTable,
  sshConnectionOf,
} from "../src/live/remote/clients.ts";
import { selfNodeId, tailscaleJson } from "../src/live/remote/tailscale.ts";

const API = "/home/u/.config/herdr/herdr.sock";
const CLIENTS = "/home/u/.config/herdr/herdr-client.sock";
const IN_HERDR = { HERDR_SOCKET_PATH: API, HERDR_PANE_ID: "p_1" };
const SERVER = 100;
const FROM_LAPTOP = "100.96.150.40 51234 100.64.0.1 22";
const FROM_DESKTOP = "100.96.150.41 40000 100.64.0.1 22";

const owners = (...pids: number[]) =>
  `users:(${pids.map((pid) => `("herdr",pid=${pid},fd=3)`).join(",")})`;

/** `ss -x -a -n -p` of a machine where one Herdr server runs, with the given clients attached. */
function unixSockets(
  clients: number[],
  options: {
    other?: string[];
    api?: number[];
    clientName?: string;
    /** Accepted connections whose client end `ss` shows without an owner (another user's or non-dumpable). */
    hidden?: number;
    /** Accepted connections whose client end `ss` does not show at all. */
    unlisted?: number;
    /** Accepted connections whose client already hung up. */
    closed?: number;
    /** The server hides itself from `ss` (non-dumpable): its sockets show no owner. */
    hiddenServer?: boolean;
  } = {},
) {
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
    lines.push(
      `u_str ESTAB 0 0 * ${server + 1} * ${server} ${owners(pid, pid).replaceAll('"herdr"', `"${options.clientName ?? "herdr"}"`)}`,
    );
  });
  const accepted = (peer: string, id: number) =>
    lines.push(`u_str ESTAB 0 0 ${CLIENTS} ${id} * ${peer} ${owners(SERVER)}`);
  for (let n = 0; n < (options.hidden ?? 0); n++) {
    accepted(String(3001 + n * 2), 3000 + n * 2);
    lines.push(`u_str ESTAB 0 0 * ${3001 + n * 2} * ${3000 + n * 2}`);
  }
  for (let n = 0; n < (options.unlisted ?? 0); n++) accepted(String(4001 + n * 2), 4000 + n * 2);
  for (let n = 0; n < (options.closed ?? 0); n++) accepted("0", 5000 + n * 2);
  // A short-lived `herdr pane ...` talks to the API socket, which is not an attached client.
  for (const pid of options.api ?? []) {
    lines.push(`u_str ESTAB 0 0 ${API} 2000 * 2001 ${owners(SERVER)}`);
    lines.push(`u_str ESTAB 0 0 * 2001 * 2000 ${owners(pid)}`);
  }
  const text = [...lines, ...(options.other ?? [])].join("\n");
  return options.hiddenServer ? text.replaceAll(` ${owners(SERVER)}`, "") : text;
}

interface World {
  unix?: string;
  /** SSH_CONNECTION of each client process; a process missing here has none. */
  connections?: Record<number, string>;
  /** Clients whose stdin is not a terminal, as a bridge's is (a pipe from sshd). */
  piped?: number[];
  /** The user's processes, for computers where the sockets are not read. */
  processes?: ProcessInfo[] | Error;
}

function world(w: World = {}) {
  const ss = vi.fn(async (args: string[]) => {
    if (!args.includes("-x")) throw new Error("only the unix socket table is ever read");
    if (w.unix === undefined) throw Object.assign(new Error("spawn ss ENOENT"), { code: "ENOENT" });
    return w.unix;
  });
  const connectionOf = vi.fn(async (pid: number) => w.connections?.[pid]);
  const isTerminal = vi.fn(async (pid: number) => !(w.piped ?? []).includes(pid));
  const processes = vi.fn(async () => {
    if (w.processes instanceof Error) throw w.processes;
    return w.processes ?? [];
  });
  return { ss, sshConnectionOf: connectionOf, isTerminal, processes, platform: "linux" as const };
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
    // A userspace Tailscale hands SSH over from loopback; the port names the peer.
    "127.0.0.1:40000": { StableID: "nLAPTOP", Name: "laptop.example.ts.net." },
    "[::1]:40000": { StableID: "nLAPTOP", Name: "laptop.example.ts.net." },
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

  describe("a server whose owner ss cannot show is left to the process list", () => {
    const hiddenServer = (processes?: ProcessInfo[] | Error, clients = [300]) => {
      const w = world({ unix: unixSockets(clients, { hiddenServer: true }), processes });
      return {
        w,
        result: resolveMediaTarget({ env: IN_HERDR, tailscale: tailnet().run, ...w }),
      };
    };

    test("is this computer when the list shows no remote Herdr client", async () => {
      const { result, w } = hiddenServer([...LOCAL_ONLY]);
      await expect(result).resolves.toEqual({ kind: "local" });
      expect(w.processes).toHaveBeenCalledOnce();
      expect(w.sshConnectionOf).not.toHaveBeenCalled();
    });

    test("refuses when the list shows a remote Herdr client", async () => {
      const { result } = hiddenServer([...LOCAL_ONLY, SSHD, BRIDGE]);
      await expect(result).rejects.toThrow(/remote Herdr client is attached/);
      await expect(result).rejects.toThrow(/owns this pane's Herdr server/);
      await expect(result).rejects.toThrow(/live\.audioHost/);
    });

    test("refuses when the list cannot be had", async () => {
      await expect(hiddenServer(new Error("spawn ps ENOENT")).result).rejects.toThrow(
        /Could not list the processes/,
      );
    });

    test("is not a server that is not there", async () => {
      const w = world({ unix: unixSockets([300], { hiddenServer: true }), processes: [] });
      await expect(
        resolveMediaTarget({
          env: { ...IN_HERDR, HERDR_SOCKET_PATH: "/elsewhere/herdr.sock" },
          tailscale: tailnet().run,
          ...w,
        }),
      ).rejects.toThrow(/Herdr server/);
      expect(w.processes).not.toHaveBeenCalled();
    });
  });

  test("refuses, naming the setting, when a client's origin cannot be read", async () => {
    // The process exists but its environment is not readable: it could be anywhere.
    const unreadable = world({ unix: unixSockets([200]) });
    unreadable.sshConnectionOf.mockRejectedValue(new Error("EACCES"));
    await expect(
      resolveMediaTarget({ env: IN_HERDR, tailscale: tailnet().run, ...unreadable }),
    ).rejects.toThrow(/live\.audioHost/);
  });

  test("a pane with no socket path to read the server from takes the process route", async () => {
    const w = world({ processes: [] });
    await expect(
      resolveMediaTarget({
        env: { HERDR_PANE_ID: "p_1", SSH_CONNECTION: from("100.96.150.40") },
        tailscale: tailnet().run,
        ...w,
      }),
    ).resolves.toEqual({ kind: "local" });
    expect(w.ss).not.toHaveBeenCalled();
    expect(w.processes).toHaveBeenCalledOnce();
  });

  describe("a client Pi does not recognize", () => {
    const attempt = (w: World) => resolve(IN_HERDR, { w });

    test("neither at a terminal nor over SSH: a renamed or redesigned bridge refuses", async () => {
      const refusal = attempt({ unix: unixSockets([200]), piped: [200] });
      await expect(refusal).rejects.toThrow(OriginError);
      await expect(refusal).rejects.toThrow(/can't tell which computer is connected to this Herdr/);
      await expect(refusal).rejects.toThrow(/live\.audioHost/);
    });

    test("not even next to a client that is recognized, local or remote", async () => {
      for (const w of [
        { unix: unixSockets([300, 301]), piped: [301] },
        { unix: unixSockets([200, 301]), connections: { 200: FROM_LAPTOP }, piped: [301] },
      ]) {
        await expect(attempt(w)).rejects.toThrow(/can't tell which computer is connected/);
      }
    });

    test("a client whose owner ss cannot show refuses: it is connected, but not placed", async () => {
      for (const hidden of [{ hidden: 1 }, { unlisted: 1 }]) {
        // Next to a local client, which on its own would have been this computer...
        const beside = attempt({ unix: unixSockets([300], hidden) });
        await expect(beside).rejects.toThrow(
          /can't tell which computer is connected to this Herdr/,
        );
        await expect(beside).rejects.toThrow(/live\.audioHost/);
        // ...and alone, which is not "no client attached" either.
        await expect(attempt({ unix: unixSockets([], hidden) })).rejects.toThrow(
          /can't tell which/,
        );
      }
    });

    test("a client that already hung up is not a client", async () => {
      await expect(attempt({ unix: unixSockets([300], { closed: 2 }) })).resolves.toEqual({
        kind: "local",
      });
    });

    test("a bridge is the computer its SSH connection names, whatever it is called", async () => {
      // Its input is a pipe and its name is new; only the connection it came in on matters.
      await expect(
        resolve(IN_HERDR, {
          w: {
            unix: unixSockets([200], { clientName: "tunnel-v2" }),
            connections: { 200: FROM_LAPTOP },
            piped: [200],
          },
        }),
      ).resolves.toEqual({ kind: "remote", host: "laptop", node: "nLAPTOP" });
    });

    test("a terminal that cannot be read refuses; one that left in the meantime is skipped", async () => {
      const unreadable = world({ unix: unixSockets([300]) });
      unreadable.isTerminal.mockRejectedValue(
        Object.assign(new Error("EACCES"), { code: "EACCES" }),
      );
      await expect(
        resolveMediaTarget({ env: IN_HERDR, tailscale: tailnet().run, ...unreadable }),
      ).rejects.toThrow(/live\.audioHost/);
      const gone = world({ unix: unixSockets([300, 301]) });
      gone.isTerminal.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ESRCH" }));
      await expect(
        resolveMediaTarget({ env: IN_HERDR, tailscale: tailnet().run, ...gone }),
      ).resolves.toEqual({ kind: "local" });
    });
  });

  describe("a client whose /proc cannot be read is left to the process list", () => {
    const denied = (processes: ProcessInfo[] | Error, clients = [300]) => {
      const w = world({ unix: unixSockets(clients), processes });
      w.sshConnectionOf.mockRejectedValue(
        Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
      );
      return {
        w,
        result: resolveMediaTarget({ env: IN_HERDR, tailscale: tailnet().run, ...w }),
      };
    };
    const CLIENT = proc(300, 3214, "herdr");

    test("is this computer when the list shows the client and no remote one", async () => {
      const { result, w } = denied([...LOCAL_ONLY, CLIENT]);
      await expect(result).resolves.toEqual({ kind: "local" });
      expect(w.processes).toHaveBeenCalledOnce();
    });

    test("also when it is the terminal check that is denied", async () => {
      const w = world({ unix: unixSockets([300]), processes: [...LOCAL_ONLY, CLIENT] });
      w.isTerminal.mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
      await expect(
        resolveMediaTarget({ env: IN_HERDR, tailscale: tailnet().run, ...w }),
      ).resolves.toEqual({ kind: "local" });
    });

    test("refuses when the list shows a remote Herdr client", async () => {
      const { result } = denied([...LOCAL_ONLY, CLIENT, SSHD, BRIDGE]);
      await expect(result).rejects.toThrow(/remote Herdr client is attached/);
      await expect(result).rejects.toThrow(/live\.audioHost/);
    });

    test("refuses when the list cannot be had", async () => {
      await expect(denied(new Error("spawn ps ENOENT")).result).rejects.toThrow(
        /Could not list the processes/,
      );
    });

    test("refuses when the list shows the client as something that is not a local herdr", async () => {
      // Present in the list, and not a bridge by name, but nothing says it is this computer's client.
      for (const stranger of [
        proc(300, 1338, "/opt/herdr/tunnel-v2 --stdio"),
        proc(300, 3214, "/opt/herdr/tunnel-v2 --stdio"),
        proc(300, 3214, "herdr server"),
        proc(300, 3214, "nc -U /run/user/1000/herdr-client.sock"),
      ]) {
        const { result } = denied([...LOCAL_ONLY, SSHD, stranger]);
        await expect(result).rejects.toThrow(/process 300.*not a local herdr/s);
        await expect(result).rejects.toThrow(/live\.audioHost/);
      }
      // A hidden command line is not a local herdr either; it is taken for a possible bridge.
      for (const hidden of ["herdr (unreadable command line)", ""]) {
        const { result } = denied([...LOCAL_ONLY, SSHD, proc(300, 1338, hidden)]);
        await expect(result).rejects.toThrow(/live\.audioHost/);
      }
    });

    test("a local herdr is told by its program, wherever it lives", async () => {
      for (const command of [
        "herdr",
        "/usr/local/bin/herdr",
        "/home/u/.local/bin/herdr --some-flag",
      ]) {
        await expect(denied([...LOCAL_ONLY, proc(300, 3214, command)]).result).resolves.toEqual({
          kind: "local",
        });
      }
    });

    test("refuses when the list does not show the client itself: it may be another user's", async () => {
      const { result } = denied([...LOCAL_ONLY]);
      await expect(result).rejects.toThrow(/process 300.*not in the process list/s);
      await expect(result).rejects.toThrow(/live\.audioHost/);
    });

    test("refuses next to a client that is known to be remote, whatever the list shows", async () => {
      const w = world({
        unix: unixSockets([200, 300]),
        connections: { 200: FROM_LAPTOP },
        processes: [...LOCAL_ONLY, CLIENT],
      });
      w.sshConnectionOf.mockImplementation(async (pid) => {
        if (pid === 300) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return pid === 200 ? FROM_LAPTOP : undefined;
      });
      await expect(
        resolveMediaTarget({ env: IN_HERDR, tailscale: tailnet().run, ...w }),
      ).rejects.toThrow(/live\.audioHost/);
    });
  });

  describe("with a chooser, several computers attached are asked about", () => {
    const THIS = `this computer (${hostname().split(".")[0]})`;
    const ask = (w: World, pick: (labels: string[]) => string | undefined) => {
      const choose = vi.fn(async (labels: string[], _notes: string[]) => pick(labels));
      const result = resolveMediaTarget({
        env: IN_HERDR,
        tailscale: tailnet().run,
        ...world(w),
        choose,
      });
      return { choose, result };
    };
    const laptopAndThis = { unix: unixSockets([200, 300]), connections: { 200: FROM_LAPTOP } };
    const LAPTOP = { kind: "remote", host: "laptop", node: "nLAPTOP" };

    test("this computer's own client and a remote one: both are offered, remote first", async () => {
      const { choose, result } = ask(laptopAndThis, (labels) => labels[0]);
      await expect(result).resolves.toEqual(LAPTOP);
      expect(choose).toHaveBeenCalledOnce();
      expect(choose).toHaveBeenCalledWith(["laptop", THIS], []);
    });

    test("choosing this computer is this computer", async () => {
      const { result } = ask(laptopAndThis, (labels) => labels.find((l) => l.startsWith("this")));
      await expect(result).resolves.toEqual({ kind: "local" });
    });

    test("two remote computers are offered by their Tailscale names", async () => {
      const { choose, result } = ask(
        { unix: unixSockets([200, 201]), connections: { 200: FROM_LAPTOP, 201: FROM_DESKTOP } },
        () => "desktop",
      );
      await expect(result).resolves.toEqual({ kind: "remote", host: "desktop", node: "nDESKTOP" });
      expect(choose).toHaveBeenCalledWith(["laptop", "desktop"], []);
    });

    test("Escape starts nothing: the lookup ends as cancelled, not as a computer", async () => {
      const { result } = ask(laptopAndThis, () => undefined);
      await expect(result).rejects.toBeInstanceOf(OriginCancelled);
      await expect(result).rejects.toBeInstanceOf(OriginError);
      await expect(result).rejects.toThrow(/No computer was chosen/);
    });

    test("an answer that was not offered is a cancel, never a guess", async () => {
      const { result } = ask(laptopAndThis, () => "mac");
      await expect(result).rejects.toBeInstanceOf(OriginCancelled);
    });

    test.each([
      ["a Mac", "100.96.150.42", /100\.96\.150\.42: .*macOS/],
      ["a Windows PC", "100.96.150.43", /100\.96\.150\.43: .*windows/i],
      [
        "another Tailscale user's computer",
        "100.96.150.44",
        /100\.96\.150\.44: .*another Tailscale user/,
      ],
      ["a computer Tailscale does not know", "100.96.150.99", /100\.96\.150\.99: /],
    ])("%s is not offered, and a note says why", async (_name, address, note) => {
      const { choose, result } = ask(
        {
          unix: unixSockets([200, 201]),
          connections: { 200: FROM_LAPTOP, 201: from(address) },
        },
        (labels) => labels[0],
      );
      await expect(result).resolves.toEqual(LAPTOP);
      const [labels, notes] = choose.mock.calls[0]!;
      expect(labels).toEqual(["laptop"]);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(note);
    });

    test("one usable computer among unusable ones is still asked: the unusable one may be the typist", async () => {
      const { choose, result } = ask(
        {
          unix: unixSockets([200, 300]),
          connections: { 200: from("100.96.150.42") },
        },
        () => undefined,
      );
      await expect(result).rejects.toBeInstanceOf(OriginCancelled);
      expect(choose.mock.calls[0]![0]).toEqual([THIS]);
      expect(choose.mock.calls[0]![1][0]).toMatch(/macOS/);
    });

    test("with nothing usable it refuses with the reasons and asks nothing", async () => {
      const { choose, result } = ask(
        {
          unix: unixSockets([200, 201]),
          connections: { 200: from("100.96.150.42"), 201: from("100.96.150.43") },
        },
        (labels) => labels[0],
      );
      await expect(result).rejects.toThrow(/macOS/);
      await expect(result).rejects.toThrow(/windows/i);
      await expect(result).rejects.toThrow(/live\.audioHost/);
      expect(choose).not.toHaveBeenCalled();
    });

    test("is never asked when one computer is the answer", async () => {
      const attached: World[] = [
        { unix: unixSockets([200]), connections: { 200: FROM_LAPTOP } },
        { unix: unixSockets([300]) },
        {
          unix: unixSockets([200, 201]),
          connections: { 200: FROM_LAPTOP, 201: from("100.96.150.40") },
        },
        { unix: unixSockets([200, 300]), connections: { 200: from("100.96.150.45") } },
      ];
      for (const w of attached) {
        const { choose, result } = ask(w, (labels) => labels[0]);
        await result;
        expect(choose).not.toHaveBeenCalled();
      }
    });

    test("is never asked outside Herdr", async () => {
      const choose = vi.fn(async () => "laptop");
      await expect(
        resolveMediaTarget({
          env: { SSH_CONNECTION: FROM_LAPTOP },
          tailscale: tailnet().run,
          ...world(),
          choose,
        }),
      ).resolves.toEqual(LAPTOP);
      expect(choose).not.toHaveBeenCalled();
    });
  });

  describe("without a chooser, several computers attached cannot be told apart, so it refuses", () => {
    const refusal = (w: World) => resolve(IN_HERDR, { w });

    test("this computer's own client and a remote one", async () => {
      const attempt = refusal({ unix: unixSockets([200, 300]), connections: { 200: FROM_LAPTOP } });
      await expect(attempt).rejects.toThrow(OriginError);
      await expect(attempt).rejects.toThrow(/this computer and laptop/);
      await expect(attempt).rejects.toThrow(/live\.audioHost/);
    });

    test("two remote computers", async () => {
      const attempt = refusal({
        unix: unixSockets([200, 201]),
        connections: { 200: FROM_LAPTOP, 201: FROM_DESKTOP },
      });
      await expect(attempt).rejects.toThrow(/laptop and desktop/);
      await expect(attempt).rejects.toThrow(/live\.audioHost/);
    });

    test("however recently one of them sent data: traffic cannot tell a keystroke from a keepalive", async () => {
      const w = world({
        unix: unixSockets([200, 300]),
        connections: { 200: FROM_LAPTOP },
      });
      await expect(
        resolveMediaTarget({ env: IN_HERDR, tailscale: tailnet().run, ...w }),
      ).rejects.toThrow(/live\.audioHost/);
      // It never even looks at the connection, so there is nothing a keepalive could fake.
      expect(w.ss.mock.calls.every(([args]) => args.includes("-x"))).toBe(true);
    });

    test("one computer with several connections is still one computer", async () => {
      await expect(
        resolve(IN_HERDR, {
          w: {
            unix: unixSockets([200, 201]),
            connections: { 200: FROM_LAPTOP, 201: "100.96.150.40 51999 100.64.0.1 22" },
          },
        }),
      ).resolves.toEqual({ kind: "remote", host: "laptop", node: "nLAPTOP" });
    });

    test("but that computer next to this computer's own client is two", async () => {
      await expect(
        refusal({
          unix: unixSockets([200, 201, 300]),
          connections: { 200: FROM_LAPTOP, 201: "100.96.150.40 51999 100.64.0.1 22" },
        }),
      ).rejects.toThrow(/this computer and laptop/);
    });

    test("a connection that is this computer's own is the same origin as its local client", async () => {
      await expect(
        resolve(IN_HERDR, {
          w: {
            unix: unixSockets([200, 300]),
            connections: { 200: "100.96.150.45 51234 100.64.0.1 22" },
          },
        }),
      ).resolves.toEqual({ kind: "local" });
    });

    test.each([
      [
        "another Tailscale user's computer",
        "100.96.150.44 40000 100.64.0.1 22",
        /100\.96\.150\.44/,
      ],
      [
        "a computer Tailscale does not know",
        "100.96.150.99 40000 100.64.0.1 22",
        /100\.96\.150\.99/,
      ],
    ])(
      "a computer it cannot identify (%s) is named by address",
      async (_name, connection, named) => {
        const attempt = refusal({
          unix: unixSockets([200, 201]),
          connections: { 200: FROM_LAPTOP, 201: connection },
        });
        await expect(attempt).rejects.toThrow(named);
        await expect(attempt).rejects.toThrow(/live\.audioHost/);
      },
    );

    test("Tailscale being down is still a refusal", async () => {
      const down = vi.fn(async () => {
        throw new Error("The Tailscale CLI was not found.");
      });
      await expect(
        resolve(IN_HERDR, {
          tailscale: down,
          w: { unix: unixSockets([200, 300]), connections: { 200: FROM_LAPTOP } },
        }),
      ).rejects.toThrow(/live\.audioHost/);
    });
  });

  test("a lone remote client that is not usable refuses with the reason, not as a guess", async () => {
    await expect(
      resolve(IN_HERDR, {
        w: {
          unix: unixSockets([200]),
          connections: { 200: "100.96.150.44 40000 100.64.0.1 22" },
        },
      }),
    ).rejects.toThrow(/another Tailscale user/);
  });
});

const proc = (pid: number, ppid: number, command: string): ProcessInfo => ({ pid, ppid, command });
const SSHD = proc(1338, 1, "sshd-session: ricardo@notty");
const SERVER_PROCESS = proc(741, 529, "herdr server");
const TERMINAL = proc(3214, 1, "foot --working-directory=/home/u -e herdr");
const LOCAL_CLIENT = proc(3235, 3214, "herdr");
const BRIDGE = proc(1366, 1338, "/Users/u/.local/bin/herdr remote-client-bridge --idle-timeout-v1");
// This computer's own Herdr client reaching other computers' servers: an ssh whose remote command is
// the bridge. It is the opposite direction, so it is not a remote client of this computer's server.
const OUTGOING = [
  proc(
    6419,
    3235,
    "ssh -C -F /tmp/herdr-ssh-3235-0/config -T mini printf ' %s ' 'herdr-remote-output-ready:1' exec /Users/u/.local/bin/herdr remote-client-bridge --idle-timeout-v1",
  ),
  proc(
    6463,
    3235,
    "ssh -T orgo exec /root/.local/bin/herdr remote-client-bridge --idle-timeout-v1",
  ),
];
const LOCAL_ONLY = [
  SERVER_PROCESS,
  TERMINAL,
  LOCAL_CLIENT,
  ...OUTGOING,
  proc(900, 1, "node /usr/bin/pi"),
];

describe("where Pi cannot read the clients of Herdr's server", () => {
  // macOS and Windows, and Linux where `ss` cannot run: the only evidence is the process list, and
  // it can only prove that no remote client exists. Whether one is the typist is not told.
  const places = [
    { name: "macOS", platform: "darwin" as const, unix: unixSockets([300]) },
    { name: "Windows", platform: "win32" as const, unix: unixSockets([300]) },
    { name: "Linux without ss", platform: "linux" as const, unix: undefined },
  ];
  const attempt = (
    place: (typeof places)[number],
    processes: ProcessInfo[] | Error,
    env: NodeJS.ProcessEnv = IN_HERDR,
  ) => {
    const w = world({ unix: place.unix, processes });
    const t = tailnet();
    return {
      w,
      t,
      result: resolveMediaTarget({ env, tailscale: t.run, ...w, platform: place.platform }),
    };
  };

  describe.each(places)("on $name", (place) => {
    test("with no remote Herdr client anywhere, this computer, asking nobody", async () => {
      const { result, w, t } = attempt(place, LOCAL_ONLY);
      await expect(result).resolves.toEqual({ kind: "local" });
      expect(t.run).not.toHaveBeenCalled();
      expect(w.sshConnectionOf).not.toHaveBeenCalled();
      if (place.platform !== "linux") expect(w.ss).not.toHaveBeenCalled();
    });

    test("this computer's own connections out to other servers are not remote clients of it", async () => {
      const { result } = attempt(place, [...LOCAL_ONLY, ...OUTGOING]);
      await expect(result).resolves.toEqual({ kind: "local" });
    });

    test("a remote-client bridge refuses, naming the setting and not guessing local", async () => {
      const { result, t } = attempt(place, [...LOCAL_ONLY, SSHD, BRIDGE]);
      await expect(result).rejects.toThrow(OriginError);
      await expect(result).rejects.toThrow(/remote Herdr client is attached/);
      await expect(result).rejects.toThrow(/live\.audioHost/);
      expect(t.run).not.toHaveBeenCalled();
    });

    test("a bridge under another subcommand or binary name is still seen through sshd", async () => {
      for (const renamed of [
        proc(1400, 1338, "/u/.local/bin/herdr tunnel --stdio"),
        proc(1400, 1338, "/opt/hd/relay"), // not even herdr: it is the bridge token that matters
      ]) {
        const table = renamed.command.endsWith("relay")
          ? [...LOCAL_ONLY, SSHD, proc(1400, 1338, "/opt/hd/relay remote-client-bridge")]
          : [...LOCAL_ONLY, SSHD, renamed];
        await expect(attempt(place, table).result).rejects.toThrow(/remote Herdr client/);
      }
    });

    test("a Herdr process whose command line is hidden refuses: it cannot be told from a bridge", async () => {
      // Windows hides the command line of an elevated process from an unelevated reader.
      for (const hidden of [
        [SSHD, proc(1366, 1338, "herdr.exe (unreadable command line)")],
        [proc(1366, 4242, "herdr.exe (unreadable command line)")],
        [SSHD, proc(1366, 1338, "")],
      ]) {
        await expect(attempt(place, [...LOCAL_ONLY, ...hidden]).result).rejects.toThrow(
          /remote Herdr client is attached/,
        );
      }
    });

    test("a hidden command line of something that is not Herdr changes nothing", async () => {
      const table = [...LOCAL_ONLY, proc(4, 0, "System (unreadable command line)")];
      await expect(attempt(place, table).result).resolves.toEqual({ kind: "local" });
    });

    test("a client started by hand inside an SSH session refuses", async () => {
      const shell = proc(1499, 1338, "-zsh");
      const client = proc(1500, 1499, "herdr");
      await expect(attempt(place, [...LOCAL_ONLY, SSHD, shell, client]).result).rejects.toThrow(
        /remote Herdr client/,
      );
    });

    test("a process list it cannot get refuses; it is never a reason to go local", async () => {
      const { result } = attempt(place, new Error("spawn ps ENOENT"));
      await expect(result).rejects.toThrow(/Could not list the processes.*ENOENT/);
      await expect(result).rejects.toThrow(/live\.audioHost/);
    });
  });

  test("says why Pi cannot tell, per place", async () => {
    await expect(attempt(places[0]!, [SSHD, BRIDGE]).result).rejects.toThrow(/on macOS/);
    await expect(attempt(places[1]!, [SSHD, BRIDGE]).result).rejects.toThrow(/on Windows/);
    await expect(attempt(places[2]!, [SSHD, BRIDGE]).result).rejects.toThrow(/`ss`/);
  });

  test("documented limit: a remote client that is not named like a bridge and not under sshd is not seen", async () => {
    // Nothing on these computers says it is remote, so the answer is this computer. README says so.
    const unseen = proc(1600, 1, "/opt/x/mystery-client --attach");
    await expect(attempt(places[0]!, [...LOCAL_ONLY, unseen]).result).resolves.toEqual({
      kind: "local",
    });
  });

  test("the SSH variables Pi inherited in a pane are ignored here too", async () => {
    const { result, t } = attempt(places[0]!, LOCAL_ONLY, {
      ...IN_HERDR,
      SSH_CONNECTION: from("100.96.150.40"),
      SSH_TTY: "/dev/ttys001",
    });
    await expect(result).resolves.toEqual({ kind: "local" });
    expect(t.run).not.toHaveBeenCalled();
  });
});

describe.each(["darwin", "win32"] as const)("outside Herdr on %s", (platform) => {
  const run = (env: NodeJS.ProcessEnv, tailscale = tailnet().run) => {
    const w = world();
    return { w, result: resolveMediaTarget({ env, tailscale, ...w, platform }) };
  };

  test("no SSH variables is this computer, with nothing looked at", async () => {
    const t = tailnet();
    const { result, w } = run({}, t.run);
    await expect(result).resolves.toEqual({ kind: "local" });
    expect(t.run).not.toHaveBeenCalled();
    expect(w.ss).not.toHaveBeenCalled();
    expect(w.processes).not.toHaveBeenCalled();
  });

  test("Pi's own SSH_CONNECTION is the computer it came from", async () => {
    const { result, w } = run({ SSH_CONNECTION: from("100.96.150.40") });
    await expect(result).resolves.toEqual({ kind: "remote", host: "laptop", node: "nLAPTOP" });
    expect(w.processes).not.toHaveBeenCalled();
  });

  test("an SSH marker without a connection to look up refuses", async () => {
    await expect(run({ SSH_TTY: "x" }).result).rejects.toThrow(/cannot be told/);
  });
});

describe("the process list", () => {
  test("is read into pid, parent and command, ignoring what is not a process line", () => {
    expect(
      parseProcessTable(
        [
          "  741   529 herdr server",
          " 1366  1357 /Users/u/.local/bin/herdr remote-client-bridge --idle-timeout-v1",
          '9 1 "C:\\Program Files\\Herdr\\herdr.exe" remote-client-bridge\r',
          "continued on a second line",
          "",
          "12 0 ",
        ].join("\n"),
      ),
    ).toEqual([
      proc(741, 529, "herdr server"),
      proc(1366, 1357, "/Users/u/.local/bin/herdr remote-client-bridge --idle-timeout-v1"),
      proc(9, 1, '"C:\\Program Files\\Herdr\\herdr.exe" remote-client-bridge'),
      proc(12, 0, ""),
    ]);
  });

  test("recognizes remote clients by the bridge token or by sshd as an ancestor, not by guesswork", () => {
    const shell = proc(1499, 1338, "-zsh");
    const handStarted = proc(1500, 1499, "herdr");
    const renamed = proc(1401, 1338, "herdr tunnel");
    const windows = proc(77, 1, '"C:\\Program Files\\Herdr\\herdr.exe" remote-client-bridge');
    const table = [...LOCAL_ONLY, SSHD, BRIDGE, shell, handStarted, renamed, windows];
    expect(remoteHerdrClients(table)).toEqual([BRIDGE, handStarted, renamed, windows]);
    // Neither the server nor a local client, nor the terminal that runs it, nor Pi, nor an ssh
    // whose remote command is a bridge on some other computer.
    expect(remoteHerdrClients(LOCAL_ONLY)).toEqual([]);
    // But an ssh that sshd started is somebody else's session, bridge command or not.
    const relayed = proc(1450, 1338, "/opt/hd/relay remote-client-bridge");
    expect(remoteHerdrClients([SSHD, relayed])).toEqual([relayed]);
    // Herdr's own bridge is one wherever its parent is, even when the list cannot say where.
    const orphan = proc(1451, 4242, '"C:\\Program Files\\Herdr\\herdr.exe" remote-client-bridge');
    expect(remoteHerdrClients([orphan, ...LOCAL_ONLY])).toEqual([orphan]);
    // A server that was itself started over SSH is still not a client.
    expect(remoteHerdrClients([SSHD, proc(50, 1338, "/x/herdr server")])).toEqual([]);
    // Lines that merely mention herdr are not Herdr.
    expect(
      remoteHerdrClients([
        SSHD,
        proc(51, 1338, "ssh -F /tmp/herdr-ssh-1/config host"),
        proc(52, 1338, "grep herdr"),
      ]),
    ).toEqual([]);
  });

  test("sshd with a hidden command line is still sshd, by its name", () => {
    const sshd = proc(1338, 1, "sshd.exe (unreadable command line)");
    const client = proc(1500, 1338, "herdr");
    expect(remoteHerdrClients([...LOCAL_ONLY, sshd, client])).toEqual([client]);
  });

  test("a local client is a herdr that is neither its server, nor a bridge, nor sshd's", () => {
    const table = [...LOCAL_ONLY, SSHD, BRIDGE, proc(1500, 1338, "herdr"), proc(1600, 1, "herdr")];
    const local = (pid: number) => isLocalHerdrClient(table.find((e) => e.pid === pid)!, table);
    expect(local(3235)).toBe(true); // the client in front of the screen
    expect(local(1600)).toBe(true);
    expect(local(741)).toBe(false); // the server
    expect(local(1366)).toBe(false); // a bridge
    expect(local(1500)).toBe(false); // started by sshd
    expect(local(900)).toBe(false); // something else
  });

  test("a parent loop does not hang the lookup", () => {
    expect(remoteHerdrClients([proc(1, 2, "herdr"), proc(2, 1, "-zsh")])).toEqual([]);
  });

  test("is asked of ps for this user on Unix, and of PowerShell on Windows", async () => {
    const calls: [string, string[]][] = [];
    const exec = async (file: string, args: string[]) => {
      calls.push([file, args]);
      return { stdout: file === "ps" ? "1 0 init\n" : "2 1 powershell\n" };
    };
    await expect(runProcessTable("darwin", exec)).resolves.toEqual([proc(1, 0, "init")]);
    await expect(runProcessTable("win32", exec)).resolves.toEqual([proc(2, 1, "powershell")]);
    const uid = process.getuid?.();
    expect(calls[0]).toEqual([
      "ps",
      ["-ww", ...(uid === undefined ? [] : ["-U", String(uid)]), "-o", "pid=,ppid=,command="],
    ]);
    expect(calls[1]?.[0]).toBe("powershell.exe");
    expect(calls[1]?.[1].join(" ")).toMatch(/Get-CimInstance Win32_Process/);
    // A command line Windows hides is replaced by the program's name, so it is not an empty row.
    expect(calls[1]?.[1].join(" ")).toMatch(/\.Name.*unreadable command line/);
  });

  test("an empty list is a failure, not proof that nothing is running", async () => {
    await expect(runProcessTable("linux", async () => ({ stdout: "\n" }))).rejects.toThrow(
      /listed no processes/,
    );
  });

  test.skipIf(process.platform === "win32")("really lists this process, with ps", async () => {
    const table = await runProcessTable();
    expect(table.find((entry) => entry.pid === process.pid)?.command).toMatch(/\S/);
  });
});

describe("whether a client is at a terminal", () => {
  test.each([
    ["/dev/pts/3", true],
    ["/dev/tty1", true],
    ["/dev/tty", true],
    ["pipe:[164993]", false],
    ["socket:[5]", false],
    ["/dev/null", false],
    ["/home/u/pts/3", false],
  ])("stdin %s -> %s", async (target, expected) => {
    await expect(hasTerminal(1, async () => target)).resolves.toBe(expected);
    await expect(hasTerminal(1, async () => `${target} (deleted)`)).resolves.toBe(false);
  });

  test("a closed stdin is no terminal, but only while the process is there", async () => {
    const gone = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    await expect(hasTerminal(7, gone, async (path) => path === "/proc/7")).resolves.toBe(false);
    await expect(hasTerminal(7, gone, async () => false)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.skipIf(process.platform !== "linux")(
    "a real child that closed its stdin has none; one that exited is gone",
    async () => {
      const child = spawn("sh", ["-c", "exec 0<&-; exec sleep 30"], { stdio: "ignore" });
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await expect(hasTerminal(child.pid ?? 0)).resolves.toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
      await new Promise((resolve) => child.once("exit", resolve));
      await expect(hasTerminal(child.pid ?? 0)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("a process that cannot be read is an error, so it can be told from one with no terminal", async () => {
    await expect(
      hasTerminal(1, async () => {
        throw new Error("EACCES");
      }),
    ).rejects.toThrow("EACCES");
  });

  test.skipIf(process.platform !== "linux")(
    "a real child with a piped stdin has none",
    async () => {
      const child = spawn("sleep", ["30"], { stdio: ["pipe", "ignore", "ignore"] });
      try {
        await expect(hasTerminal(child.pid ?? 0)).resolves.toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});

describe("the clients of a server, from ss", () => {
  test("lists the owners, and counts connections whose owner is not shown", () => {
    expect(herdrClientPids(unixSockets([300, 301]), API)).toEqual({ pids: [300, 301], unowned: 0 });
    expect(herdrClientPids(unixSockets([300], { hidden: 1, unlisted: 1 }), API)).toEqual({
      pids: [300],
      unowned: 2,
    });
    expect(herdrClientPids(unixSockets([300], { closed: 1 }), API)).toEqual({
      pids: [300],
      unowned: 0,
    });
    expect(herdrClientPids("", API)).toBeUndefined();
    // A listener whose owner is not shown is a server, just not an identified one.
    expect(herdrClientPids(unixSockets([300], { hiddenServer: true }), API)).toEqual({
      pids: [],
      unowned: 0,
      serverHidden: true,
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
