import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
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

/** Whether the process reads its input from a terminal (Linux): a person's client does, a bridge's input is a pipe. */
export async function hasTerminal(
  pid: number,
  readLink: (path: string) => Promise<string> = (path) => readlink(path),
): Promise<boolean> {
  return /^\/dev\/(pts\/\d+|tty\d*)$/.test(await readLink(`/proc/${pid}/fd/0`));
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

type Exec = (file: string, args: string[], options: object) => Promise<{ stdout: string }>;

// "<pid> <ppid> <command line>", one process per line. A line that is not that is ignored.
const PROCESS_LINE = /^\s*(\d+)\s+(\d+)(?:\s+(.*?))?\s*$/;

export function parseProcessTable(output: string): ProcessInfo[] {
  return output.split("\n").flatMap((line) => {
    const match = PROCESS_LINE.exec(line);
    return match
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }]
      : [];
  });
}

/**
 * The processes of this user (all users on Windows) with their parents and command lines, from
 * `ps` where there is one and PowerShell on Windows. An empty answer is an error: `ps` itself is
 * always running, so nothing listed means the list cannot be trusted.
 */
export async function runProcessTable(
  platform: NodeJS.Platform = process.platform,
  exec: Exec = promisify(execFile) as unknown as Exec,
): Promise<ProcessInfo[]> {
  const uid = process.getuid?.();
  const [file, args] =
    platform === "win32"
      ? [
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }',
          ],
        ]
      : [
          "ps",
          ["-ww", ...(uid === undefined ? [] : ["-U", String(uid)]), "-o", "pid=,ppid=,command="],
        ];
  const { stdout } = await exec(file, args, {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  const table = parseProcessTable(stdout);
  if (table.length === 0) throw new Error("the process list listed no processes");
  return table;
}

// `herdr` as the program a command line starts (a path, quoted on Windows when it has spaces), and
// what follows it.
const HERDR_PROGRAM =
  /^(?:"(?:[^"]*[\\/])?herdr(?:\.exe)?"|(?:[^\s"]*[\\/])?herdr(?:\.exe)?)(?:\s+|$)/i;
const BRIDGE = /\bremote-client-bridge\b/i;
const SERVER = /^server\b/i;
const SSH_SESSION = /\bsshd\b/i;

/**
 * The processes that may be a remote Herdr client: Herdr's own bridge command, and anything sshd
 * started that is `herdr` (not its server) or runs the bridge command under another name. It is all
 * a computer without `ss` and `/proc` can tell; a client reached some other way is not seen. An
 * `ssh` whose remote command is the bridge is this computer's client reaching another server, the
 * opposite direction, and is not one.
 */
export function remoteHerdrClients(table: ProcessInfo[]): ProcessInfo[] {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const underSshd = (entry: ProcessInfo) => {
    const seen = new Set([entry.pid]);
    for (let up = byPid.get(entry.ppid); up && !seen.has(up.pid); up = byPid.get(up.ppid)) {
      if (SSH_SESSION.test(up.command)) return true;
      seen.add(up.pid);
    }
    return false;
  };
  return table.filter((entry) => {
    const herdr = HERDR_PROGRAM.exec(entry.command);
    const args = herdr ? entry.command.slice(herdr[0].length) : undefined;
    if (args !== undefined && BRIDGE.test(args)) return true;
    const candidate = args === undefined ? BRIDGE.test(entry.command) : !SERVER.test(args);
    return candidate && underSshd(entry);
  });
}
