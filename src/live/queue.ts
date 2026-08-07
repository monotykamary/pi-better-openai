import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { piAgentDir } from "../paths.ts";

// Cross-process floor arbitration for /live. Every enrolled pi process drops a
// heartbeat file into a shared per-user directory; exactly one process holds
// the floor (owns the microphone, the WebRTC session, and delegation routing).
// The floor holder is chosen explicitly (atomic create) or by preemption
// (atomic replace), so concurrent starters converge within one tick instead of
// racing into parallel realtime sessions. Stale entries from crashed processes
// are reclaimed via pid liveness plus heartbeat age — `process.kill(pid, 0)`
// throws ESRCH for dead pids and EPERM for alive-but-unowned ones.
//
// Focus handling is deliberately asymmetric: gaining focus grants claiming
// rights (and preempts a holder whose terminal is not focused), while losing
// focus never yields the floor — a conversation must survive alt-tabbing to a
// browser. Claiming a *vacant* floor needs only "not known to be unfocused", so
// terminals that report focus-support but skip the initial state event still
// behave sensibly for a single enrolled session.

export const LIVE_QUEUE_TICK_MS = 1_000;
export const LIVE_QUEUE_STALE_MS = 8_000;

export type LiveFloorPolicy = "focus" | "fifo";

export type LiveActivationCause = "focus" | "background" | "fifo";

export interface LiveQueueMember {
  id: string;
  pid: number;
  sessionId: string;
  label: string;
  joinedAt: number;
  heartbeatAt: number;
}

interface LiveFloorClaim {
  holderId: string;
  pid: number;
  token: string;
  claimedAt: number;
}

export interface LiveFloorArbiterCallbacks {
  onActivated(cause: LiveActivationCause): void;
  onDeactivated(): void;
}

