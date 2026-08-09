import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_BASENAME, logPrefix } from "./identity.ts";
import {
  DEFAULT_LIVE_VOICE,
  isLiveVoice,
  LIVE_VOICE_VALUES,
  type LiveVoice,
} from "./live/voices.ts";
import { piAgentDir } from "./paths.ts";

export const FOOTER_MODES = ["replace", "status", "off"] as const;
export const IMAGE_SAVE_MODES = ["none", "project", "global", "custom"] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export const WEBSEARCH_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const WEBSEARCH_RESPONSE_LENGTHS = ["short", "medium", "long"] as const;
export const PET_PLACEMENTS = [
  "stacked",
  "inline-left",
  "inline-right",
  "badge",
  "habitat",
] as const;
export const PET_STATES = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
] as const;

export const DEFAULT_SUPPORTED_MODELS = [
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5",
] as const;

export type FooterMode = (typeof FOOTER_MODES)[number];
export type ImageSaveMode = (typeof IMAGE_SAVE_MODES)[number];
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];
export type WebsearchReasoningEffort = (typeof WEBSEARCH_REASONING_EFFORTS)[number];
export type WebsearchResponseLength = (typeof WEBSEARCH_RESPONSE_LENGTHS)[number];
export type PetPlacement = (typeof PET_PLACEMENTS)[number];
export type PetState = (typeof PET_STATES)[number];

export type UsageConfig = {
  enabled?: boolean;
  refreshIntervalMs?: number;
  showOnlyOnSubscriptionModels?: boolean;
  showResetTimes?: boolean;
};

export type FooterConfig = {
  mode?: FooterMode;
};

export type ImageConfig = {
  enabled?: boolean;
  defaultModel?: string;
  defaultSave?: ImageSaveMode;
  outputFormat?: ImageOutputFormat;
  timeoutMs?: number;
};

