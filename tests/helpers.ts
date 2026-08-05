import {
  DEFAULT_FOOTER_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_LIVE_CONFIG,
  DEFAULT_PET_CONFIG,
  DEFAULT_USAGE_CONFIG,
  type ResolvedConfig,
} from "../src/config.ts";

export function makeResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    configPath: "",
    projectConfigPath: "",
    globalConfigPath: "",
    projectConfigExists: false,
    globalConfigExists: false,
    persistState: true,
    active: false,
    desiredActive: false,
    supportedModels: [],
    usage: DEFAULT_USAGE_CONFIG,
    footer: DEFAULT_FOOTER_CONFIG,
    image: DEFAULT_IMAGE_CONFIG,
    live: DEFAULT_LIVE_CONFIG,
    pets: DEFAULT_PET_CONFIG,
    ...overrides,
  };
}
