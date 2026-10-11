// The Tailscale lookup of an SSH connection is adapted from herdr-codex-voice's client_origin.py
// (MIT, see THIRD_PARTY_NOTICES.md).
import { isIP } from "node:net";
import { herdrClientPids, runSs, type Ss, sshConnectionOf } from "./clients.ts";
import { type TailscaleJson, tailscaleJson } from "./tailscale.ts";

// A MagicDNS machine name. Anything else could be read by ssh as an option.
const HOST_LABEL = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const SSH_MARKERS = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const;
const MULTIPLEXERS = ["TMUX", "STY", "ZELLIJ"] as const;
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

/**
 * Whoever is attached to this pane's Herdr server and where from. Panes carry the server's
 * environment, not the typist's, so only the clients themselves can say: each is a process of this
 * user, a remote one with the SSH connection it came in on, a local one with none. One computer
 * attached is the answer; several are a refusal, because none of them is known to be typing.
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
  const sole = remotes[0];
  if (remotes.length === 1 && !local && sole !== undefined) return identify(sole, tailscale);

  // More than one computer may be attached. Nothing here says which of them is typing: how
  // recently a client sent data cannot tell a keystroke from a keepalive, and a local client sends
  // nothing a remote one lacks. Only if they all turn out to be one computer is there an answer.
  const origins = new Map<string, { name: string; target?: MediaTarget }>();
  if (local) origins.set("local", { name: "this computer", target: LOCAL });
  const identified = await Promise.all(
    remotes.map((connection) => identify(connection, tailscale).catch(() => undefined)),
  );
  remotes.forEach((connection, index) => {
    const target = identified[index];
    if (target === undefined) {
      const address = connection.split(/\s+/)[0] ?? connection;
      origins.set(connection, { name: address });
    } else if (target.kind === "local") {
      origins.set("local", { name: "this computer", target });
    } else {
      origins.set(target.node, { name: target.host, target });
    }
  });
  const [origin] = origins.values();
  if (origins.size === 1 && origin?.target) return origin.target;
  const names = [...origins.values()].map((candidate) => candidate.name);
  throw new OriginError(
    `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are attached to this Herdr, and nothing tells Pi which of them you are typing from. ${SET_AUDIO_HOST}`,
  );
}

/**
 * Finds the audio computer for `live.audioHost: "auto"`: the computer the user is connected from.
 * Inside Herdr that is the one computer attached to the pane's server; otherwise Pi's own SSH
 * connection. Every doubt is a refusal with a reason, never a guess that opens a microphone
 * nobody chose.
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