export type WebsearchConfig = {
  enabled?: boolean;
  model?: string;
  reasoningEffort?: WebsearchReasoningEffort;
  responseLength?: WebsearchResponseLength;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

export type LiveConfig = {
  enabled?: boolean;
  voice?: LiveVoice;
};

export type PetConfig = {
  enabled?: boolean;
  slug?: string;
  placement?: PetPlacement;
  state?: PetState;
  thinkingState?: PetState;
  toolState?: PetState;
  failedToolState?: PetState;
  idleEmotes?: boolean;
  idleEmoteIntervalMs?: number;
  sizeCells?: number;
};

export interface ConfigFile {
  persistState?: boolean;
  active?: boolean;
  desiredActive?: boolean;
  supportedModels?: string[];
  usage?: UsageConfig;
  footer?: FooterConfig;
  image?: ImageConfig;
  websearch?: WebsearchConfig;
  live?: LiveConfig;
  pets?: PetConfig;
}

export interface SupportedModel {
  provider: string;
  id: string;
}

export interface ResolvedConfig {
  configPath: string;
  projectConfigPath: string;
  globalConfigPath: string;
  projectConfigExists: boolean;
  globalConfigExists: boolean;
  persistState: boolean;
  active: boolean;
  desiredActive: boolean;
  supportedModels: SupportedModel[];
  usage: Required<UsageConfig>;
  footer: Required<FooterConfig>;
  image: Required<ImageConfig>;
  websearch: Required<WebsearchConfig>;
  live: Required<LiveConfig>;
  pets: Required<PetConfig>;
}

export const DEFAULT_USAGE_CONFIG: Required<UsageConfig> = {
  enabled: true,
  refreshIntervalMs: 60_000,
  showOnlyOnSubscriptionModels: true,
  showResetTimes: true,
};

export const DEFAULT_FOOTER_CONFIG: Required<FooterConfig> = {
  mode: "replace",
};

export const DEFAULT_IMAGE_MODEL = "gpt-image-2";

export const DEFAULT_IMAGE_CONFIG: Required<ImageConfig> = {
  enabled: true,
  defaultModel: DEFAULT_IMAGE_MODEL,
  defaultSave: "project",
  outputFormat: "png",
  timeoutMs: 180_000,
};

export const DEFAULT_WEBSEARCH_MODEL = "gpt-5.6-luna";

export const DEFAULT_WEBSEARCH_CONFIG: Required<WebsearchConfig> = {
  enabled: true,
  model: DEFAULT_WEBSEARCH_MODEL,
  reasoningEffort: "max",
  responseLength: "short",
  maxOutputTokens: 4096,
  timeoutMs: 25_000,
};

export const DEFAULT_LIVE_CONFIG: Required<LiveConfig> = {
  enabled: true,
  voice: DEFAULT_LIVE_VOICE,
};

export const DEFAULT_PET_CONFIG: Required<PetConfig> = {
  enabled: false,
  slug: "",
  placement: "inline-right",
  state: "idle",
  thinkingState: "review",
  toolState: "running",
  failedToolState: "failed",
  idleEmotes: true,
  idleEmoteIntervalMs: 30_000,
  sizeCells: 10,
};

export const DEFAULT_CONFIG: ConfigFile = {
  persistState: true,
  active: false,
  desiredActive: false,
  supportedModels: [...DEFAULT_SUPPORTED_MODELS],
  usage: DEFAULT_USAGE_CONFIG,
  footer: DEFAULT_FOOTER_CONFIG,
  image: DEFAULT_IMAGE_CONFIG,
  websearch: DEFAULT_WEBSEARCH_CONFIG,
  live: DEFAULT_LIVE_CONFIG,
  pets: DEFAULT_PET_CONFIG,
};

export type SettingsOptionSection =
  | "root"
  | "usage"
  | "footer"
  | "image"
  | "websearch"
  | "live"
  | "pets";

export type SettingsValueContext = {
  petEmptyValue?: string;
};

export type SettingsOptionDescriptor = {
  id: string;
  section: SettingsOptionSection;
  key: string;
  label: string;
  description: string;
  values?: readonly string[];
  parse(rawValue: string, context?: SettingsValueContext): boolean | number | string;
  currentValue(cfg: ResolvedConfig): string;
};

const booleanSetting = (rawValue: string): boolean => rawValue === "true";
const numberSetting = (rawValue: string): number => Number(rawValue);
const stringSetting = (rawValue: string): string => rawValue;

export const FAST_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "persistState",
    section: "root",
    key: "persistState",
    label: "Persist fast state",
    currentValue: (cfg) => String(cfg.persistState),
    values: ["true", "false"],
    description: "Remember fast-mode state across sessions.",
    parse: booleanSetting,
  },
];

export const FOOTER_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "footer.mode",
    section: "footer",
    key: "mode",
    label: "Footer mode",
    currentValue: (cfg) => cfg.footer.mode,
    values: FOOTER_MODES,
    description:
      "replace = custom footer, status = pi footer plus status line, off = no Better OpenAI footer/status unless Footer pet is enabled.",
    parse: stringSetting,
  },
];

export const USAGE_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "usage.enabled",
    section: "usage",
    key: "enabled",
    label: "Usage display",
    currentValue: (cfg) => String(cfg.usage.enabled),
    values: ["true", "false"],
    description: "Fetch and display OpenAI subscription usage windows.",
    parse: booleanSetting,
  },
  {
    id: "usage.refreshIntervalMs",
    section: "usage",
    key: "refreshIntervalMs",
    label: "Usage refresh",
    currentValue: (cfg) => String(cfg.usage.refreshIntervalMs),
    values: ["15000", "30000", "60000", "120000", "300000", "600000"],
    description: "Usage refresh interval in milliseconds.",
    parse: numberSetting,
  },
  {
    id: "usage.showOnlyOnSubscriptionModels",
    section: "usage",
    key: "showOnlyOnSubscriptionModels",
    label: "Usage only on OAuth",
    currentValue: (cfg) => String(cfg.usage.showOnlyOnSubscriptionModels),
    values: ["true", "false"],
    description: "Only show usage when the current OpenAI model uses subscription/OAuth auth.",
    parse: booleanSetting,
  },
  {
    id: "usage.showResetTimes",
    section: "usage",
    key: "showResetTimes",
    label: "Usage reset times",
    currentValue: (cfg) => String(cfg.usage.showResetTimes),
    values: ["true", "false"],
    description: "Include compact reset countdowns and local reset times.",
    parse: booleanSetting,
  },
];

