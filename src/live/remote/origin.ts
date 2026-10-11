// The Tailscale lookup of an SSH connection is adapted from herdr-codex-voice's client_origin.py
// (MIT, see THIRD_PARTY_NOTICES.md).
import { isIP } from "node:net";
import { herdrClientPids, lastReceivedMs, runSs, type Ss, sshConnectionOf } from "./clients.ts";
import { type TailscaleJson, tailscaleJson } from "./tailscale.ts";

// A MagicDNS machine name. Anything else could be read by ssh as an option.
const HOST_LABEL = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const SSH_MARKERS = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const;
const MULTIPLEXERS = ["TMUX", "STY", "ZELLIJ"] as const;
/**
 * How long before /live was asked a client's data may have arrived and still be the keystroke that
 * asked: the network to the pane is a few milliseconds, this allows for a busy machine. A client
 * whose last data is older is idle; one that sends a keepalive at that moment looks the same.
 */
const KEYSTROKE_WINDOW_MS = 120;
const SET_AUDIO_HOST = "Set live.audioHost to the SSH host of the computer to use.";

/** Why /live will not pick an audio computer; shown to the user as is. */
export class OriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginError";
  }
}

export type MediaTarget =
  | { kind: "local" }
  | {
      kind: "remote";
      /** The MagicDNS machine name to ssh to. */
      host: string;
      /** The Tailscale StableID the media host must announce before it may open any device. */
      node: string;
    };

const LOCAL: MediaTarget = { kind: "local" };

