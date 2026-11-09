import { constants, type Dirent } from "node:fs";
import { access, lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  calculateImageRows,
  getCapabilities,
  getCellDimensions,
  Image,
  imageFallback,
  truncateToWidth,
  type AutocompleteItem,
  type ImageTheme,
} from "@earendil-works/pi-tui";
import { loadSharp } from "./sharp.ts";
import { isRecord, type PetState } from "./config.ts";

const PETS_COMMAND = "pets";
const PET_COLUMNS = 8;
const PET_ROWS = 9;
const DEFAULT_CELL_WIDTH = 192;
const DEFAULT_CELL_HEIGHT = 208;
const DEFAULT_SPRITESHEET_PATH = "spritesheet.webp";
const EXPECTED_ATLAS_WIDTH = DEFAULT_CELL_WIDTH * PET_COLUMNS;
const EXPECTED_ATLAS_HEIGHT = DEFAULT_CELL_HEIGHT * PET_ROWS;
const PET_CATALOG_CACHE_TTL_MS = 1500;
const PET_CATALOG_READ_CONCURRENCY = 4;

type ListCodexPetsOptions = { refresh?: boolean };

type PetCatalogCacheEntry = {
  expiresAt: number;
  pets: CodexPetPackage[];
};

const petCatalogCache = new Map<string, PetCatalogCacheEntry>();

export const PET_ANIMATION_ROWS: Record<PetState, { row: number; durations: number[] }> = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
};

export type CodexPetPackage = {
  slug: string;
  id?: string;
  name: string;
  description?: string;
  dir: string;
  spritesheetPath: string;
  hasSpritesheet: boolean;
  spritesheetIssue?: string;
};

export type PetFrame = {
  data?: string;
  rawRgbaData?: string;
  kittyUpload?: string;
  kittyImageId?: number;
  mimeType: "image/png";
  durationMs: number;
  widthPx: number;
  heightPx: number;
};

export type LoadedCodexPet = {
  pet: CodexPetPackage;
  states: Record<PetState, PetFrame[]>;
};

export type PetsCommandController = {
  wake?: (ctx: ExtensionContext, slug?: string) => Promise<void> | void;
  tuck?: (ctx: ExtensionContext) => Promise<void> | void;
  select?: (ctx: ExtensionContext, slug?: string) => Promise<void> | void;
};

type ThemeLike = {
  fg(color: string, value: string): string;
};