export const IMAGE_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "image.enabled",
    section: "image",
    key: "enabled",
    label: "Image tool",
    currentValue: (cfg) => String(cfg.image.enabled),
    values: ["true", "false"],
    description: "Allow the openai_image tool to make image requests.",
    parse: booleanSetting,
  },
  {
    id: "image.defaultModel",
    section: "image",
    key: "defaultModel",
    label: "Image model",
    currentValue: (cfg) => cfg.image.defaultModel,
    values: ["gpt-image-2"],
    description: "GPT Image model used by the standalone Codex Images API.",
    parse: stringSetting,
  },
  {
    id: "image.defaultSave",
    section: "image",
    key: "defaultSave",
    label: "Image save",
    currentValue: (cfg) => cfg.image.defaultSave,
    values: IMAGE_SAVE_MODES,
    description: "Where generated images are saved by default.",
    parse: stringSetting,
  },
  {
    id: "image.outputFormat",
    section: "image",
    key: "outputFormat",
    label: "Image format",
    currentValue: (cfg) => cfg.image.outputFormat,
    values: IMAGE_OUTPUT_FORMATS,
    description: "Returned image format (converted locally from the Codex PNG response).",
    parse: stringSetting,
  },
  {
    id: "image.timeoutMs",
    section: "image",
    key: "timeoutMs",
    label: "Image timeout",
    currentValue: (cfg) => String(cfg.image.timeoutMs),
    values: ["30000", "60000", "120000", "180000", "300000"],
    description: "Image request timeout in milliseconds.",
    parse: numberSetting,
  },
];

export const WEBSEARCH_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "websearch.enabled",
    section: "websearch",
    key: "enabled",
    label: "Web search tool",
    currentValue: (cfg) => String(cfg.websearch.enabled),
    values: ["true", "false"],
    description: "Allow the openai_websearch tool to make search requests.",
    parse: booleanSetting,
  },
  {
    id: "websearch.model",
    section: "websearch",
    key: "model",
    label: "Search model",
    currentValue: (cfg) => cfg.websearch.model,
    values: ["gpt-5.6-luna"],
    description: "Model used by the ChatGPT Codex search backend.",
    parse: stringSetting,
  },
  {
    id: "websearch.reasoningEffort",
    section: "websearch",
    key: "reasoningEffort",
    label: "Search reasoning",
    currentValue: (cfg) => cfg.websearch.reasoningEffort,
    values: WEBSEARCH_REASONING_EFFORTS,
    description: "Reasoning effort requested from the search backend.",
    parse: stringSetting,
  },
  {
    id: "websearch.responseLength",
    section: "websearch",
    key: "responseLength",
    label: "Answer length",
    currentValue: (cfg) => cfg.websearch.responseLength,
    values: WEBSEARCH_RESPONSE_LENGTHS,
    description: "Default answer length produced by the search backend.",
    parse: stringSetting,
  },
  {
    id: "websearch.maxOutputTokens",
    section: "websearch",
    key: "maxOutputTokens",
    label: "Max output tokens",
    currentValue: (cfg) => String(cfg.websearch.maxOutputTokens),
    values: ["1024", "2048", "4096", "8192"],
    description: "Maximum output tokens for a search request.",
    parse: numberSetting,
  },
  {
    id: "websearch.timeoutMs",
    section: "websearch",
    key: "timeoutMs",
    label: "Search timeout",
    currentValue: (cfg) => String(cfg.websearch.timeoutMs),
    values: ["10000", "25000", "60000", "120000"],
    description: "Web search request timeout in milliseconds.",
    parse: numberSetting,
  },
];

