import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { userInfo } from "node:os";
import { dirname, join, sep } from "node:path";
import { piAgentDir } from "../../paths.ts";

// What the computer with the microphone keeps for Pi hosts that ask for it over SSH. It lives in
// a subfolder of the agent dir, which the settings sync never touches.
const HOST_DIR = "live-host";
const LAUNCHER = "media-host";

/** What the Pi host runs over SSH on the media host: the launcher its personal install keeps fresh. */
export const HOST_LAUNCHER_COMMAND = `exec ~/.pi/agent/${HOST_DIR}/${LAUNCHER}`;

export function hostDirectory(agentDir = piAgentDir()): string {
  return join(agentDir, HOST_DIR);
}

export function launcherPath(agentDir = piAgentDir()): string {
  return join(hostDirectory(agentDir), LAUNCHER);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface LauncherOptions {
  agentDir?: string;
  /** The Node that runs the media host; SSH sessions rarely have one on PATH. */
  nodePath?: string;
  entry: string;
  platform?: NodeJS.Platform;
}

/** Records the Node and media host entry to start when a Pi host asks. Rewritten only on change. */
export function registerLauncher(options: LauncherOptions): { path: string; changed: boolean } {
  const path = launcherPath(options.agentDir);
  const script = [
    "#!/bin/sh",
    "# Written by pi-better-openai: Pi on another computer starts live voice here over SSH.",
    `exec ${shellQuote(options.nodePath ?? process.execPath)} ${shellQuote(options.entry)} "$@"`,
    "",
  ].join("\n");
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // Not written yet.
  }
  if (current === script) return { path, changed: false };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, script, { mode: 0o755 });
  renameSync(temporary, path);
  return { path, changed: true };
}

/**
 * Keeps the launcher fresh, but only for the copy Pi installed from the personal settings
 * (`<agent dir>/npm/node_modules`). Checkouts, `-e` paths and project copies never write it, so
 * they cannot take over what the pinned release set up. This guards against accidents, not
 * against other extensions, which already run as the same user.
 */
export function registerPersonalLauncher(
  options: LauncherOptions,
): { path: string; changed: boolean } | undefined {
  if ((options.platform ?? process.platform) === "win32") return undefined;
  try {
    const personal = realpathSync(join(options.agentDir ?? piAgentDir(), "npm", "node_modules"));
    if (!realpathSync(options.entry).startsWith(personal + sep)) return undefined;
  } catch {
    return undefined;
  }
  return registerLauncher(options);
}

/** SSH sessions have no XDG_RUNTIME_DIR, and without it the audio server cannot be found. */
export function ensureRuntimeDir(
  options: {
    env?: NodeJS.ProcessEnv;
    uid?: number | undefined;
    platform?: NodeJS.Platform;
    exists?: (path: string) => boolean;
  } = {},
): void {
  const env = options.env ?? process.env;
  const uid = "uid" in options ? options.uid : process.getuid?.();
  if ((options.platform ?? process.platform) !== "linux" || env.XDG_RUNTIME_DIR) return;
  const directory = `/run/user/${uid}`;
  if (uid !== undefined && (options.exists ?? existsSync)(directory)) {
    env.XDG_RUNTIME_DIR = directory;
  }
}

export class HostBusyError extends Error {
  constructor() {
    super("Another live voice session is already using this computer's microphone.");
    this.name = "HostBusyError";
  }
}

function hostLockPath(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-better-openai-live-host-${userInfo().username}`
    : join(hostDirectory(), "lock.sock");
}

function isHeld(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/**
 * One media host per user. The lock is a local socket that nothing talks to: the operating system
 * frees it when the host dies, so there is no pid to go stale. A socket file left by a killed
 * host refuses connections and is taken over.
 */
export async function acquireHostLock(path = hostLockPath()): Promise<{ close(): void }> {
  if (process.platform !== "win32") mkdirSync(dirname(path), { recursive: true });
  for (const reclaim of [true, false]) {
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });
      server.unref();
      return { close: () => void server.close() };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EADDRINUSE") throw cause;
      if (!reclaim || process.platform === "win32" || (await isHeld(path))) {
        throw new HostBusyError();
      }
      rmSync(path, { force: true });
    }
  }
  throw new HostBusyError();
}