export interface OriginDependencies {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  tailscale?: TailscaleJson | undefined;
  ss?: Ss;
  sshConnectionOf?: (pid: number) => Promise<string | undefined>;
  /** When /live was asked: the keystroke that did it had just reached this computer. */
  askedAt?: number;
  now?: () => number;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** An `SSH_CONNECTION` ("source sport destination dport") with every field checked. */
function parseConnection(connection: string) {
  const [source, port, destination, serverPort, ...rest] = connection.trim().split(/\s+/);
  const validPort = (value: string | undefined) =>
    value !== undefined && /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65_535;
  if (
    rest.length > 0 ||
    !source ||
    !destination ||
    !isIP(source) ||
    !isIP(destination) ||
    !validPort(port) ||
    !validPort(serverPort)
  ) {
    throw new OriginError("The SSH connection cannot be identified.");
  }
  return { source, port: port!, destination, serverPort: serverPort! };
}

const hostPort = (address: string, port: string) =>
  isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`;

/** The address Tailscale can look up for an `SSH_CONNECTION` ("src sport dst dport") string. */
function tailnetEndpoint(connection: string): string {
  const { source, port } = parseConnection(connection);
  // Userspace Tailscale proxies incoming SSH from loopback; only the source port names the peer.
  if (source === "::1") return `[${source}]:${port}`;
  return source.startsWith("127.") ? `${source}:${port}` : source;
}

async function identify(connection: string, tailscale: TailscaleJson): Promise<MediaTarget> {
  const endpoint = tailnetEndpoint(connection);
  let whois: unknown;
  let status: unknown;
  try {
    [whois, status] = await Promise.all([
      tailscale(["whois", "--json", endpoint]),
      tailscale(["status", "--json"]),
    ]);
  } catch (cause) {
    throw new OriginError(
      `Tailscale could not identify the computer you are typing from (${messageOf(cause)}).`,
    );
  }
  const node = isRecord(whois) && isRecord(whois.Node) ? whois.Node : {};
  const self = isRecord(status) && isRecord(status.Self) ? status.Self : {};
  const stableId = node.StableID;
  if (typeof stableId !== "string" || !stableId || typeof self.ID !== "string") {
    throw new OriginError("Tailscale did not identify the computer you are typing from.");
  }
  if (stableId === self.ID) return LOCAL;
  if (typeof self.UserID !== "number" || node.User !== self.UserID) {
    throw new OriginError(
      "The computer you are typing from belongs to another Tailscale user, so its microphone is not used.",
    );
  }
  const peers = isRecord(status) && isRecord(status.Peer) ? Object.values(status.Peer) : [];
  const peer = peers.find((candidate) => isRecord(candidate) && candidate.ID === stableId);
  if (!isRecord(peer)) {
    throw new OriginError("The computer you are typing from is not in this Tailscale peer list.");
  }
  const os = typeof peer.OS === "string" ? peer.OS : "this operating system";
  if (os.toLowerCase() !== "linux") {
    throw new OriginError(
      `Remote live voice does not support ${os} as the audio computer yet; only Linux can be one for now.`,
    );
  }
  const host = typeof node.Name === "string" ? (node.Name.split(".")[0] ?? "") : "";
  if (!HOST_LABEL.test(host)) {
    throw new OriginError("Tailscale gave a computer name that cannot be used for SSH.");
  }
  return { kind: "remote", host, node: stableId };
}

/** Whether the client that came in over `connection` has just sent data, as the kernel counts it. */
async function justSentData(connection: string, ss: Ss, askedAt: number, now: () => number) {
  const { source, port, destination, serverPort } = parseConnection(connection);
  let output: string;
  try {
    output = await ss([
      "-H",
      "-n",
      "-t",
      "-i",
      "state",
      "established",
      "src",
      hostPort(destination, serverPort),
      "dst",
      hostPort(source, port),
    ]);
  } catch (cause) {
    throw new OriginError(
      `Could not ask the kernel which computer just typed (${messageOf(cause)}). ${SET_AUDIO_HOST}`,
    );
  }
  const age = lastReceivedMs(output);
  if (age === undefined) return false;
  const arrived = now() - age;
  return Math.abs(arrived - askedAt) <= KEYSTROKE_WINDOW_MS;
}

/** "laptop and desktop", for a refusal; an address stands in for a computer Tailscale cannot name. */
async function namesOf(connections: string[], tailscale: TailscaleJson): Promise<string> {
  const names = await Promise.all(
    connections.map(async (connection) => {
      const target = await identify(connection, tailscale).catch(() => undefined);
      return target?.kind === "remote" ? target.host : connection.split(/\s+/)[0];
    }),
  );
  return names.join(" and ");
}

/**
 * Whoever is attached to this pane's Herdr server and where from. Panes carry the server's
 * environment, not the typist's, so only the clients themselves can say: each is a process of this
 * user, a remote one with the SSH connection it came in on, a local one with none.
 */
async function resolveInHerdr(
  env: NodeJS.ProcessEnv,
  deps: OriginDependencies,
  tailscale: TailscaleJson,
): Promise<MediaTarget> {
  if ((deps.platform ?? process.platform) !== "linux") {
    throw new OriginError(
      `Telling which computer you are typing from inside Herdr needs Linux on the computer running Pi for now. ${SET_AUDIO_HOST}`,
    );
  }
  const ss = deps.ss ?? runSs;
  const connectionOf = deps.sshConnectionOf ?? sshConnectionOf;
  const now = deps.now ?? Date.now;
  const askedAt = deps.askedAt ?? now();
  const apiSocket = env.HERDR_SOCKET_PATH ?? "";

  let sockets: string;
  try {
    sockets = await ss(["-H", "-n", "-x", "-a", "-p"]);
  } catch (cause) {
    throw new OriginError(
      `Could not run \`ss\` to find the Herdr clients (${messageOf(cause)}). ${SET_AUDIO_HOST}`,
    );
  }
  const pids = herdrClientPids(sockets, apiSocket);
  if (pids === undefined) {
    throw new OriginError(
      `Could not find the Herdr server of this pane (nothing listens on ${apiSocket}). ${SET_AUDIO_HOST}`,
    );
  }
  const found = await Promise.all(
    pids.map(async (pid) => {
      try {
        return { connection: await connectionOf(pid) };
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") return undefined; // It left in the meantime.
        throw new OriginError(
          `Could not read where a Herdr client is connected from (${messageOf(cause)}). ${SET_AUDIO_HOST}`,
        );
      }
    }),
  );
  const clients = found.filter((client) => client !== undefined);
  if (clients.length === 0) {
    throw new OriginError(
      `Found no Herdr client attached to this pane's server, so the computer you are typing from cannot be told. ${SET_AUDIO_HOST}`,
    );
  }
  const local = clients.some((client) => client.connection === undefined);
  const remotes = [...new Set(clients.flatMap((client) => client.connection ?? []))];
  if (remotes.length === 0) return LOCAL;
  const only = remotes[0];
  if (remotes.length === 1 && !local && only !== undefined) return identify(only, tailscale);

  // Several computers are attached; whoever's keystroke just arrived asked for /live.
  const typed = await Promise.all(
    remotes.map((connection) => justSentData(connection, ss, askedAt, now)),
  );
  const fresh = remotes.filter((_, index) => typed[index]);
  const [one] = fresh;
  if (fresh.length === 1 && one !== undefined) return identify(one, tailscale);
  if (fresh.length === 0 && local) return LOCAL;
  const names = await namesOf(remotes, tailscale);
  throw new OriginError(
    `${names} are attached to this Herdr and Pi could not tell which one you are typing from. ${SET_AUDIO_HOST}`,
  );
}

/**
 * Finds the audio computer for `live.audioHost: "auto"`: the computer the user is connected from.
 * Inside Herdr that is the Herdr client that just typed; otherwise Pi's own SSH connection. Every
 * doubt is a refusal with a reason, never a guess that opens this computer's microphone for
 * someone typing from elsewhere.
 */
export async function resolveMediaTarget(deps: OriginDependencies = {}): Promise<MediaTarget> {
  const env = deps.env ?? process.env;
  const tailscale = deps.tailscale ?? tailscaleJson;
  if (env.HERDR_SOCKET_PATH && env.HERDR_PANE_ID) return resolveInHerdr(env, deps, tailscale);
  if (!SSH_MARKERS.some((name) => env[name])) return LOCAL;
  const multiplexer = MULTIPLEXERS.find((name) => env[name]);
  if (multiplexer) {
    throw new OriginError(
      `Pi runs inside ${multiplexer.toLowerCase()} from an SSH session, which hides the computer you are typing from. ${SET_AUDIO_HOST}`,
    );
  }
  if (!env.SSH_CONNECTION) {
    throw new OriginError(
      `Pi is in an SSH session whose connection it cannot see, so the computer you are typing from cannot be told. ${SET_AUDIO_HOST}`,
    );
  }
  return identify(env.SSH_CONNECTION, tailscale);
}