export const LIVE_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "live.enabled",
    section: "live",
    key: "enabled",
    label: "Live voice",
    currentValue: (cfg) => String(cfg.live.enabled),
    values: ["true", "false"],
    description: "Allow /live to start a Codex-backed realtime voice session.",
    parse: booleanSetting,
  },
  {
    id: "live.voice",
    section: "live",
    key: "voice",
    label: "Voice",
    currentValue: (cfg) => cfg.live.voice,
    values: LIVE_VOICE_VALUES,
    description: "Voice used for realtime spoken responses.",
    parse: stringSetting,
  },
];

export const PET_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "pets.enabled",
    section: "pets",
    key: "enabled",
    label: "Enabled",
    currentValue: (cfg) => String(cfg.pets.enabled),
    values: ["true", "false"],
    description:
      "Render a custom Codex pet from ${CODEX_HOME:-~/.codex}/pets in the Better OpenAI footer.",
    parse: booleanSetting,
  },
  {
    id: "pets.slug",
    section: "pets",
    key: "slug",
    label: "Pet",
    currentValue: (cfg) => cfg.pets.slug,
    description: "Selected custom pet slug.",
    parse: (rawValue, context) =>
      rawValue === (context?.petEmptyValue ?? "not selected") ? "" : rawValue,
  },
  {
    id: "pets.placement",
    section: "pets",
    key: "placement",
    label: "Placement",
    currentValue: (cfg) => cfg.pets.placement,
    values: PET_PLACEMENTS,
    description: "Footer layout: stacked, inline-left, inline-right, badge, or habitat divider.",
    parse: stringSetting,
  },
  {
    id: "pets.state",
    section: "pets",
    key: "state",
    label: "Idle state",
    currentValue: (cfg) => cfg.pets.state,
    values: PET_STATES,
    description: "Animation row to show when pi is idle.",
    parse: stringSetting,
  },
  {
    id: "pets.thinkingState",
    section: "pets",
    key: "thinkingState",
    label: "Thinking state",
    currentValue: (cfg) => cfg.pets.thinkingState,
    values: PET_STATES,
    description: "Animation row to show while the model is thinking or streaming.",
    parse: stringSetting,
  },
  {
    id: "pets.toolState",
    section: "pets",
    key: "toolState",
    label: "Tool state",
    currentValue: (cfg) => cfg.pets.toolState,
    values: PET_STATES,
    description: "Animation row to show during tool execution.",
    parse: stringSetting,
  },
  {
    id: "pets.failedToolState",
    section: "pets",
    key: "failedToolState",
    label: "Failed tool state",
    currentValue: (cfg) => cfg.pets.failedToolState,
    values: PET_STATES,
    description: "Animation row to flash after any tool call returns an error.",
    parse: stringSetting,
  },
  {
    id: "pets.idleEmotes",
    section: "pets",
    key: "idleEmotes",
    label: "Random idle emotes",
    currentValue: (cfg) => String(cfg.pets.idleEmotes),
    values: ["true", "false"],
    description: "Occasionally flash a wave or jump while pi is idle.",
    parse: booleanSetting,
  },
  {
    id: "pets.idleEmoteIntervalMs",
    section: "pets",
    key: "idleEmoteIntervalMs",
    label: "Idle emote interval",
    currentValue: (cfg) => String(cfg.pets.idleEmoteIntervalMs),
    values: ["5000", "15000", "30000", "60000", "120000", "300000"],
    description: "Average delay between random idle pet emotes in milliseconds.",
    parse: numberSetting,
  },
  {
    id: "pets.sizeCells",
    section: "pets",
    key: "sizeCells",
    label: "Size",
    currentValue: (cfg) => String(cfg.pets.sizeCells),
    values: ["4", "6", "8", "10", "12", "16"],
    description: "Pet image width in terminal cells.",
    parse: numberSetting,
  },
];

export const SETTINGS_OPTION_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  ...FAST_SETTING_DESCRIPTORS,
  ...FOOTER_SETTING_DESCRIPTORS,
  ...USAGE_SETTING_DESCRIPTORS,
  ...IMAGE_SETTING_DESCRIPTORS,
  ...WEBSEARCH_SETTING_DESCRIPTORS,
  ...LIVE_SETTING_DESCRIPTORS,
  ...PET_SETTING_DESCRIPTORS,
];