export interface LiveFloorArbiterOptions {
  pid: number;
  sessionId: string;
  cwd: string;
  policy: LiveFloorPolicy;
  directory?: string;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

// Structural subset of LiveFloorArbiter used by the registration wiring, so
// tests can substitute an in-memory arbiter without touching the filesystem.
export interface LiveFloorArbiterLike {
  readonly id: string;
  readonly label: string;
  readonly policy: LiveFloorPolicy;
  readonly hasFloor: boolean;
  join(): void;
  leave(): void;
  tick(): void;
  setFocused(focused: boolean): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (
      typeof cause === "object" &&
      cause !== null &&
      (cause as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

export function liveQueueDirectory(agentDir = piAgentDir()): string {
  return join(agentDir, "live-queue");
}

export function liveQueueLabel(cwd: string, sessionId: string): string {
  const folder = basename(cwd) || cwd;
  return `${folder} · ${sessionId.slice(0, 8)}`;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseMember(value: unknown): LiveQueueMember | undefined {
  if (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.pid === "number" &&
    typeof value.sessionId === "string" &&
    typeof value.joinedAt === "number" &&
    typeof value.heartbeatAt === "number"
  ) {
    return {
      id: value.id,
      pid: value.pid,
      sessionId: value.sessionId,
      label: typeof value.label === "string" ? value.label : value.id,
      joinedAt: value.joinedAt,
      heartbeatAt: value.heartbeatAt,
    };
  }
  return undefined;
}

function parseClaim(value: unknown): LiveFloorClaim | undefined {
  if (
    isRecord(value) &&
    typeof value.holderId === "string" &&
    typeof value.pid === "number" &&
    typeof value.token === "string" &&
    typeof value.claimedAt === "number"
  ) {
    return {
      holderId: value.holderId,
      pid: value.pid,
      token: value.token,
      claimedAt: value.claimedAt,
    };
  }
  return undefined;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

export class LiveFloorArbiter implements LiveFloorArbiterLike {
  readonly #directory: string;
  readonly #memberFile: string;
  readonly #floorFile: string;
  readonly #pid: number;
  readonly #sessionId: string;
  readonly #label: string;
  readonly #policy: LiveFloorPolicy;
  readonly #now: () => number;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #callbacks: LiveFloorArbiterCallbacks;
  readonly #id: string;
  readonly #token: string;
  #joined = false;
  #joinedAt = 0;
  #focused: boolean | undefined;
  #hasFloor = false;

  constructor(options: LiveFloorArbiterOptions, callbacks: LiveFloorArbiterCallbacks) {
    this.#directory = options.directory ?? liveQueueDirectory();
    this.#pid = options.pid;
    this.#sessionId = options.sessionId;
    this.#label = liveQueueLabel(options.cwd, options.sessionId);
    this.#policy = options.policy;
    this.#now = options.now ?? Date.now;
    this.#isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.#callbacks = callbacks;
    this.#id = `${options.pid}-${options.sessionId}`;
    this.#token = `${options.pid}-${randomBytes(6).toString("hex")}`;
    this.#memberFile = join(this.#directory, "members", `${sanitizeId(this.#id)}.json`);
    this.#floorFile = join(this.#directory, "floor.json");
  }

  get id(): string {
    return this.#id;
  }

  get label(): string {
    return this.#label;
  }

  get policy(): LiveFloorPolicy {
    return this.#policy;
  }

  get joined(): boolean {
    return this.#joined;
  }

  get hasFloor(): boolean {
    return this.#hasFloor;
  }

  get focused(): boolean | undefined {
    return this.#focused;
  }

  join(): void {
    if (this.#joined) return;
    mkdirSync(join(this.#directory, "members"), { recursive: true });
    this.#joined = true;
    this.#joinedAt = this.#now();
    this.#writeMember();
    this.tick();
  }

  leave(): void {
    if (!this.#joined) return;
    this.#joined = false;
    this.#releaseFloor();
    rmSync(this.#memberFile, { force: true });
  }

  // Focus edges arrive from the owning terminal via mode 1004 input events.
  setFocused(focused: boolean): void {
    this.#focused = focused;
    this.#evaluate();
  }

  tick(): void {
    if (!this.#joined) return;
    this.#writeMember();
    this.#sweep();
    this.#evaluate();
  }

  #writeMember(): void {
    const member: LiveQueueMember = {
      id: this.#id,
      pid: this.#pid,
      sessionId: this.#sessionId,
      label: this.#label,
      joinedAt: this.#joinedAt,
      heartbeatAt: this.#now(),
    };
    try {
      writeJsonAtomic(this.#memberFile, member);
    } catch {
      // A wiped queue directory mid-run is recoverable on the next tick.
    }
  }

  #readMembers(): LiveQueueMember[] {
    let files: string[];
    try {
      files = readdirSync(join(this.#directory, "members"));
    } catch {
      return [];
    }
    const members: LiveQueueMember[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const member = parseMember(readJson(join(this.#directory, "members", file)));
      if (member) members.push(member);
    }
    members.sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
    return members;
  }

  #readClaim(): LiveFloorClaim | undefined {
    return parseClaim(readJson(this.#floorFile));
  }

  #isMemberAlive(member: LiveQueueMember): boolean {
    if (member.pid === this.#pid) return true;
    if (!this.#isProcessAlive(member.pid)) return false;
    return this.#now() - member.heartbeatAt <= LIVE_QUEUE_STALE_MS;
  }

  #sweep(): void {
    let files: string[];
    try {
      files = readdirSync(join(this.#directory, "members"));
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const path = join(this.#directory, "members", file);
      const member = parseMember(readJson(path));
      if (!member || (member.pid !== this.#pid && !this.#isMemberAlive(member))) {
        rmSync(path, { force: true });
      }
    }
  }

  #evaluate(): void {
    const now = this.#now();
    const aliveMembers = this.#readMembers().filter((member) => this.#isMemberAlive(member));
    const claim = this.#readClaim();
    const holderAlive =
      claim !== undefined &&
      (claim.pid === this.#pid || this.#isProcessAlive(claim.pid)) &&
      aliveMembers.some(
        (member) => member.id === claim.holderId && now - member.heartbeatAt <= LIVE_QUEUE_STALE_MS,
      );

    if (this.#hasFloor) {
      if (!this.#joined || claim?.token !== this.#token || claim.holderId !== this.#id) {
        this.#hasFloor = false;
        this.#callbacks.onDeactivated();
      }
      return;
    }

    if (claim && holderAlive) {
      // Only a genuinely focused challenger preempts; the displaced holder
      // steps down on its next tick when the token no longer matches its own.
      if (this.#policy === "focus" && this.#focused === true && claim.holderId !== this.#id) {
        this.#claim("focus", true);
      }
      return;
    }

    if (claim && !holderAlive) {
      rmSync(this.#floorFile, { force: true });
    }
    if (this.#policy === "fifo") {
      if (aliveMembers[0]?.id === this.#id) this.#claim("fifo", false);
      return;
    }
    if (this.#focused !== false) {
      this.#claim(this.#focused === true ? "focus" : "background", false);
    }
  }

  #claim(cause: LiveActivationCause, preempt: boolean): void {
    const claim: LiveFloorClaim = {
      holderId: this.#id,
      pid: this.#pid,
      token: this.#token,
      claimedAt: this.#now(),
    };
    try {
      if (preempt) {
        writeJsonAtomic(this.#floorFile, claim);
      } else {
        const fd = openSync(this.#floorFile, "wx");
        try {
          writeFileSync(fd, JSON.stringify(claim));
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      return;
    }
    const confirmed = this.#readClaim();
    if (confirmed?.token !== this.#token) return;
    this.#hasFloor = true;
    this.#callbacks.onActivated(cause);
  }

  #releaseFloor(): void {
    const wasHolding = this.#hasFloor;
    this.#hasFloor = false;
    const claim = this.#readClaim();
    if (claim?.token === this.#token) {
      rmSync(this.#floorFile, { force: true });
    }
    if (wasHolding) this.#callbacks.onDeactivated();
  }
}
