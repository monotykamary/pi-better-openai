import { spawn as nodeSpawn } from "node:child_process";
import type { LiveMediaFactory } from "../media.ts";
import { createRemoteMediaFactory, type RemoteMediaProcess } from "./client.ts";
import { HOST_LAUNCHER_COMMAND } from "./host.ts";
import {
  type ChooseComputer,
  type MediaTarget,
  OriginError,
  resolveMediaTarget,
} from "./origin.ts";

// A host name, an ssh config alias, an address, or user@host. Anything that could start with a
// dash, or carry a space or shell syntax, could be read by ssh as an option or a command.
const SSH_HOST = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9_][A-Za-z0-9._-]*$/;

type SpawnSsh = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; windowsHide: boolean },
) => RemoteMediaProcess;

export interface RouteDependencies {
  /** `live.audioHost`: unset is this computer, `auto` the computer connected from, else an SSH host. */
  audioHost?: string;
  /** Finds the computer for `auto`; given the way to ask the user when several are attached. */
  resolveTarget?: (choose?: ChooseComputer) => Promise<MediaTarget>;
  choose?: ChooseComputer;
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
 * The computer `auto` finds, or undefined for any other setting. Asked once, when /live is asked
 * and someone is there to answer: the result is what every start of that run (including one that
 * waited for the floor) uses, so a queued start never asks at a later, odd moment.
 */
export async function resolveLiveTarget(deps: RouteDependencies): Promise<MediaTarget | undefined> {
  if (deps.audioHost?.trim() !== "auto") return undefined;
  return (deps.resolveTarget ?? ((choose) => resolveMediaTarget({ choose })))(deps.choose);
}

/**
 * Where the media of a new live session lives. Undefined means this computer, the default path;
 * a remote computer returns a factory that starts its media host over SSH. Only `auto` looks
 * anything up; a host named in the settings is trusted to be the computer meant, so only its hello
 * is checked. Refusals throw, so a session never falls back to a microphone nobody chose.
 */
export async function resolveLiveMedia(
  deps: RouteDependencies = {},
): Promise<LiveMediaFactory | undefined> {
  const setting = deps.audioHost?.trim();
  if (!setting) return undefined;
  const target =
    setting === "auto"
      ? await resolveLiveTarget(deps)
      : { kind: "remote" as const, host: setting, node: undefined };
  if (!target || target.kind === "local") return undefined;
  const args = sshArguments(target.host);
  const spawn: SpawnSsh =
    deps.spawn ?? ((command, argv, options) => nodeSpawn(command, argv, options));
  return createRemoteMediaFactory(
    () => spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
    { expectedNode: target.node },
  );
}
