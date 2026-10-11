import { execFile } from "node:child_process";
import { access, readFile, readlink } from "node:fs/promises";
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
 * `unowned` counts connections whose client `ss` shows no process for (another user's, or one that
 * hides itself from `ss`): they are clients all the same, just not placed. Undefined when nothing
 * listens on `apiSocket`; `serverHidden` when something does but `ss` shows no owner for it, so
 * its clients cannot be told either.
 */
export function herdrClientPids(
  output: string,
  apiSocket: string,
): { pids: number[]; unowned: number; serverHidden?: true } | undefined {
  const sockets = unixSockets(output);
  const listeners = sockets.filter((s) => s.state === "LISTEN" && s.path === apiSocket);
  if (listeners.length === 0) return undefined;
  const servers = new Set(listeners.flatMap((s) => s.pids));
  if (servers.size === 0) return { pids: [], unowned: 0, serverHidden: true };
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
  accepted.delete("0"); // The client already hung up.
  const pids = new Set<number>();
  let unowned = 0;
  for (const peer of accepted) {
    const owners = sockets
      .filter((s) => s.inode === peer)
      .flatMap((s) => s.pids)
      .filter((pid) => !servers.has(pid));
    if (owners.length === 0) unowned++;
    for (const pid of owners) pids.add(pid);
  }
  return { pids: [...pids], unowned };
}

const TERMINAL = /^\/dev\/(pts\/\d+|tty\d*)$/;

/**
 * Whether the process reads its input from a terminal (Linux): a person's client does, a bridge's
 * input is a pipe. A process that closed its stdin has none; `ENOENT` is only an error, "the
 * process left", when `/proc/<pid>` is gone too.
 */
export async function hasTerminal(
  pid: number,
  readLink: (path: string) => Promise<string> = (path) => readlink(path),
  exists: (path: string) => Promise<boolean> = (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
): Promise<boolean> {
  try {
    return TERMINAL.test(await readLink(`/proc/${pid}/fd/0`));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT" && (await exists(`/proc/${pid}`))) {
      return false;
    }
    throw cause;
  }
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
            // Windows hides the command line of an elevated process from an unelevated reader;
            // its name stands in, marked, so the row is not an empty one.
            'Get-CimInstance Win32_Process | ForEach-Object { $c = $_.CommandLine; if (-not $c) { $c = "$($_.Name) (unreadable command line)" }; "$($_.ProcessId) $($_.ParentProcessId) $c" }',
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
const UNREADABLE = "(unreadable command line)";

function sshdDescendants(table: ProcessInfo[]): (entry: ProcessInfo) => boolean {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  return (entry) => {
    const seen = new Set([entry.pid]);
    for (let up = byPid.get(entry.ppid); up && !seen.has(up.pid); up = byPid.get(up.ppid)) {
      if (SSH_SESSION.test(up.command)) return true;
      seen.add(up.pid);
    }
    return false;
  };
}

/**
 * Whether the entry is positively a person's local Herdr client: the `herdr` program with a command
 * line Pi can read, not its server, not the bridge command, and not started by sshd. A process that
 * is merely in the list (`tunnel-v2 --stdio`, a hidden command line) is not one.
 */
export function isLocalHerdrClient(entry: ProcessInfo, table: ProcessInfo[]): boolean {
  if (entry.command.endsWith(UNREADABLE)) return false;
  const herdr = HERDR_PROGRAM.exec(entry.command);
  if (!herdr) return false;
  const args = entry.command.slice(herdr[0].length);
  return !SERVER.test(args) && !BRIDGE.test(args) && !sshdDescendants(table)(entry);
}

/**
 * The processes that may be a remote Herdr client: Herdr's own bridge command, and anything sshd
 * started that is `herdr` (not its server) or runs the bridge command under another name. It is all
 * a computer without `ss` and `/proc` can tell; a client reached some other way is not seen. A
 * Herdr process whose command line is hidden (or a hidden one that sshd started) cannot be told from
 * a bridge, so it counts as one. An
 * `ssh` whose remote command is the bridge is this computer's client reaching another server, the
 * opposite direction, and is not one.
 */
export function remoteHerdrClients(table: ProcessInfo[]): ProcessInfo[] {
  const underSshd = sshdDescendants(table);
  return table.filter((entry) => {
    if (entry.command === "" || entry.command.endsWith(UNREADABLE)) {
      return entry.command === "" ? underSshd(entry) : HERDR_PROGRAM.test(entry.command);
    }
    const herdr = HERDR_PROGRAM.exec(entry.command);
    const args = herdr ? entry.command.slice(herdr[0].length) : undefined;
    if (args !== undefined && BRIDGE.test(args)) return true;
    const candidate = args === undefined ? BRIDGE.test(entry.command) : !SERVER.test(args);
    return candidate && underSshd(entry);
  });
}
