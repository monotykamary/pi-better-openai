import { spawn as nodeSpawn } from "node:child_process";
import type { LiveMediaFactory } from "../media.ts";
import { createRemoteMediaFactory, type RemoteMediaProcess } from "./client.ts";
import { HOST_LAUNCHER_COMMAND } from "./host.ts";
import { type MediaTarget, OriginError, resolveMediaTarget } from "./origin.ts";

// A host name, an ssh config alias, an address, or user@host. Anything that could start with a
// dash, or carry a space or shell syntax, could be read by ssh as an option or a command.
const SSH_HOST = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9_][A-Za-z0-9._-]*$/;

type SpawnSsh = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; windowsHide: boolean },
) => RemoteMediaProcess;

export interface RouteDependencies {
  /** The SSH host chosen in the settings; when set, it decides and nothing else is asked. */
  audioHost?: string;
  resolveTarget?: () => Promise<MediaTarget>;
  spawn?: SpawnSsh;
}

/**
 * Plain `ssh`, so the user's own SSH setup applies (keys, Tailscale SSH, a ProxyCommand for a
 * userspace tailnet). Nothing may prompt: stdin and stdout carry the protocol, and a dead network
 * must end the session within seconds rather than hang the microphone.
 */
export function sshArguments(host: string): string[] {
  if (!SSH_HOST.test(host)) {
    throw new OriginError(
      `${JSON.stringify(host)} cannot be used as an SSH host name. Use a host name, an ssh config alias, or user@host.`,
    );
  }
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=3",
    "--",
    host,
    HOST_LAUNCHER_COMMAND,
  ];
}

/**
 * Where the media of a new live session lives. Undefined means this computer, the default path;
 * a remote computer returns a factory that starts its media host over SSH. A host chosen in the
 * settings wins over what Herdr says, and is trusted to be the computer meant: only the host's
 * hello is checked. Refusals throw, so a session never falls back to a microphone nobody chose.
 */
export async function resolveLiveMedia(
  deps: RouteDependencies = {},
): Promise<LiveMediaFactory | undefined> {
  const target = deps.audioHost
    ? { kind: "remote" as const, host: deps.audioHost, node: undefined }
    : await (deps.resolveTarget ?? resolveMediaTarget)();
  if (target.kind === "local") return undefined;
  const args = sshArguments(target.host);
  const spawn: SpawnSsh =
    deps.spawn ?? ((command, argv, options) => nodeSpawn(command, argv, options));
  return createRemoteMediaFactory(
    () => spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
    { expectedNode: target.node },
  );
}