const SETTINGS_OPTION_BY_ID = new Map(
  SETTINGS_OPTION_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configPaths(cwd: string, home = homedir(), env = process.env) {
  return {
    project: join(cwd, ".pi", "extensions", CONFIG_BASENAME),
    global: join(piAgentDir(env, home), "extensions", CONFIG_BASENAME),
  };
}

export function parseModelKey(value: string): SupportedModel | undefined {
  const key = value.trim();
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return undefined;
  const provider = key.slice(0, slash).trim();
  const id = key.slice(slash + 1).trim();
  return provider && id ? { provider, id } : undefined;
}

export function normalizeModelKeys(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => parseModelKey(entry))
    .filter((entry): entry is SupportedModel => entry !== undefined)
    .map((entry) => `${entry.provider}/${entry.id}`);
}

export function parseModels(value: unknown): SupportedModel[] | undefined {
  const keys = normalizeModelKeys(value);
  if (keys === undefined) return undefined;
  return keys
    .map((key) => parseModelKey(key))
    .filter((entry): entry is SupportedModel => entry !== undefined);
}

export function readRawConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${logPrefix()} Failed to read ${path}: ${message}`);
    return {};
  }
}

export function normalizeImageModel(value: string): string {
  const trimmed = value.trim();
  const model = trimmed.includes("/") ? trimmed.split("/").pop() || trimmed : trimmed;
  return model.startsWith("gpt-5") ? DEFAULT_IMAGE_MODEL : model;
}

export function readConfig(path: string): ConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = readRawConfig(path);
  const config: ConfigFile = {};
  if (typeof parsed.persistState === "boolean") config.persistState = parsed.persistState;
  if (typeof parsed.active === "boolean") config.active = parsed.active;
  if (typeof parsed.desiredActive === "boolean") config.desiredActive = parsed.desiredActive;
  const supportedModels = normalizeModelKeys(parsed.supportedModels);
  if (supportedModels !== undefined) config.supportedModels = supportedModels;
  if (isRecord(parsed.usage)) {
    config.usage = {};
    if (typeof parsed.usage.enabled === "boolean") config.usage.enabled = parsed.usage.enabled;
    if (typeof parsed.usage.refreshIntervalMs === "number")
      config.usage.refreshIntervalMs = parsed.usage.refreshIntervalMs;
    if (typeof parsed.usage.showOnlyOnSubscriptionModels === "boolean")
      config.usage.showOnlyOnSubscriptionModels = parsed.usage.showOnlyOnSubscriptionModels;
    if (typeof parsed.usage.showResetTimes === "boolean")
      config.usage.showResetTimes = parsed.usage.showResetTimes;
  }
  if (
    isRecord(parsed.footer) &&
    typeof parsed.footer.mode === "string" &&
    (FOOTER_MODES as readonly string[]).includes(parsed.footer.mode)
  ) {
    config.footer = { mode: parsed.footer.mode as FooterMode };
  }
  if (isRecord(parsed.image)) {
    config.image = {};
    if (typeof parsed.image.enabled === "boolean") config.image.enabled = parsed.image.enabled;
    if (typeof parsed.image.defaultModel === "string" && parsed.image.defaultModel.trim())
      config.image.defaultModel = normalizeImageModel(parsed.image.defaultModel);
    if (
      typeof parsed.image.defaultSave === "string" &&
      (IMAGE_SAVE_MODES as readonly string[]).includes(parsed.image.defaultSave)
    )
      config.image.defaultSave = parsed.image.defaultSave as ImageSaveMode;
    if (
      typeof parsed.image.outputFormat === "string" &&
      (IMAGE_OUTPUT_FORMATS as readonly string[]).includes(parsed.image.outputFormat)
    )
      config.image.outputFormat = parsed.image.outputFormat as ImageOutputFormat;
    if (typeof parsed.image.timeoutMs === "number") config.image.timeoutMs = parsed.image.timeoutMs;
  }
  if (isRecord(parsed.websearch)) {
    config.websearch = {};
    if (typeof parsed.websearch.enabled === "boolean")
      config.websearch.enabled = parsed.websearch.enabled;
    if (typeof parsed.websearch.model === "string" && parsed.websearch.model.trim())
      config.websearch.model = parsed.websearch.model.trim();
    if (
      typeof parsed.websearch.reasoningEffort === "string" &&
      (WEBSEARCH_REASONING_EFFORTS as readonly string[]).includes(parsed.websearch.reasoningEffort)
    )
      config.websearch.reasoningEffort = parsed.websearch
        .reasoningEffort as WebsearchReasoningEffort;
    if (
      typeof parsed.websearch.responseLength === "string" &&
      (WEBSEARCH_RESPONSE_LENGTHS as readonly string[]).includes(parsed.websearch.responseLength)
    )
      config.websearch.responseLength = parsed.websearch.responseLength as WebsearchResponseLength;
    if (typeof parsed.websearch.maxOutputTokens === "number")
      config.websearch.maxOutputTokens = parsed.websearch.maxOutputTokens;
    if (typeof parsed.websearch.timeoutMs === "number")
      config.websearch.timeoutMs = parsed.websearch.timeoutMs;
  }
  if (isRecord(parsed.live)) {
    config.live = {};
    if (typeof parsed.live.enabled === "boolean") config.live.enabled = parsed.live.enabled;
    if (isLiveVoice(parsed.live.voice)) config.live.voice = parsed.live.voice;
  }
  if (isRecord(parsed.pets)) {
    config.pets = {};
    if (typeof parsed.pets.enabled === "boolean") config.pets.enabled = parsed.pets.enabled;
    if (typeof parsed.pets.slug === "string") config.pets.slug = parsed.pets.slug.trim();
    if (
      typeof parsed.pets.placement === "string" &&
      (PET_PLACEMENTS as readonly string[]).includes(parsed.pets.placement)
    )
      config.pets.placement = parsed.pets.placement as PetPlacement;
    if (
      typeof parsed.pets.state === "string" &&
      (PET_STATES as readonly string[]).includes(parsed.pets.state)
    )
      config.pets.state = parsed.pets.state as PetState;
    if (
      typeof parsed.pets.thinkingState === "string" &&
      (PET_STATES as readonly string[]).includes(parsed.pets.thinkingState)
    )
      config.pets.thinkingState = parsed.pets.thinkingState as PetState;
    if (
      typeof parsed.pets.toolState === "string" &&
      (PET_STATES as readonly string[]).includes(parsed.pets.toolState)
    )
      config.pets.toolState = parsed.pets.toolState as PetState;
    if (
      typeof parsed.pets.failedToolState === "string" &&
      (PET_STATES as readonly string[]).includes(parsed.pets.failedToolState)
    )
      config.pets.failedToolState = parsed.pets.failedToolState as PetState;
    if (typeof parsed.pets.idleEmotes === "boolean")
      config.pets.idleEmotes = parsed.pets.idleEmotes;
    if (typeof parsed.pets.idleEmoteIntervalMs === "number")
      config.pets.idleEmoteIntervalMs = parsed.pets.idleEmoteIntervalMs;
    if (typeof parsed.pets.sizeCells === "number") config.pets.sizeCells = parsed.pets.sizeCells;
  }
  return config;
}

export type SettingPatchContext = SettingsValueContext & {
  persistState?: boolean;
  active?: boolean;
  desiredActive?: boolean;
};

export function applySettingToRawConfig(
  current: Record<string, unknown>,
  id: string,
  rawValue: string,
  context: SettingPatchContext = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  const bool = rawValue === "true";
  if (id === "fast.enabled") {
    if (context.persistState) {
      next.active = context.active ?? bool;
      next.desiredActive = context.desiredActive ?? bool;
    }
  } else {
    const descriptor = SETTINGS_OPTION_BY_ID.get(id);
    if (!descriptor) return next;
    const parsedValue = descriptor.parse(rawValue, context);
    if (descriptor.section === "root") next[descriptor.key] = parsedValue;
    else {
      const currentSection = next[descriptor.section];
      const section = isRecord(currentSection) ? { ...currentSection } : {};
      section[descriptor.key] = parsedValue;
      next[descriptor.section] = section;
    }
  }
  return next;
}

export function writeConfig(path: string, config: ConfigFile | Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${logPrefix()} Failed to write ${path}: ${message}`);
  }
}

