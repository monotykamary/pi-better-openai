import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

/** Runs `ss` and returns its output; tests substitute this. */
export type Ss = (args: string[]) => Promise<string>;

export const runSs: Ss = async (args) => {
  const { stdout } = await promisify(execFile)("ss", args, {
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
};

/** The SSH_CONNECTION in the environment of a process of this user, if it has one (Linux). */
export async function sshConnectionOf(pid: number): Promise<string | undefined> {
  const environment = await readFile(`/proc/${pid}/environ`, "utf8");
  const entry = environment.split("\0").find((line) => line.startsWith("SSH_CONNECTION="));
  return entry?.slice("SSH_CONNECTION=".length);
}

interface UnixSocket {
  state: string;
  path: string;
  inode: string;
  peer: string;
  pids: number[];
}

// `u_str ESTAB 0 0 <path or *> <inode> * <peer inode> users:(("herdr",pid=1,fd=3),...)`
const UNIX_SOCKET =
  /^u_\w+\s+(\S+)\s+\d+\s+\d+\s+(.+?)\s+(\d+)\s+\*\s+(\d+)(?:\s+users:\((.*)\))?\s*$/;

function unixSockets(output: string): UnixSocket[] {
  const sockets: UnixSocket[] = [];
  for (const line of output.split("\n")) {
    const match = UNIX_SOCKET.exec(line);
    if (!match) continue;
    const pids = [...(match[5] ?? "").matchAll(/pid=(\d+)/g)].map((pid) => Number(pid[1]));
    sockets.push({ state: match[1]!, path: match[2]!, inode: match[3]!, peer: match[4]!, pids });
  }
  return sockets;
}

/**
 * The processes attached to the Herdr server that listens on `apiSocket`, from `ss -x -a -n -p`.
 * A client keeps a connection to the server's other listening socket (the API socket serves
 * one-off commands), and the kernel names both ends, so a client is whoever holds the other end of
 * a connection the server accepted there. Another session's server has its own sockets and clients.
 * Undefined when no process listens on `apiSocket`.
 */
export function herdrClientPids(output: string, apiSocket: string): number[] | undefined {
  const sockets = unixSockets(output);
  const servers = new Set(
    sockets.filter((s) => s.state === "LISTEN" && s.path === apiSocket).flatMap((s) => s.pids),
  );
  if (servers.size === 0) return undefined;
  const ownedByServer = (socket: UnixSocket) => socket.pids.some((pid) => servers.has(pid));
  const clientSockets = new Set(
    sockets
      .filter((s) => s.state === "LISTEN" && s.path !== apiSocket && ownedByServer(s))
      .map((s) => s.path),
  );
  const accepted = new Set(
    sockets
      .filter((s) => s.state === "ESTAB" && clientSockets.has(s.path) && ownedByServer(s))
      .map((s) => s.peer),
  );
  const clients = sockets
    .filter((s) => accepted.has(s.inode))
    .flatMap((s) => s.pids)
    .filter((pid) => !servers.has(pid));
  return [...new Set(clients)];
}

/** Milliseconds since the peer of the one connection in `ss -t -i` output last sent data. */
export function lastReceivedMs(output: string): number | undefined {
  const match = /\blastrcv:(\d+)/.exec(output);
  return match ? Number(match[1]) : undefined;
}
