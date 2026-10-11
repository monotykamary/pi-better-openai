import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
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
 * Keeps the launcher fresh, but only for the copy Pi installed from the personal settings, under
 * `<agent dir>/npm/node_modules` or `<agent dir>/git`. Checkouts, `-e` paths and project copies
 * never write it, so they cannot take over what the pinned release set up. Symlinks are followed,
 * so a link out of an install is judged by where it really points. This guards against accidents,
 * not against other extensions, which already run as the same user.
 */
export function registerPersonalLauncher(
  options: LauncherOptions,
): { path: string; changed: boolean } | undefined {
  if ((options.platform ?? process.platform) === "win32") return undefined;
  const agentDir = options.agentDir ?? piAgentDir();
  try {
    const entry = realpathSync(options.entry);
    const installed = [join(agentDir, "npm", "node_modules"), join(agentDir, "git")].some(
      (root) => {
        try {
          return entry.startsWith(realpathSync(root) + sep);
        } catch {
          return false; // That kind of install does not exist here.
        }
      },
    );
    if (!installed) return undefined;
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

/**
 * One media host per user, held by the kernel: an abstract Unix socket (a name, not a file) goes
 * away with the process that bound it, so a crash leaves nothing behind to clean up and nothing
 * for two starting hosts to race over. Only Linux has these; the other systems are not media
 * hosts yet, so they say so instead of pretending to be busy.
 */
export function acquireHostLock(
  name = `pi-better-openai-live-host-${process.getuid?.()}`,
  platform: NodeJS.Platform = process.platform,
): Promise<{ close(): void }> {
  if (platform !== "linux") {
    return Promise.reject(
      new Error("Only a Linux computer can provide the audio for remote live voice for now."),
    );
  }
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", (cause) =>
      reject((cause as NodeJS.ErrnoException).code === "EADDRINUSE" ? new HostBusyError() : cause),
    );
    server.listen(`\0${name}`, () => {
      server.unref();
      resolve({ close: () => void server.close() });
    });
  });
}
