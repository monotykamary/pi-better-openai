// The Tailscale lookup of an SSH connection is adapted from herdr-codex-voice's client_origin.py
// (MIT, see THIRD_PARTY_NOTICES.md).
import { isIP } from "node:net";
import { hostname } from "node:os";
import {
  type ProcessInfo,
  hasTerminal,
  herdrClientPids,
  isLocalHerdrClient,
  remoteHerdrClients,
  runProcessTable,
  runSs,
  type Ss,
  sshConnectionOf,
} from "./clients.ts";
import { type TailscaleJson, tailscaleJson } from "./tailscale.ts";

// A MagicDNS machine name. Anything else could be read by ssh as an option.
const HOST_LABEL = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const SSH_MARKERS = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const;
const MULTIPLEXERS = ["TMUX", "STY", "ZELLIJ"] as const;
const SET_AUDIO_HOST = "Set live.audioHost to the SSH host of the computer to use.";
const PLATFORMS: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", win32: "Windows" };

/** Why /live will not pick an audio computer; shown to the user as is. */
export class OriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginError";
  }
}

/** The user closed the question of which computer to use; nothing was started. */
export class OriginCancelled extends OriginError {
  constructor() {
    super("No computer was chosen, so live voice did not start.");
    this.name = "OriginCancelled";
  }
}

/**
 * Asks the user which of the offered computers they are at; undefined if they decline. `notes`
 * are computers that are attached but cannot be offered, and why.
 */
export type ChooseComputer = (labels: string[], notes: string[]) => Promise<string | undefined>;

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
  isTerminal?: (pid: number) => Promise<boolean>;
  processes?: () => Promise<ProcessInfo[]>;
  /** Present where someone can answer. Without it, several attached computers are a refusal. */
  choose?: ChooseComputer;
}

type Json = Record<string, unknown>;

interface Client {
  pid: number;
  /** Its SSH_CONNECTION: set for a remote client. */
  connection?: string;
  recognized: boolean;
  /** Why its process could not be read, when it could not. */
  unreadable?: string;
}

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
 * Where the clients of the pane's Herdr server cannot be read (no Linux sockets and /proc, or no
 * `ss`), the process list can only show whether a remote client exists. None: this computer is the
 * only one that can be typing. Any, or no list: refuse, since it may be the one typing.
 */
async function resolveFromProcesses(
  deps: OriginDependencies,
  platform: NodeJS.Platform,
  reason: string,
  /** Clients Pi could not read: each must be a local herdr in the list, or it may be someone else's. */
  unread: number[] = [],
): Promise<MediaTarget> {
  let table: ProcessInfo[];
  try {
    table = await (deps.processes ?? (() => runProcessTable(platform)))();
  } catch (cause) {
    throw new OriginError(
      `Could not list the processes to look for remote Herdr clients (${messageOf(cause)}). ${SET_AUDIO_HOST}`,
    );
  }
  if (remoteHerdrClients(table).length > 0) {
    throw new OriginError(
      `A remote Herdr client is attached to this computer, and ${reason}, so Pi cannot tell whether you are typing from it. ${SET_AUDIO_HOST}`,
    );
  }
  for (const pid of unread) {
    const entry = table.find((candidate) => candidate.pid === pid);
    if (entry === undefined) {
      throw new OriginError(
        `A Herdr client (process ${pid}) could not be read and is not in the process list, so Pi cannot tell whether it is remote. ${SET_AUDIO_HOST}`,
      );
    }
    if (!isLocalHerdrClient(entry, table)) {
      throw new OriginError(
        `A Herdr client (process ${pid}) could not be read and is not a local herdr in the process list, so Pi cannot tell whether it is remote. ${SET_AUDIO_HOST}`,
      );
    }
  }
  return LOCAL;
}

/**
 * Whoever is attached to this pane's Herdr server and where from. Panes carry the server's
 * environment, not the typist's, so only the clients themselves can say: each is a process of this
 * user, a remote one with the SSH connection it came in on, a local one with none. One computer
 * attached is the answer; several are put to the user, because none of them is known to be typing.
 */
