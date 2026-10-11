// Adapted from herdr-codex-voice's client_origin.py (MIT, see THIRD_PARTY_NOTICES.md).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { connect } from "node:net";
import { promisify } from "node:util";
import { type TailscaleJson, tailscaleJson } from "./tailscale.ts";

const HERDR_TIMEOUT_MS = 3_000;
const MAX_HERDR_RESPONSE_BYTES = 1_048_576;
// A MagicDNS machine name. Anything else could be read by ssh as an option.
const HOST_LABEL = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

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

export interface HerdrClient {
  capabilities(): Promise<Record<string, unknown>>;
  lastInput(pane: string): Promise<unknown>;
}

export interface OriginDependencies {
  env?: NodeJS.ProcessEnv;
  herdr?: HerdrClient;
  tailscale?: TailscaleJson | undefined;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function rpc(path: string, method: string, params: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `better-openai-${randomUUID()}`;
    const socket = connect(path);
    const chunks: Buffer[] = [];
    let size = 0;
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(HERDR_TIMEOUT_MS, () => fail(new Error("Herdr did not answer in time.")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("error", fail);
    socket.on("end", () => fail(new Error("Herdr closed the connection before answering.")));
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_HERDR_RESPONSE_BYTES) return fail(new Error("Herdr's answer was too large."));
      if (!chunk.includes(0x0a)) return;
      socket.destroy();
      try {
        const reply: unknown = JSON.parse(Buffer.concat(chunks).toString().split("\n")[0] ?? "");
        if (!isRecord(reply) || reply.id !== id || "error" in reply) {
          throw new Error("Herdr could not answer.");
        }
        resolve(reply.result);
      } catch (cause) {
        reject(cause);
      }
    });
  });
}

async function herdrCli(env: NodeJS.ProcessEnv, args: string[]): Promise<Json> {
  const { stdout } = await promisify(execFile)(env.HERDR_BIN_PATH || "herdr", args, {
    timeout: HERDR_TIMEOUT_MS,
    maxBuffer: MAX_HERDR_RESPONSE_BYTES,
    windowsHide: true,
  });
  const value: unknown = JSON.parse(stdout);
  if (!isRecord(value)) throw new Error("Herdr returned an unexpected answer.");
  return value;
}

/**
 * Herdr's own view of who typed in a pane. Unix goes over the raw socket, because the CLI's
 * status does not list the capability even where it exists. Windows has no such socket, so it
 * uses the CLI, which speaks Herdr's named pipe.
 */
export function createHerdrClient(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    runCli?: (args: string[]) => Promise<Json>;
  } = {},
): HerdrClient {
  const env = options.env ?? process.env;
  const windows = (options.platform ?? process.platform) === "win32";
  const runCli = options.runCli ?? ((args: string[]) => herdrCli(env, args));
  return {
    async capabilities() {
      let capabilities: unknown;
      if (windows) {
        const status = await runCli(["status", "server", "--json"]);
        if (status.running !== true) throw new Error("The current Herdr server is unavailable.");
        capabilities = status.capabilities;
      } else {
        const result = await rpc(env.HERDR_SOCKET_PATH ?? "", "ping", {});
        capabilities = isRecord(result) ? result.capabilities : undefined;
      }
      if (!isRecord(capabilities)) throw new Error("Herdr returned an unexpected answer.");
      return capabilities;
    },
    async lastInput(pane) {
      if (!windows) {
        const result = await rpc(env.HERDR_SOCKET_PATH ?? "", "pane.last_input", { pane_id: pane });
        return isRecord(result) ? result.last_input : undefined;
      }
      const { result } = await runCli(["pane", "last-input", pane]);
      if (!isRecord(result) || result.type !== "pane_last_input" || result.pane_id !== pane) {
        throw new Error("Herdr returned an unexpected keyboard-origin answer.");
      }
      return result.last_input;
    },
  };
}

/** The address Tailscale can look up for an `SSH_CONNECTION` ("src sport dst dport") string. */
function tailnetEndpoint(connection: string): string {
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
    throw new OriginError("Herdr gave an SSH connection that cannot be identified.");
  }
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
 * Finds the audio computer from what Herdr knows about who typed in this pane, for a Herdr build
 * that reports it (`pane_last_input`). Outside Herdr, or when Herdr answers that it does not report
 * it, nothing is known and /live stays on this computer, as it always was. Every other doubt,
 * including a Herdr that fails to answer, is a refusal with a reason, never a guess: a remote
 * user's /live must not open this computer's microphone.
 */
export async function resolveMediaTarget(deps: OriginDependencies = {}): Promise<MediaTarget> {
  const env = deps.env ?? process.env;
  const pane = env.HERDR_PANE_ID;
  if (!env.HERDR_SOCKET_PATH || !pane) return LOCAL;
  const herdr = deps.herdr ?? createHerdrClient({ env });
  let capabilities: Json;
  try {
    capabilities = await herdr.capabilities();
  } catch (cause) {
    throw new OriginError(
      `Could not reach Herdr to find the computer you are typing from (${messageOf(cause)}).`,
    );
  }
  if (capabilities.pane_last_input !== true) return LOCAL;
  let input: unknown;
  try {
    input = await herdr.lastInput(pane);
  } catch (cause) {
    throw new OriginError(
      `Herdr could not tell which computer typed in this pane (${messageOf(cause)}).`,
    );
  }
  if (!isRecord(input) || input.source !== "client") {
    throw new OriginError(
      "Type in this Herdr pane first so Herdr knows which computer's microphone to use.",
    );
  }
  const client = isRecord(input.client) ? input.client : {};
  if (client.connected !== true) {
    throw new OriginError(
      "The computer that last typed in this pane has disconnected. Reconnect, type here, and try again.",
    );
  }
  const connection = typeof client.ssh_connection === "string" ? client.ssh_connection : "";
  if (client.via === "local" && !connection) return LOCAL;
  if ((client.via === "local" || client.via === "ssh_bridge") && connection) {
    return identify(connection, deps.tailscale ?? tailscaleJson);
  }
  throw new OriginError(
    "Herdr does not know which computer is typing into this connection. Reconnect with a Herdr that reports it.",
  );
}