const TERMINAL_ESCAPE_REGEXP = new RegExp(
  String.raw`\u001b(?:\][\s\S]*?(?:\u0007|\u001b\\)|[_PX^][\s\S]*?\u001b\\|\[[0-?]*[ -/]*[@-~]|[@-_][0-?]*[ -/]*[@-~])`,
  "g",
);
const CONTROL_CHAR_REGEXP = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f]+`, "g");

function stripTerminalEscapes(value: string): string {
  return value.replace(TERMINAL_ESCAPE_REGEXP, "");
}

function sanitizePetDisplayText(value: string): string | undefined {
  const sanitized = stripTerminalEscapes(value)
    .replace(CONTROL_CHAR_REGEXP, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || undefined;
}

function sanitizePetAssetPathText(value: string): string | undefined {
  const sanitized = stripTerminalEscapes(value).replace(CONTROL_CHAR_REGEXP, "").trim();
  return sanitized || undefined;
}

function sanitizePetDisplayField(value: unknown): string | undefined {
  return typeof value === "string" ? sanitizePetDisplayText(value) : undefined;
}

function sanitizePetAssetPathField(value: unknown): string | undefined {
  return typeof value === "string" ? sanitizePetAssetPathText(value) : undefined;
}

function sanitizePetSlug(value: string): string {
  return sanitizePetDisplayText(value) ?? "unnamed-pet";
}

export function codexHome(env = process.env, home = homedir()): string {
  return env.CODEX_HOME?.trim() || join(home, ".codex");
}

export function codexPetsDir(home = codexHome()): string {
  return join(home, "pets");
}

function petInfoFromJson(
  value: unknown,
  fallback: string,
): { id?: string; name: string; description?: string; spritesheetPath: string } {
  const fallbackName = sanitizePetDisplayText(fallback) ?? "Unnamed pet";
  if (!isRecord(value)) return { name: fallbackName, spritesheetPath: DEFAULT_SPRITESHEET_PATH };

  const id = sanitizePetDisplayField(value.id);
  const name =
    sanitizePetDisplayField(value.displayName) ??
    sanitizePetDisplayField(value.name) ??
    id ??
    fallbackName;
  const description = sanitizePetDisplayField(value.description);
  const spritesheetPath =
    sanitizePetAssetPathField(value.spritesheetPath) ?? DEFAULT_SPRITESHEET_PATH;
  return { id, name, description, spritesheetPath };
}

function isPathInsideDirectory(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  const prefix = resolvedParent.endsWith(sep) ? resolvedParent : `${resolvedParent}${sep}`;
  return resolvedChild === resolvedParent || resolvedChild.startsWith(prefix);
}

function resolvePetAssetPath(petDir: string, path: string): string | undefined {
  const resolvedPetDir = resolve(petDir);
  const resolved = resolve(resolvedPetDir, path);
  return isPathInsideDirectory(resolvedPetDir, resolved) ? resolved : undefined;
}

function formatSharpError(error: unknown): string {
  return (
    sanitizePetDisplayText(error instanceof Error ? error.message : String(error)) ??
    "unknown error"
  );
}

async function validatePetSpritesheet(
  petDir: string,
  spritesheetPath: string,
): Promise<string | undefined> {
  const resolvedSpritesheetPath = resolvePetAssetPath(petDir, spritesheetPath);
  if (!resolvedSpritesheetPath)
    return `invalid spritesheetPath outside pet folder: ${spritesheetPath}`;

  let fileStat;
  try {
    fileStat = await lstat(resolvedSpritesheetPath);
  } catch {
    return `missing ${spritesheetPath}`;
  }

  if (fileStat.isSymbolicLink()) return `${spritesheetPath} must not be a symlink`;
  if (!fileStat.isFile()) return `${spritesheetPath} is not a file`;

  const realPetDir = await realpath(petDir).catch(() => undefined);
  const realSpritesheetPath = await realpath(resolvedSpritesheetPath).catch(() => undefined);
  if (
    !realPetDir ||
    !realSpritesheetPath ||
    !isPathInsideDirectory(realPetDir, realSpritesheetPath)
  )
    return `invalid spritesheetPath outside pet folder: ${spritesheetPath}`;

  try {
    await access(resolvedSpritesheetPath, constants.R_OK);
  } catch {
    return `${spritesheetPath} is not readable`;
  }

  try {
    const sharp = await loadSharp();
    const metadata = await sharp(resolvedSpritesheetPath, { animated: false }).metadata();
    if (metadata.width !== EXPECTED_ATLAS_WIDTH || metadata.height !== EXPECTED_ATLAS_HEIGHT) {
      return `invalid atlas dimensions: ${metadata.width ?? "?"}x${metadata.height ?? "?"}; expected ${EXPECTED_ATLAS_WIDTH}x${EXPECTED_ATLAS_HEIGHT}`;
    }
  } catch (error) {
    return `could not read ${spritesheetPath}: ${formatSharpError(error)}`;
  }

  return undefined;
}

function clearPetCatalogCache(home?: string): void {
  if (home === undefined) {
    petCatalogCache.clear();
    return;
  }
  petCatalogCache.delete(resolve(home));
}

async function readPetDirectoryEntries(home: string): Promise<{ dir: string; entries: Dirent[] }> {
  const dir = codexPetsDir(home);
  try {
    return { dir, entries: await readdir(dir, { withFileTypes: true }) };
  } catch {
    return { dir, entries: [] };
  }
}

async function readCodexPetPackage(
  petsDir: string,
  entry: Dirent,
  options: { validateSpritesheet: boolean },
): Promise<CodexPetPackage | undefined> {
  if (!entry.isDirectory()) return undefined;
  const petDir = join(petsDir, entry.name);
  const slug = sanitizePetSlug(entry.name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(petDir, "pet.json"), "utf8")) as unknown;
  } catch (error) {
    return {
      slug,
      name: sanitizePetDisplayText(entry.name) ?? "Unnamed pet",
      dir: petDir,
      spritesheetPath: DEFAULT_SPRITESHEET_PATH,
      hasSpritesheet: false,
      spritesheetIssue: `invalid pet.json: ${formatSharpError(error)}`,
    };
  }
  const { id, name, description, spritesheetPath } = petInfoFromJson(parsed, entry.name);
  const spritesheetIssue = options.validateSpritesheet
    ? await validatePetSpritesheet(petDir, spritesheetPath)
    : undefined;
  return {
    slug,
    id,
    name,
    description,
    dir: petDir,
    spritesheetPath,
    hasSpritesheet: options.validateSpritesheet && spritesheetIssue === undefined,
    spritesheetIssue,
  };
}

async function readCodexPetPackages(
  petsDir: string,
  entries: Dirent[],
  options: { validateSpritesheet: boolean },
): Promise<CodexPetPackage[]> {
  const pets: Array<CodexPetPackage | undefined> = Array.from({ length: entries.length });
  let nextIndex = 0;
  const readNext = async (): Promise<void> => {
    while (nextIndex < entries.length) {
      const index = nextIndex++;
      const entry = entries[index];
      if (entry) pets[index] = await readCodexPetPackage(petsDir, entry, options);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PET_CATALOG_READ_CONCURRENCY, entries.length) }, readNext),
  );
  return pets.filter((pet): pet is CodexPetPackage => pet !== undefined);
}

export async function listCodexPets(
  home = codexHome(),
  options: ListCodexPetsOptions = {},
): Promise<CodexPetPackage[]> {
  const cacheKey = resolve(home);
  const cached = petCatalogCache.get(cacheKey);
  if (!options.refresh && cached && cached.expiresAt > Date.now()) return cached.pets;

  const { dir, entries } = await readPetDirectoryEntries(home);
  const pets = await readCodexPetPackages(dir, entries, { validateSpritesheet: true });
  pets.sort((a, b) => a.name.localeCompare(b.name));
  petCatalogCache.set(cacheKey, { expiresAt: Date.now() + PET_CATALOG_CACHE_TTL_MS, pets });
  return pets;
}

export function petLookupKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "");
}

type PetLookupRequest = {
  hasText: boolean;
  exact?: string;
  key?: string;
};

function petLookupRequest(value?: string): PetLookupRequest {
  const requestedText = value?.trim();
  if (!requestedText) return { hasText: false };

  return {
    hasText: true,
    exact: requestedText.normalize("NFKC").toLowerCase(),
    key: petLookupKey(requestedText) || undefined,
  };
}

function petMatchesLookup(pet: CodexPetPackage, requested: string): boolean {
  return (
    petLookupKey(pet.slug) === requested ||
    (pet.id !== undefined && petLookupKey(pet.id) === requested) ||
    petLookupKey(pet.name) === requested
  );
}

function exactPetMatches(
  pets: CodexPetPackage[],
  requested: string,
): CodexPetPackage[] | undefined {
  const fields: Array<(pet: CodexPetPackage) => string | undefined> = [
    (pet) => pet.slug,
    (pet) => pet.id,
    (pet) => pet.name,
  ];
  for (const field of fields) {
    const matches = pets.filter((pet) => field(pet)?.normalize("NFKC").toLowerCase() === requested);
    if (matches.length > 0) return matches;
  }
  return undefined;
}

function uniquePetMatch(pets: CodexPetPackage[]): CodexPetPackage | undefined {
  return pets.length === 1 ? pets[0] : undefined;
}

export function findCodexPet(pets: CodexPetPackage[], value?: string): CodexPetPackage | undefined {
  const request = petLookupRequest(value);
  const { key } = request;
  if (!key) return undefined;
  if (request.exact) {
    const exactMatches = exactPetMatches(pets, request.exact);
    if (exactMatches) return uniquePetMatch(exactMatches);
  }
  return uniquePetMatch(pets.filter((pet) => petMatchesLookup(pet, key)));
}

export function findReadyCodexPet(
  pets: CodexPetPackage[],
  value?: string,
): CodexPetPackage | undefined {
  const request = petLookupRequest(value);
  if (!request.hasText) return pets.find((pet) => pet.hasSpritesheet);

  const { key } = request;
  if (!key) return undefined;
  if (request.exact) {
    const exactMatches = exactPetMatches(pets, request.exact);
    if (exactMatches) {
      const exact = uniquePetMatch(exactMatches);
      return exact?.hasSpritesheet ? exact : undefined;
    }
  }
  return uniquePetMatch(pets.filter((pet) => pet.hasSpritesheet && petMatchesLookup(pet, key)));
}

function selectPet(pets: CodexPetPackage[], slug?: string): CodexPetPackage | undefined {
  return findReadyCodexPet(pets, slug);
}

export type CodexPetSelectionIssue = {
  short: string;
  message: string;
};

export function formatCodexPetSetupInstructions(home = codexHome()): string {
  return [
    "Expected folder:",
    `  ${codexPetsDir(home)}/<pet-name>/`,
    "",
    "Expected files:",
    "  pet.json",
    `  ${DEFAULT_SPRITESHEET_PATH}`,
    "",
    "Create one:",
    "  $skill-installer hatch-pet",
    "  Cmd/Ctrl+K → Force Reload Skills",
    "  $hatch-pet create a new pet inspired by pi-better-openai",
  ].join("\n");
}

export function describeCodexPetSelectionIssue(
  pets: CodexPetPackage[],
  slug?: string,
  home = codexHome(),
): CodexPetSelectionIssue {
  const requestedSlug = slug?.trim();
  const readyPets = pets.filter((pet) => pet.hasSpritesheet);

  if (requestedSlug) {
    const matchingPet = findCodexPet(pets, requestedSlug);
    if (matchingPet && !matchingPet.hasSpritesheet) {
      return {
        short: `Pet "${matchingPet.name}" is not ready.`,
        message: [
          `Pet "${matchingPet.name}" (${matchingPet.slug}) exists but is not ready.`,
          `Problem: ${matchingPet.spritesheetIssue ?? `missing ${matchingPet.spritesheetPath}`}`,
          "",
          "Run /pets list for diagnostics, then fix the pet folder:",
          `  ${matchingPet.dir}/`,
        ].join("\n"),
      };
    }

    const readyList = readyPets.length
      ? ["Ready pets:", ...readyPets.map((pet) => `  - ${pet.slug} (${pet.name})`)].join("\n")
      : formatNoReadyCodexPetsMessage(pets, home);
    return {
      short: `No ready pet matching "${requestedSlug}".`,
      message: [`No ready pet matching "${requestedSlug}".`, "", readyList].join("\n"),
    };
  }

  if (pets.length === 0) {
    return {
      short: "No custom Codex pets found.",
      message: formatNoReadyCodexPetsMessage(pets, home),
    };
  }

  return {
    short: "No ready custom Codex pet found.",
    message: formatNoReadyCodexPetsMessage(pets, home),
  };
}

export function formatNoReadyCodexPetsMessage(pets: CodexPetPackage[], home = codexHome()): string {
  if (pets.length === 0) {
    return [
      "No custom Codex pets found.",
      "",
      `Looked in: ${codexPetsDir(home)}`,
      "",
      formatCodexPetSetupInstructions(home),
    ].join("\n");
  }

  return [
    "Found custom Codex pets, but none are ready.",
    "",
    `A ready pet needs pet.json and a readable ${EXPECTED_ATLAS_WIDTH}x${EXPECTED_ATLAS_HEIGHT} ${DEFAULT_SPRITESHEET_PATH} atlas in its pet folder.`,
    "Run /pets list to see what needs fixing, or create a new pet:",
    "",
    formatCodexPetSetupInstructions(home),
  ].join("\n");
}

function kittyImageBaseForPet(slug: string): number {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) % 0xffff;
  return 0x50000000 + hash * 100;
}

async function findCodexPetDirect(
  slug: string,
  home: string,
): Promise<CodexPetPackage | undefined> {
  const request = petLookupRequest(slug);
  if (!request.key) return undefined;
  const { dir, entries } = await readPetDirectoryEntries(home);
  const candidates = await readCodexPetPackages(dir, entries, { validateSpritesheet: false });
  const candidate = findCodexPet(candidates, slug);
  if (!candidate || candidate.spritesheetIssue) return candidate;
  const spritesheetIssue = await validatePetSpritesheet(candidate.dir, candidate.spritesheetPath);
  return {
    ...candidate,
    hasSpritesheet: spritesheetIssue === undefined,
    spritesheetIssue,
  };
}

export async function loadCodexPet(
  slug?: string,
  home = codexHome(),
  options: { sizeCells?: number } = {},
): Promise<LoadedCodexPet | undefined> {
  const pet = slug
    ? await findCodexPetDirect(slug, home)
    : selectPet(await listCodexPets(home), slug);
  if (!pet?.hasSpritesheet) return undefined;

  const spritesheetPath = resolvePetAssetPath(pet.dir, pet.spritesheetPath);
  if (!spritesheetPath)
    throw new Error(`Invalid spritesheetPath outside pet folder: ${pet.spritesheetPath}`);
  const sharp = await loadSharp();
  const source = sharp(spritesheetPath, { animated: false });
  const metadata = await source.metadata();
  if (metadata.width !== EXPECTED_ATLAS_WIDTH || metadata.height !== EXPECTED_ATLAS_HEIGHT) {
    throw new Error(
      `Invalid Codex pet atlas dimensions: ${metadata.width ?? "?"}x${metadata.height ?? "?"}; expected ${EXPECTED_ATLAS_WIDTH}x${EXPECTED_ATLAS_HEIGHT}.`,
    );
  }
  const states = {} as Record<PetState, PetFrame[]>;
  const imageProtocol = getCapabilities().images;
  const useKitty = imageProtocol === "kitty";
  const kittyImageBase = kittyImageBaseForPet(pet.slug);
  let kittyFrameOffset = 1;
  const cellDimensions = getCellDimensions();
  const targetWidthPx = options.sizeCells
    ? Math.max(1, Math.round(options.sizeCells * cellDimensions.widthPx))
    : undefined;
  const targetHeightPx = targetWidthPx
    ? Math.max(
        1,
        Math.ceil(
          (DEFAULT_CELL_HEIGHT * targetWidthPx) / DEFAULT_CELL_WIDTH / cellDimensions.heightPx,
        ) * cellDimensions.heightPx,
      )
    : undefined;
  const outputWidthPx = targetWidthPx ?? DEFAULT_CELL_WIDTH;
  const outputHeightPx = targetHeightPx ?? DEFAULT_CELL_HEIGHT;

  for (const [state, animation] of Object.entries(PET_ANIMATION_ROWS) as Array<
    [PetState, (typeof PET_ANIMATION_ROWS)[PetState]]
  >) {
    states[state] = [];
    for (let column = 0; column < animation.durations.length; column++) {
      const durationMs = animation.durations[column] ?? 150;
      if (!imageProtocol) {
        states[state].push({
          mimeType: "image/png",
          durationMs,
          widthPx: outputWidthPx,
          heightPx: outputHeightPx,
        });
        continue;
      }

      let frame = source.clone().extract({
        left: column * DEFAULT_CELL_WIDTH,
        top: animation.row * DEFAULT_CELL_HEIGHT,
        width: DEFAULT_CELL_WIDTH,
        height: DEFAULT_CELL_HEIGHT,
      });
      if (targetWidthPx && targetHeightPx) {
        frame = frame.resize(targetWidthPx, targetHeightPx, {
          fit: "fill",
          kernel: sharp.kernel.nearest,
        });
      }
      const kittyImageId = useKitty ? kittyImageBase + kittyFrameOffset++ : undefined;
      const encoded = useKitty
        ? {
            kittyUpload: encodeKittyRawRgbaData(
              (await frame.ensureAlpha().raw().toBuffer()).toString("base64"),
              outputWidthPx,
              outputHeightPx,
              kittyImageId!,
            ),
          }
        : { data: (await frame.png().toBuffer()).toString("base64") };
      states[state].push({
        ...encoded,
        kittyImageId,
        mimeType: "image/png",
        durationMs,
        widthPx: outputWidthPx,
        heightPx: outputHeightPx,
      });
    }
  }

  return { pet, states };
}

function animationCursor(frames: PetFrame[], now = Date.now(), durationMultiplier = 1) {
  const multiplier = Math.max(0.1, durationMultiplier);
  const total = frames.reduce((sum, frame) => sum + frame.durationMs * multiplier, 0);
  return { multiplier, total, cursor: total > 0 ? now % total : 0 };
}

export function animationFrameAt(
  frames: PetFrame[],
  now = Date.now(),
  durationMultiplier = 1,
): PetFrame | undefined {
  if (frames.length === 0) return undefined;
  let { cursor, multiplier } = animationCursor(frames, now, durationMultiplier);
  for (const frame of frames) {
    cursor -= frame.durationMs * multiplier;
    if (cursor < 0) return frame;
  }
  return frames[0];
}

export function nextAnimationFrameDelayMs(
  frames: PetFrame[],
  now = Date.now(),
  durationMultiplier = 1,
): number {
  if (frames.length === 0) return 120;
  let { cursor, multiplier } = animationCursor(frames, now, durationMultiplier);
  for (const frame of frames) {
    const duration = frame.durationMs * multiplier;
    if (cursor < duration) return Math.max(1, Math.ceil(duration - cursor));
    cursor -= duration;
  }
  return Math.max(1, Math.ceil(frames[0]!.durationMs));
}

function forEachCodexPetFrame(
  pet: LoadedCodexPet | undefined,
  visit: (frame: PetFrame) => void,
): void {
  if (!pet) return;
  for (const frames of Object.values(pet.states)) {
    for (const frame of frames) visit(frame);
  }
}

function codexPetKittyImageIds(pet?: LoadedCodexPet): number[] {
  const imageIds = new Set<number>();
  forEachCodexPetFrame(pet, (frame) => {
    if (frame.kittyImageId !== undefined) imageIds.add(frame.kittyImageId);
  });
  return Array.from(imageIds);
}

export function deleteCodexPetKittyPlacement(imageId: number): string {
  return `\x1b_Ga=d,d=i,i=${imageId},p=1,q=2\x1b\\`;
}

export function deleteCodexPetKittyImage(imageId: number): string {
  return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

function placeKittyImage(imageId: number, columns: number, rows: number): string {
  return `\x1b_Ga=p,i=${imageId},p=1,c=${columns},r=${rows},q=2,C=1\x1b\\`;
}

function encodeKittyRawRgbaData(
  rawRgbaData: string,
  widthPx: number,
  heightPx: number,
  imageId: number,
): string {
  if (!rawRgbaData) return "";
  const chunkSize = 4096;
  const params = ["a=t", "f=32", `s=${widthPx}`, `v=${heightPx}`, `i=${imageId}`, "q=2"].join(",");
  if (rawRgbaData.length <= chunkSize) {
    return `\x1b_G${params};${rawRgbaData}\x1b\\`;
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < rawRgbaData.length; offset += chunkSize) {
    const chunk = rawRgbaData.slice(offset, offset + chunkSize);
    const isFirstChunk = offset === 0;
    const isLastChunk = offset + chunkSize >= rawRgbaData.length;
    if (isFirstChunk) chunks.push(`\x1b_G${params},m=1;${chunk}\x1b\\`);
    else chunks.push(`\x1b_Gm=${isLastChunk ? 0 : 1};${chunk}\x1b\\`);
  }
  return chunks.join("");
}

function encodeKittyRawRgba(frame: PetFrame, imageId: number): string {
  return (
    frame.kittyUpload ??
    (frame.rawRgbaData
      ? encodeKittyRawRgbaData(frame.rawRgbaData, frame.widthPx, frame.heightPx, imageId)
      : "")
  );
}

export class CodexPetKittyManager {
  private previousFrameImageId: number | undefined;
  private readonly pendingCleanupImageIds = new Set<number>();
  readonly placementImageId: number;

  constructor(placementImageId: number) {
    this.placementImageId = placementImageId;
  }

  queueCleanup(pet?: LoadedCodexPet): void {
    for (const imageId of codexPetKittyImageIds(pet)) this.pendingCleanupImageIds.add(imageId);
  }

  invalidate(pet?: LoadedCodexPet): void {
    this.queueCleanup(pet);
    this.previousFrameImageId = undefined;
  }

  resetForResize(pet?: LoadedCodexPet): void {
    this.invalidate(pet);
  }

  dispose(pet?: LoadedCodexPet): string {
    this.invalidate(pet);
    return this.takeCleanupSequence();
  }

  takeCleanupSequence(): string {
    if (this.pendingCleanupImageIds.size === 0) return "";
    const sequence = `${deleteCodexPetKittyPlacement(this.placementImageId)}${Array.from(
      this.pendingCleanupImageIds,
    )
      .map((imageId) => deleteCodexPetKittyImage(imageId))
      .join("")}`;
    this.pendingCleanupImageIds.clear();
    return sequence;
  }

  renderFrame(frame: PetFrame, width: number, options: { sizeCells: number }): string[] {
    const columns = Math.max(1, Math.min(width - 2, options.sizeCells));
    const rows = calculateImageRows(
      { widthPx: frame.widthPx, heightPx: frame.heightPx },
      columns,
      getCellDimensions(),
    );
    const frameImageId = frame.kittyImageId ?? this.placementImageId;
    const deletePrevious =
      this.previousFrameImageId !== undefined && this.previousFrameImageId !== frameImageId
        ? deleteCodexPetKittyPlacement(this.previousFrameImageId)
        : "";
    const deleteCurrent = deleteCodexPetKittyPlacement(frameImageId);
    // Do not cache uploads across animation loops. Kitty-compatible terminals may
    // drop image data after clears, quota pressure, or after a placement is
    // deleted; failures are suppressed with q=2 and otherwise show up as an
    // occasionally invisible pet. The TUI diff still avoids writing this payload
    // again when the rendered line is unchanged.
    const upload = encodeKittyRawRgba(frame, frameImageId);
    this.previousFrameImageId = frameImageId;
    // Recent pi-tui versions automatically free Kitty image IDs they own on changed lines.
    // Pet frames are managed here and intentionally reused across animation loops, so keep
    // the first Kitty command pointed at a harmless footer-placement ID, not a frame ID.
    const hostCleanupSentinel =
      frameImageId !== this.placementImageId
        ? deleteCodexPetKittyPlacement(this.placementImageId)
        : "";
    const sequence = `${hostCleanupSentinel}${deletePrevious}${deleteCurrent}${upload}${placeKittyImage(frameImageId, columns, rows)}`;
    const lines: string[] = [];
    for (let i = 0; i < rows - 1; i++) lines.push("");
    const moveUp = rows > 1 ? `\x1b[${rows - 1}A` : "";
    const moveDown = rows > 1 ? `\x1b[${rows - 1}B` : "";
    lines.push(moveUp + sequence + moveDown);
    return lines;
  }
}

const defaultKittyManagers = new Map<number, CodexPetKittyManager>();

function defaultKittyManager(placementImageId: number): CodexPetKittyManager {
  let manager = defaultKittyManagers.get(placementImageId);
  if (!manager) {
    manager = new CodexPetKittyManager(placementImageId);
    defaultKittyManagers.set(placementImageId, manager);
  }
  return manager;
}

export function resetCodexPetKittyCache(pet?: LoadedCodexPet, placementImageId?: number): void {
  if (placementImageId !== undefined) defaultKittyManagers.get(placementImageId)?.invalidate(pet);
  else for (const manager of defaultKittyManagers.values()) manager.invalidate(pet);
}

export function renderCodexPetFrame(
  pet: LoadedCodexPet,
  state: PetState,
  width: number,
  theme: ThemeLike,
  options: {
    sizeCells: number;
    imageId: number;
    now?: number;
    durationMultiplier?: number;
    kittyManager?: CodexPetKittyManager;
  },
): string[] {
  const frame = animationFrameAt(
    pet.states[state] ?? pet.states.idle,
    options.now,
    options.durationMultiplier,
  );
  if (!frame) return [];
  const imageProtocol = getCapabilities().images;
  if (imageProtocol === "kitty") {
    const manager = options.kittyManager ?? defaultKittyManager(options.imageId);
    return manager.renderFrame(frame, width, { sizeCells: options.sizeCells });
  }
  if (!imageProtocol) {
    const fallback = imageFallback(frame.mimeType, {
      widthPx: frame.widthPx,
      heightPx: frame.heightPx,
    });
    return [truncateToWidth(theme.fg("dim", fallback), width, theme.fg("dim", "..."))];
  }

  if (!frame.data) return [];
  const imageTheme: ImageTheme = { fallbackColor: (value) => theme.fg("dim", value) };
  const image = new Image(
    frame.data,
    frame.mimeType,
    imageTheme,
    { maxWidthCells: Math.min(options.sizeCells, width), imageId: options.imageId },
    { widthPx: frame.widthPx, heightPx: frame.heightPx },
  );
  return image.render(width);
}

export function formatCodexPetsHelp(home = codexHome()): string {
  return [
    "Codex pets can now render in the pi Better OpenAI footer too.",
    "",
    "Commands:",
    `  /${PETS_COMMAND} wake [slug]   Render a custom Codex pet in the footer`,
    `  /${PETS_COMMAND} tuck          Hide the footer pet`,
    `  /${PETS_COMMAND} select <slug> Select a pet without changing visibility`,
    `  /${PETS_COMMAND} list          List local custom pets`,
    "",
    formatCodexPetSetupInstructions(home),
    "",
    "The Codex app overlay is still controlled by Codex Settings → Appearance → Pets or /pet.",
  ].join("\n");
}

const PET_SUBCOMMANDS: AutocompleteItem[] = [
  { value: "help", label: "help", description: "Show Codex pets setup and usage help" },
  { value: "list", label: "list", description: "List local custom Codex pets" },
  { value: "wake", label: "wake", description: "Render a footer pet" },
  { value: "tuck", label: "tuck", description: "Hide the footer pet" },
  {
    value: "select",
    label: "select",
    description: "Select a footer pet without changing visibility",
  },
];

function petCompletionValue(subcommand: string, pet: CodexPetPackage): string {
  return `${subcommand} ${pet.slug}`;
}

function petContainsLookup(pet: CodexPetPackage, query: string): boolean {
  return (
    !query ||
    petLookupKey(pet.slug).includes(query) ||
    (pet.id !== undefined && petLookupKey(pet.id).includes(query)) ||
    petLookupKey(pet.name).includes(query)
  );
}

export async function openAIPetsArgumentCompletions(
  argumentPrefix: string,
  home = codexHome(),
): Promise<AutocompleteItem[] | null> {
  const normalizedPrefix = argumentPrefix.trimStart();
  const parts = normalizedPrefix.split(/\s+/).filter(Boolean);
  const hasTrailingSpace = /\s$/.test(normalizedPrefix);
  const subcommand = parts[0]?.toLowerCase();

  if (!subcommand || (!hasTrailingSpace && parts.length <= 1)) {
    const query = subcommand ?? "";
    const matches = PET_SUBCOMMANDS.filter((item) => item.value.startsWith(query));
    return matches.length > 0 ? matches : null;
  }

  if (subcommand !== "wake" && subcommand !== "select") return null;

  const petQuery = hasTrailingSpace ? "" : parts.slice(1).join(" ");
  const normalizedPetQuery = petLookupKey(petQuery);
  const pets = (await listCodexPets(home)).filter((pet) => pet.hasSpritesheet);
  const matches = pets.filter((pet) => petContainsLookup(pet, normalizedPetQuery));
  return matches.length > 0
    ? matches.map((pet) => ({
        value: petCompletionValue(subcommand, pet),
        label: pet.name,
        description: `${pet.slug}${pet.description ? ` — ${pet.description}` : ""}`,
      }))
    : null;
}

function codexPetStatus(pet: CodexPetPackage): string {
  if (pet.hasSpritesheet) return "ready";
  return pet.spritesheetIssue ?? `missing ${pet.spritesheetPath}`;
}

function formatCodexPetListLine(pet: CodexPetPackage): string {
  const description = pet.description ? `\n  ${pet.description}` : "";
  return `${pet.name} (${pet.slug}) — ${codexPetStatus(pet)}${description}`;
}

export function formatCodexPetsListMessage(pets: CodexPetPackage[], home = codexHome()): string {
  if (pets.length === 0) return formatNoReadyCodexPetsMessage(pets, home);

  const petLines = pets.map(formatCodexPetListLine).join("\n");

  if (pets.some((pet) => pet.hasSpritesheet)) return petLines;

  return [
    "Found custom Codex pets, but none are ready.",
    "",
    petLines,
    "",
    "Fix one of the pet folders above, or create a new pet:",
    "",
    formatCodexPetSetupInstructions(home),
  ].join("\n");
}

async function notifyPetsList(ctx: ExtensionContext): Promise<void> {
  const home = codexHome();
  const pets = await listCodexPets(home, { refresh: true });
  ctx.ui.notify(
    formatCodexPetsListMessage(pets, home),
    pets.some((pet) => pet.hasSpritesheet) ? "info" : "warning",
  );
}

export function registerOpenAIPets(pi: ExtensionAPI, controller: PetsCommandController = {}): void {
  pi.registerCommand(PETS_COMMAND, {
    description: "Render, configure, or list Codex pets for the Better OpenAI footer",
    getArgumentCompletions: openAIPetsArgumentCompletions,
    handler: async (args, ctx) => {
      const [subcommand = "help", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const normalized = subcommand.toLowerCase();
      const slug = rest.join(" ").trim() || undefined;
      switch (normalized) {
        case "help":
          ctx.ui.notify(formatCodexPetsHelp(), "info");
          return;
        case "list":
          await notifyPetsList(ctx);
          return;
        case "wake":
          if (controller.wake) {
            await controller.wake(ctx, slug);
            return;
          }
          break;
        case "tuck":
          if (controller.tuck) {
            await controller.tuck(ctx);
            return;
          }
          break;
        case "select":
          if (controller.select) {
            await controller.select(ctx, slug);
            return;
          }
          break;
      }
      ctx.ui.notify(`Usage: /${PETS_COMMAND} [help|list|wake [slug]|tuck|select <slug>]`, "error");
    },
  });
}

export const _petsTest = {
  PETS_COMMAND,
  codexPetsDir,
  petInfoFromJson,
  petLookupKey,
  findCodexPet,
  findReadyCodexPet,
  selectPet,
  clearPetCatalogCache,
};