function ensureConfigFile(projectConfigPath: string, globalConfigPath: string): void {
  if (existsSync(projectConfigPath) || existsSync(globalConfigPath)) return;
  writeConfig(globalConfigPath, DEFAULT_CONFIG);
}

export function resolveConfig(cwd: string): ResolvedConfig {
  const paths = configPaths(cwd);
  ensureConfigFile(paths.project, paths.global);

  const projectConfigExists = existsSync(paths.project);
  const globalConfigExists = existsSync(paths.global);
  const globalConfig = readConfig(paths.global) ?? {};
  const projectConfig = readConfig(paths.project) ?? {};
  const merged = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
  const selectedPath = projectConfigExists ? paths.project : paths.global;
  const desiredActive = merged.desiredActive ?? merged.active ?? false;

  return {
    configPath: selectedPath,
    projectConfigPath: paths.project,
    globalConfigPath: paths.global,
    projectConfigExists,
    globalConfigExists,
    persistState: merged.persistState ?? true,
    active: merged.active ?? desiredActive,
    desiredActive,
    supportedModels:
      parseModels(merged.supportedModels) ?? parseModels(DEFAULT_SUPPORTED_MODELS) ?? [],
    usage: {
      ...DEFAULT_USAGE_CONFIG,
      ...globalConfig.usage,
      ...projectConfig.usage,
      refreshIntervalMs: Math.max(
        15_000,
        Math.min(
          10 * 60_000,
          projectConfig.usage?.refreshIntervalMs ??
            globalConfig.usage?.refreshIntervalMs ??
            DEFAULT_USAGE_CONFIG.refreshIntervalMs,
        ),
      ),
    },
    footer: {
      ...DEFAULT_FOOTER_CONFIG,
      ...globalConfig.footer,
      ...projectConfig.footer,
    },
    image: {
      ...DEFAULT_IMAGE_CONFIG,
      ...globalConfig.image,
      ...projectConfig.image,
      timeoutMs: Math.max(
        30_000,
        Math.min(
          5 * 60_000,
          projectConfig.image?.timeoutMs ??
            globalConfig.image?.timeoutMs ??
            DEFAULT_IMAGE_CONFIG.timeoutMs,
        ),
      ),
    },
    websearch: {
      ...DEFAULT_WEBSEARCH_CONFIG,
      ...globalConfig.websearch,
      ...projectConfig.websearch,
      maxOutputTokens: Math.max(
        256,
        Math.min(
          100_000,
          projectConfig.websearch?.maxOutputTokens ??
            globalConfig.websearch?.maxOutputTokens ??
            DEFAULT_WEBSEARCH_CONFIG.maxOutputTokens,
        ),
      ),
      timeoutMs: Math.max(
        5_000,
        Math.min(
          120_000,
          projectConfig.websearch?.timeoutMs ??
            globalConfig.websearch?.timeoutMs ??
            DEFAULT_WEBSEARCH_CONFIG.timeoutMs,
        ),
      ),
    },
    live: {
      ...DEFAULT_LIVE_CONFIG,
      ...globalConfig.live,
      ...projectConfig.live,
    },
    pets: {
      ...DEFAULT_PET_CONFIG,
      ...globalConfig.pets,
      ...projectConfig.pets,
      idleEmoteIntervalMs: Math.max(
        5_000,
        Math.min(
          5 * 60_000,
          projectConfig.pets?.idleEmoteIntervalMs ??
            globalConfig.pets?.idleEmoteIntervalMs ??
            DEFAULT_PET_CONFIG.idleEmoteIntervalMs,
        ),
      ),
      sizeCells: Math.max(
        4,
        Math.min(
          16,
          projectConfig.pets?.sizeCells ??
            globalConfig.pets?.sizeCells ??
            DEFAULT_PET_CONFIG.sizeCells,
        ),
      ),
    },
  };
}