async function resolveInHerdr(
  env: NodeJS.ProcessEnv,
  deps: OriginDependencies,
  tailscale: TailscaleJson,
): Promise<MediaTarget> {
  const platform = deps.platform ?? process.platform;
  const apiSocket = env.HERDR_SOCKET_PATH;
  if (platform !== "linux" || !apiSocket) {
    return resolveFromProcesses(
      deps,
      platform,
      platform === "linux"
        ? "this pane has no Herdr socket path to read the clients from"
        : `on ${PLATFORMS[platform] ?? platform} Pi cannot read who is attached`,
    );
  }
  const ss = deps.ss ?? runSs;
  const connectionOf = deps.sshConnectionOf ?? sshConnectionOf;
  const isTerminal = deps.isTerminal ?? hasTerminal;

  let sockets: string;
  try {
    sockets = await ss(["-H", "-n", "-x", "-a", "-p"]);
  } catch (cause) {
    return resolveFromProcesses(deps, platform, `Pi could not run \`ss\` (${messageOf(cause)})`);
  }
  const attached = herdrClientPids(sockets, apiSocket);
  if (attached === undefined) {
    throw new OriginError(
      `Could not find the Herdr server of this pane (nothing listens on ${apiSocket}). ${SET_AUDIO_HOST}`,
    );
  }
  if (attached.serverHidden) {
    return resolveFromProcesses(
      deps,
      platform,
      "Pi cannot see which process owns this pane's Herdr server",
    );
  }
  if (attached.unowned > 0) {
    throw new OriginError(
      `Pi can't tell which computer is connected to this Herdr: a client of its server belongs to a process Pi cannot see. ${SET_AUDIO_HOST}`,
    );
  }
  const found = await Promise.all(
    attached.pids.map(async (pid): Promise<Client | undefined> => {
      try {
        // A bridge has the SSH connection it came in on, a person's client a terminal; anything
        // else (a bridge that was renamed or redesigned) cannot be placed.
        const connection = await connectionOf(pid);
        return { pid, connection, recognized: connection !== undefined || (await isTerminal(pid)) };
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") return undefined; // It left in the meantime.
        return { pid, recognized: false, unreadable: messageOf(cause) };
      }
    }),
  );
  const clients = found.filter((client) => client !== undefined);
  if (clients.length === 0) {
    throw new OriginError(
      `Found no Herdr client attached to this pane's server, so the computer you are typing from cannot be told. ${SET_AUDIO_HOST}`,
    );
  }
  if (clients.some((client) => !client.recognized && client.unreadable === undefined)) {
    throw new OriginError(
      `Pi can't tell which computer is connected to this Herdr: a client of its server is neither at a terminal here nor an SSH connection Pi can read. ${SET_AUDIO_HOST}`,
    );
  }
  const unreadable = clients.filter((client) => client.unreadable !== undefined);
  if (unreadable.length > 0) {
    const why = `Pi could not read where a Herdr client is connected from (${unreadable[0]?.unreadable})`;
    // A client known to be remote makes the process list no proof of anything.
    if (clients.some((client) => client.connection !== undefined)) {
      throw new OriginError(`${why}. ${SET_AUDIO_HOST}`);
    }
    return resolveFromProcesses(
      deps,
      platform,
      why,
      unreadable.map((client) => client.pid),
    );
  }
  const local = clients.some((client) => client.connection === undefined);
  const remotes = [...new Set(clients.flatMap((client) => client.connection ?? []))];
  if (remotes.length === 0) return LOCAL;
  const sole = remotes[0];
  if (remotes.length === 1 && !local && sole !== undefined) return identify(sole, tailscale);

  // More than one computer may be attached, and nothing here says which of them is typing: how
  // recently a client sent data cannot tell a keystroke from a keepalive, and a local client sends
  // nothing a remote one lacks. Only if they all turn out to be one computer is there an answer;
  // otherwise the person at the keyboard is asked, and where nobody can be asked it is a refusal.
  const origins = new Map<string, { name: string; target?: MediaTarget; reason?: string }>();
  if (local) origins.set("local", { name: "this computer", target: LOCAL });
  const identified = await Promise.allSettled(
    remotes.map((connection) => identify(connection, tailscale)),
  );
  remotes.forEach((connection, index) => {
    const outcome = identified[index];
    if (outcome?.status !== "fulfilled") {
      const address = connection.split(/\s+/)[0] ?? connection;
      origins.set(connection, { name: address, reason: messageOf(outcome?.reason) });
    } else if (outcome.value.kind === "local") {
      origins.set("local", { name: "this computer", target: outcome.value });
    } else {
      origins.set(outcome.value.node, { name: outcome.value.host, target: outcome.value });
    }
  });
  const attachedHere = [...origins.values()];
  const [origin] = attachedHere;
  if (attachedHere.length === 1 && origin?.target) return origin.target;

  const names = attachedHere.map((candidate) => candidate.name);
  const refusal = () =>
    new OriginError(
      `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are attached to this Herdr, and nothing tells Pi which of them you are typing from. ${SET_AUDIO_HOST}`,
    );
  if (!deps.choose) throw refusal();
  // A computer that cannot be the audio computer (unidentified, another user's, not Linux) is not
  // offered, but it may be the one typing, so the rest are still asked rather than assumed.
  const offered = attachedHere
    .filter((candidate) => candidate.target)
    .map((candidate) => ({
      ...candidate,
      label:
        candidate.target?.kind === "local"
          ? `this computer (${hostname().split(".")[0]})`
          : candidate.name,
    }))
    .sort((a, b) => Number(a.target?.kind === "local") - Number(b.target?.kind === "local"));
  const notes = attachedHere.flatMap((candidate) =>
    candidate.target ? [] : [`${candidate.name}: ${candidate.reason}`],
  );
  if (offered.length === 0) {
    throw new OriginError(
      `None of the computers attached to this Herdr can be the audio computer (${notes.join(" ")}) ${SET_AUDIO_HOST}`,
    );
  }
  const labels = offered.map((candidate) => candidate.label);
  const answer = await deps.choose(labels, notes);
  const chosen = answer === undefined ? undefined : offered[labels.indexOf(answer)];
  if (!chosen?.target) throw new OriginCancelled();
  return chosen.target;
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
  if (env.HERDR_PANE_ID) return resolveInHerdr(env, deps, tailscale);
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
