import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type Exec = (file: string, args: string[], options: object) => Promise<{ stdout: string }>;

/** Runs the Tailscale CLI and parses its JSON; tests substitute this. */
export type TailscaleJson = (args: string[]) => Promise<unknown>;

/** The CLI on PATH, then where the macOS and Windows apps keep theirs. */
function candidates(): string[] {
  return [
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe"),
  ];
}

export async function tailscaleJson(
  args: string[],
  exec: Exec = promisify(execFile) as unknown as Exec,
): Promise<unknown> {
  for (const file of candidates()) {
    try {
      const { stdout } = await exec(file, args, {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      return JSON.parse(stdout);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  throw new Error("The Tailscale CLI was not found.");
}

/** This computer's Tailscale node id, or nothing when Tailscale cannot say. */
export async function selfNodeId(run: TailscaleJson = tailscaleJson): Promise<string | undefined> {
  try {
    const status = (await run(["status", "--json"])) as { Self?: { ID?: unknown } } | null;
    const id = status?.Self?.ID;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}
