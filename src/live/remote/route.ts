import { spawn as nodeSpawn } from "node:child_process";
import type { LiveMediaFactory } from "../media.ts";
import { createRemoteMediaFactory, type RemoteMediaProcess } from "./client.ts";
import { HOST_LAUNCHER_COMMAND } from "./host.ts";
import { HOST_LABEL, type MediaTarget, OriginError, resolveMediaTarget } from "./origin.ts";

type SpawnSsh = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; windowsHide: boolean },
) => RemoteMediaProcess;

export interface RouteDependencies {
  resolveTarget?: () => Promise<MediaTarget>;
  spawn?: SpawnSsh;
}

/**
 * Plain `ssh`, so the user's own SSH setup applies (keys, Tailscale SSH, a ProxyCommand for a
 * userspace tailnet). Nothing may prompt: stdin and stdout carry the protocol, and a dead network
 * must end the session within seconds rather than hang the microphone.
 */
export function sshArguments(host: string): string[] {
  if (!HOST_LABEL.test(host))
    throw new OriginError(`"${host}" cannot be used as an SSH host name.`);
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
 * a remote computer returns a factory that starts its media host over SSH. Refusals throw, so a
 * session never falls back to a microphone nobody chose.
 */
export async function resolveLiveMedia(
  deps: RouteDependencies = {},
): Promise<LiveMediaFactory | undefined> {
  const target = await (deps.resolveTarget ?? resolveMediaTarget)();
  if (target.kind === "local") return undefined;
  const args = sshArguments(target.host);
  const spawn: SpawnSsh =
    deps.spawn ?? ((command, argv, options) => nodeSpawn(command, argv, options));
  return createRemoteMediaFactory(
    () => spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
    { expectedNode: target.node },
  );
}
