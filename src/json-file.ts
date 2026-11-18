import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

type JsonObject = Record<string, unknown>;

// Resolve existing symlinks (including a final link to a not-yet-created file)
// before deriving either the lock name or the publication directory.
export function resolveJsonPath(path: string): string {
  for (let hops = 0; hops < 40; hops++) {
    path = join(realpathSync.native(dirname(path)), basename(path));
    if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return path;
    const link = readlinkSync(path);
    // Preserve .. for the filesystem to resolve through intermediate links.
    path = isAbsolute(link) ? link : `${dirname(path)}${sep}${link}`;
  }
  throw new Error("Too many symlinks resolving JSON file.");
}

function fileStat(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error("JSON path is not a regular file.");
  return stat;
}

export function readJsonObject(path: string): JsonObject | undefined {
  if (!fileStat(path)) return undefined;
  const source = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Existing JSON is malformed.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Existing JSON is not an object.");
  return parsed as JsonObject;
}

// The caller coordinates read/merge/publication and resolves any target link.
export function publishJson(
  path: string,
  source: string,
  { exclusive = false, flush = false }: { exclusive?: boolean; flush?: boolean } = {},
): void {
  const existing = exclusive ? undefined : fileStat(path);
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  let published = false;
  try {
    try {
      writeFileSync(fd, source, "utf8");
      if (existing) fchmodSync(fd, existing.mode & 0o7777);
      if (flush) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (exclusive) {
      // Publish a complete file only if the destination is still absent.
      linkSync(temp, path);
    } else {
      renameSync(temp, path);
      published = true;
    }
  } finally {
    if (!published) unlinkSync(temp);
  }
  if (flush && process.platform !== "win32") {
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
}

function acquireLock(lock: string): number {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  // A crashed writer can leave an orphan. Do not steal it: an old lock could
  // still belong to a paused process. Fail the update after a bounded wait.
  for (let waits = 0; ; waits++) {
    try {
      return openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (waits === 30) throw new Error("JSON file is locked by another writer.");
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
}

export function editJsonObject(
  path: string,
  edit: (current: JsonObject | undefined) => object | undefined,
): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const target = resolveJsonPath(path);
  const lock = `${target}.lock`;
  const fd = acquireLock(lock);
  try {
    const next = edit(readJsonObject(target));
    if (next === undefined) return false;
    publishJson(target, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } finally {
    try {
      closeSync(fd);
    } finally {
      unlinkSync(lock);
    }
  }
}
