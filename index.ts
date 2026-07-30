/**
 * Better OpenAI for pi.
 *
 * Adds `service_tier: "priority"` to OpenAI provider payloads while fast mode is
 * enabled and the selected model is in the configured allow-list.
 */
import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SettingsList } from "@earendil-works/pi-tui";
import { CONFIG_BASENAME, STATUS_KEY } from "./src/identity.ts";
import {
  formatTokens,
  redactDiagnosticValue,
  sanitizeStatusText,
  truncateToWidth,
  visibleWidth,
} from "./src/format.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_PET_CONFIG,
  DEFAULT_SUPPORTED_MODELS,
  PET_STATES,
  FOOTER_SETTING_DESCRIPTORS,
  USAGE_SETTING_DESCRIPTORS,
  IMAGE_SETTING_DESCRIPTORS,
  PET_SETTING_DESCRIPTORS,
  FAST_SETTING_DESCRIPTORS,
  type SettingsOptionDescriptor,
  configPaths,
  type ResolvedConfig,
  type PetState,
  isRecord,
  parseModelKey,
  normalizeModelKeys,
  parseModels,
  readRawConfig,
  resolveConfig,
  writeConfig,
  applySettingToRawConfig,
} from "./src/config.ts";
import {
  formatPercent,
  formatUsageSnapshot,
  parseUsageSnapshot,
  readCodexAuth,
} from "./src/usage.ts";
import { registerOpenAIImage, _imageTest } from "./src/image.ts";
import {
  type CodexPetPackage,
  codexHome,
  describeCodexPetSelectionIssue,
  findCodexPet,
  findReadyCodexPet,
  formatNoReadyCodexPetsMessage,
  listCodexPets,
  registerOpenAIPets,
  _petsTest,
} from "./src/pets.ts";
import { FastController, modelList, supportsFast } from "./src/fast-controller.ts";
import { UsageController } from "./src/usage-controller.ts";
import { PetFooterController } from "./src/pet-footer-controller.ts";
import {
  abbreviateHomePath,
  combineInlinePetFooter,
  isInlinePetPlacement,
  isTerminalImageLine,
  petSizeCellsForPlacement,
} from "./src/footer-layout.ts";

const COMMAND = "fast";
const OPENAI_STATUS_COMMAND = "openai-usage";
const OPENAI_SETTINGS_COMMAND = "openai-settings";
const FLAG = "fast";
const PET_EMPTY_VALUE = "not selected";
const SERVICE_TIER = "priority";
type SettingsPickerItem = {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
  submenu?: (
    currentValue: string,
    done: (selectedValue?: string) => void,
  ) => { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void };
};

function hasTerminalUI(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" || (ctx.mode === undefined && ctx.hasUI);
}

function readyPetPickerValues(pets: CodexPetPackage[]): string[] | undefined {
  const readyPets = pets.filter((pet) => pet.hasSpritesheet);
  return readyPets.length > 0 ? readyPets.map((pet) => pet.slug) : undefined;
}

function petConfigPickerValue(cfg: ResolvedConfig): string {
  return cfg.pets.slug || PET_EMPTY_VALUE;
}

function petSlugFromPickerValue(value: string): string {
  return value === PET_EMPTY_VALUE ? "" : value;
}

function findPickerPet(value: string, pets: CodexPetPackage[]): CodexPetPackage | undefined {
  return findCodexPet(
    pets.filter((pet) => pet.hasSpritesheet),
    value,
  );
}

function petPickerDescription(cfg: ResolvedConfig, pets: CodexPetPackage[]): string {
  const readyPets = pets.filter((pet) => pet.hasSpritesheet);
  if (readyPets.length === 0)
    return "No ready custom pets found. Use /pets help to create one, then return here.";
  if (!cfg.pets.slug) {
    const firstPet = readyPets[0]!;
    const lastPet = readyPets[readyPets.length - 1]!;
    return `No pet selected. Enter/Space/→ selects ${firstPet.name}; ← selects ${lastPet.name}.`;
  }
  const selectedPet = findPickerPet(cfg.pets.slug, readyPets);
  const selected = selectedPet
    ? `Selected: ${selectedPet.name} (${selectedPet.slug})`
    : `Selected: ${cfg.pets.slug}`;
  return `${selected}. Enter/Space/→ cycles pets; ← cycles back. Preview appears in the footer while this menu is open.`;
}

function formatPetSelectPrompt(
  pets: CodexPetPackage[],
  home = codexHome(),
): { message: string; level: "info" | "warning" } {
  const readyPets = pets.filter((pet) => pet.hasSpritesheet);
  if (readyPets.length === 0) {
    return { message: formatNoReadyCodexPetsMessage(pets, home), level: "warning" };
  }

  const brokenPets = pets.filter((pet) => !pet.hasSpritesheet);
  const lines = [
    "Choose one with /pets select <slug>:",
    ...readyPets.map((pet) => `- ${pet.slug} (${pet.name})`),
  ];
  if (brokenPets.length > 0) {
    lines.push(
      "",
      "Not ready:",
      ...brokenPets.map(
        (pet) =>
          `- ${pet.slug} (${pet.name}) — ${pet.spritesheetIssue ?? `missing ${pet.spritesheetPath}`}`,
      ),
    );
  }
  return { message: lines.join("\n"), level: "info" };
}

function textPanel(title: string, lines: string[], done: () => void) {
  return {
    render(width: number) {
      const clipped = lines.map((line) => truncateToWidth(line, width, "..."));
      return [title, "", ...clipped, "", "Esc/q to go back"];
    },
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") done();
    },
  };
}

export default function betterOpenAI(pi: ExtensionAPI): void {
  const fastController = new FastController(SERVICE_TIER);
  let cachedConfig: ResolvedConfig | undefined;
  let footerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let footerInstalled = false;
  let statusInstalled = false;
  let statusWidgetInstalled = false;
  let contextUsageCached = false;
  let cachedContextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
  let cachedContextLeafId: string | null | undefined;
  let cachedContextModel: ExtensionContext["model"];
  let sessionNameCached = false;
  let cachedSessionNameLeafId: string | null | undefined;
  let cachedSessionName: string | undefined;
  const usageController = new UsageController(config, updateFooter);
  const petController = new PetFooterController(config, updateFooter, () => footerInstalled);

  function refresh(ctx: ExtensionContext): ResolvedConfig {
    cachedConfig = resolveConfig(ctx.cwd || process.cwd());
    return cachedConfig;
  }

  function config(ctx: ExtensionContext): ResolvedConfig {
    return cachedConfig ?? refresh(ctx);
  }

  function persist(nextConfig: ResolvedConfig): void {
    cachedConfig = {
      ...nextConfig,
      active: fastController.active,
      desiredActive: fastController.desiredActive,
    };
    if (!nextConfig.persistState) return;
    writeConfig(nextConfig.configPath, {
      ...readRawConfig(nextConfig.configPath),
      active: fastController.active,
      desiredActive: fastController.desiredActive,
    });
  }

  function writePetConfig(ctx: ExtensionContext, patch: Record<string, unknown>): ResolvedConfig {
    const cfg = refresh(ctx);
    const current = readRawConfig(cfg.configPath);
    const pets = isRecord(current.pets) ? current.pets : {};
    writeConfig(cfg.configPath, { ...current, pets: { ...pets, ...patch } });
    petController.invalidateLoadKey();
    return refresh(ctx);
  }

  function setActive(ctx: ExtensionContext, next: boolean): void {
    const nextConfig = refresh(ctx);
    fastController.setDesired(ctx, nextConfig, next);
    persist(nextConfig);
    updateFooter(ctx);
    if (next && !fastController.active) {
      ctx.ui.notify(fastController.unsupportedRequestMessage(ctx, nextConfig), "warning");
      return;
    }
    ctx.ui.notify(fastController.stateText(ctx, nextConfig), "info");
  }

  function refreshFooterTotals(ctx: ExtensionContext): void {
    footerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      footerTotals.input += entry.message.usage.input;
      footerTotals.output += entry.message.usage.output;
      footerTotals.cacheRead += entry.message.usage.cacheRead;
      footerTotals.cacheWrite += entry.message.usage.cacheWrite;
      footerTotals.cost += entry.message.usage.cost.total;
    }
  }

  function invalidateContextUsage(): void {
    contextUsageCached = false;
    cachedContextUsage = undefined;
    cachedContextLeafId = undefined;
    cachedContextModel = undefined;
  }

  function contextUsage(ctx: ExtensionContext): ReturnType<ExtensionContext["getContextUsage"]> {
    const leafId = ctx.sessionManager.getLeafId();
    const model = ctx.model;
    if (!contextUsageCached || leafId !== cachedContextLeafId || model !== cachedContextModel) {
      cachedContextUsage = ctx.getContextUsage();
      contextUsageCached = true;
      cachedContextLeafId = leafId;
      cachedContextModel = model;
    }
    return cachedContextUsage;
  }

  function sessionName(ctx: ExtensionContext): string | undefined {
    const leafId = ctx.sessionManager.getLeafId();
    if (!sessionNameCached || leafId !== cachedSessionNameLeafId) {
      cachedSessionName = ctx.sessionManager.getSessionName();
      cachedSessionNameLeafId = leafId;
      sessionNameCached = true;
    }
    return cachedSessionName;
  }

  function invalidateSessionName(): void {
    sessionNameCached = false;
    cachedSessionNameLeafId = undefined;
    cachedSessionName = undefined;
  }

  pi.registerFlag(FLAG, {
    description: "Start with OpenAI fast mode enabled (service_tier=priority)",
    type: "boolean",
    default: false,
  });

  function formatDebugStatus(ctx: ExtensionContext): string {
    const cfg = config(ctx);
    return [
      ...fastController.debugLines(ctx, cfg),
      `Footer mode: ${cfg.footer.mode}`,
      "",
      usageController.formatDebug(ctx),
      "",
      `Image enabled: ${cfg.image.enabled}`,
      `Image default save: ${cfg.image.defaultSave}`,
      `Pet enabled: ${cfg.pets.enabled}`,
      `Pet slug: ${cfg.pets.slug || PET_EMPTY_VALUE}`,
      `Pet placement: ${cfg.pets.placement}`,
      `Pet failed tool state: ${cfg.pets.failedToolState}`,
      `Pet idle emotes: ${cfg.pets.idleEmotes} (${cfg.pets.idleEmoteIntervalMs}ms)`,
      `Pet loaded: ${petController.loadedPet?.pet.name ?? "none"}`,
      `Pet error: ${petController.error ?? "none"}`,
      `Config: ${cfg.configPath}`,
    ].join("\n");
  }

  pi.registerCommand(COMMAND, {
    description: "Toggle OpenAI fast mode",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg) return setActive(ctx, !fastController.desiredActive);
      ctx.ui.notify("Usage: /fast", "error");
    },
  });

  pi.registerCommand(OPENAI_STATUS_COMMAND, {
    description: "Show OpenAI subscription usage status",
    handler: async (_args, ctx) => {
      await usageController.refresh(ctx, ctx.model?.id, { notify: true, force: true });
    },
  });

  function buildPetSettingsItems(cfg: ResolvedConfig): SettingsPickerItem[] {
    return settingsItemsFromDescriptors(PET_SETTING_DESCRIPTORS, cfg, {
      "pets.slug": {
        currentValue: petConfigPickerValue(cfg),
        values: readyPetPickerValues(petController.settingsPets),
        description: petPickerDescription(cfg, petController.settingsPets),
      },
    });
  }

  function petPreviewFromItem(item: SettingsPickerItem | undefined): PetState | undefined {
    if (
      item?.id !== "pets.state" &&
      item?.id !== "pets.thinkingState" &&
      item?.id !== "pets.toolState" &&
      item?.id !== "pets.failedToolState"
    )
      return undefined;
    const value = item.currentValue;
    return (PET_STATES as readonly string[]).includes(value) ? (value as PetState) : undefined;
  }

  function renderPetSettingsPreview(ctx: ExtensionContext, width: number): string[] {
    return petController.renderSettingsPreview(ctx, width);
  }

  function settingsSubmenu(
    title: string,
    items: () => SettingsPickerItem[],
    ctx: ExtensionContext,
    done: () => void,
    options?: {
      onSelection?: (item: SettingsPickerItem | undefined) => void;
      onClose?: () => void;
      renderExtra?: (width: number) => string[];
    },
  ) {
    const theme = getSettingsListTheme();
    let selectedIndex = 0;
    let searchQuery = "";
    let closed = false;
    let submenuComponent: ReturnType<NonNullable<SettingsPickerItem["submenu"]>> | undefined;
    let submenuItemIndex: number | undefined;

    function currentItems(): SettingsPickerItem[] {
      const allItems = items();
      const query = searchQuery.trim().toLowerCase();
      const current = query
        ? allItems.filter((item) => item.label.toLowerCase().includes(query))
        : allItems;
      selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, current.length - 1)));
      return current;
    }

    function selectedItem(): SettingsPickerItem | undefined {
      return currentItems()[selectedIndex];
    }

    function close(): void {
      closed = true;
      options?.onClose?.();
      done();
    }

    function closeNestedSubmenu(): void {
      submenuComponent = undefined;
      if (submenuItemIndex !== undefined) selectedIndex = submenuItemIndex;
      submenuItemIndex = undefined;
      options?.onSelection?.(selectedItem());
    }

    function cycleSelected(direction: 1 | -1 = 1): void {
      const item = selectedItem();
      if (!item?.values?.length) return;
      const currentIndex = item.values.indexOf(item.currentValue);
      const startIndex = currentIndex === -1 ? (direction === 1 ? -1 : 0) : currentIndex;
      const newValue =
        item.values[(startIndex + direction + item.values.length) % item.values.length] ??
        item.currentValue;
      writeSetting(ctx, item.id, newValue);
      options?.onSelection?.(selectedItem());
    }

    function activateSelected(): void {
      const item = selectedItem();
      if (!item) return;
      if (item.submenu) {
        submenuItemIndex = selectedIndex;
        submenuComponent = item.submenu(item.currentValue, (selectedValue?: string) => {
          if (selectedValue !== undefined) writeSetting(ctx, item.id, selectedValue);
          closeNestedSubmenu();
        });
        return;
      }
      cycleSelected(1);
    }

    return {
      render(width: number) {
        if (submenuComponent) return submenuComponent.render(width);
        const current = currentItems();
        const selected = selectedItem();
        if (!closed) options?.onSelection?.(selected);
        const lines = [title, "", `> ${searchQuery}`, ""];
        const maxVisible = 8;
        const startIndex = Math.max(
          0,
          Math.min(selectedIndex - Math.floor(maxVisible / 2), current.length - maxVisible),
        );
        const visible = current.slice(startIndex, startIndex + maxVisible);
        if (current.length === 0) {
          lines.push(theme.hint("  No matching settings"));
          lines.push("", theme.hint("  Type to search · Esc to go back"));
          return lines;
        }
        const maxLabelWidth = Math.min(
          30,
          Math.max(1, ...current.map((item) => visibleWidth(item.label))),
        );
        for (let i = 0; i < visible.length; i++) {
          const item = visible[i];
          if (!item) continue;
          const itemIndex = startIndex + i;
          const isSelected = itemIndex === selectedIndex;
          const prefix = isSelected ? theme.cursor : "  ";
          const labelPadded =
            item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
          const valueMaxWidth = Math.max(1, width - visibleWidth(prefix) - maxLabelWidth - 4);
          lines.push(
            truncateToWidth(
              prefix +
                theme.label(labelPadded, isSelected) +
                "  " +
                theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected),
              width,
            ),
          );
        }
        if (selected?.description) {
          lines.push(
            "",
            theme.description(`  ${truncateToWidth(selected.description, width - 4)}`),
          );
        }
        const extraLines = options?.renderExtra?.(width) ?? [];
        if (extraLines.length > 0) {
          lines.push("");
          for (const line of extraLines) {
            lines.push(isTerminalImageLine(line) ? line : truncateToWidth(line, width, "..."));
          }
        }
        lines.push(
          "",
          theme.hint("  Type to search · ↑↓ navigate · ←→/Enter/Space to change · Esc to go back"),
        );
        return lines;
      },
      invalidate() {
        submenuComponent?.invalidate();
      },
      handleInput(data: string) {
        if (submenuComponent) {
          submenuComponent.handleInput?.(data);
          return;
        }
        const current = currentItems();
        if (current.length === 0) {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) close();
          else if (matchesKey(data, Key.backspace)) searchQuery = searchQuery.slice(0, -1);
          else if (data.length === 1 && data >= "!" && data <= "~") searchQuery += data;
          return;
        }
        if (matchesKey(data, Key.up))
          selectedIndex = selectedIndex === 0 ? current.length - 1 : selectedIndex - 1;
        else if (matchesKey(data, Key.down))
          selectedIndex = selectedIndex === current.length - 1 ? 0 : selectedIndex + 1;
        else if (
          matchesKey(data, Key.right) ||
          matchesKey(data, Key.enter) ||
          matchesKey(data, Key.space) ||
          data === " "
        )
          activateSelected();
        else if (matchesKey(data, Key.left)) cycleSelected(-1);
        else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) close();
        else if (matchesKey(data, Key.backspace)) {
          searchQuery = searchQuery.slice(0, -1);
          selectedIndex = 0;
        } else if (data.length === 1 && data >= "!" && data <= "~") {
          searchQuery += data;
          selectedIndex = 0;
        }
        if (!closed) options?.onSelection?.(selectedItem());
      },
    };
  }

  function fastSettingsSummary(ctx: ExtensionContext, cfg: ResolvedConfig): string {
    return fastController.settingsSummary(ctx, cfg);
  }

  function usageSettingsSummary(cfg: ResolvedConfig): string {
    return cfg.usage.enabled
      ? `enabled · ${Math.round(cfg.usage.refreshIntervalMs / 1000)}s`
      : "disabled";
  }

  function imageSettingsSummary(cfg: ResolvedConfig): string {
    return cfg.image.enabled
      ? `enabled · ${cfg.image.defaultModel} · ${cfg.image.defaultSave}/${cfg.image.outputFormat}`
      : "disabled";
  }

  function petSettingsSummary(cfg: ResolvedConfig): string {
    const selected = cfg.pets.slug || (cfg.pets.enabled ? "first ready" : PET_EMPTY_VALUE);
    const status = cfg.pets.enabled ? "enabled" : "disabled";
    return `${status} · ${selected} · ${cfg.pets.placement}`;
  }

  type SettingsItemOverrides = Record<
    string,
    Partial<Pick<SettingsPickerItem, "currentValue" | "description" | "values">>
  >;

  function settingsItemsFromDescriptors(
    descriptors: readonly SettingsOptionDescriptor[],
    cfg: ResolvedConfig,
    overrides: SettingsItemOverrides = {},
  ): SettingsPickerItem[] {
    return descriptors.map((descriptor) => {
      const override = overrides[descriptor.id] ?? {};
      const values = override.values ?? descriptor.values;
      return {
        id: descriptor.id,
        label: descriptor.label,
        currentValue: override.currentValue ?? descriptor.currentValue(cfg),
        values: values ? [...values] : undefined,
        description: override.description ?? descriptor.description,
      };
    });
  }

  function buildFastSettingsItems(cfg: ResolvedConfig): SettingsPickerItem[] {
    return [
      {
        id: "fast.enabled",
        label: "Fast mode",
        currentValue: String(fastController.desiredActive),
        values: ["true", "false"],
        description: `Request OpenAI fast mode. Activates for supported models: ${modelList(cfg.supportedModels)}.`,
      },
      ...settingsItemsFromDescriptors(FAST_SETTING_DESCRIPTORS, cfg),
    ];
  }

  function buildFooterSettingsItems(cfg: ResolvedConfig): SettingsPickerItem[] {
    return settingsItemsFromDescriptors(FOOTER_SETTING_DESCRIPTORS, cfg);
  }

  function buildUsageSettingsItems(cfg: ResolvedConfig): SettingsPickerItem[] {
    return settingsItemsFromDescriptors(USAGE_SETTING_DESCRIPTORS, cfg);
  }

  function buildImageSettingsItems(cfg: ResolvedConfig): SettingsPickerItem[] {
    return settingsItemsFromDescriptors(IMAGE_SETTING_DESCRIPTORS, cfg);
  }

  function buildDiagnosticsSettingsItems(
    ctx: ExtensionContext,
    cfg: ResolvedConfig,
  ): SettingsPickerItem[] {
    return [
      {
        id: "debug",
        label: "Debug info",
        currentValue: "open",
        description: "Show Better OpenAI diagnostics.",
        submenu: (_value, done) =>
          textPanel("Debug info", formatDebugStatus(ctx).split("\n"), () => done()),
      },
      {
        id: "config.path",
        label: "Config path",
        currentValue: cfg.configPath,
        description: `Project: ${cfg.projectConfigPath}\nGlobal: ${cfg.globalConfigPath}`,
      },
      {
        id: "config.print",
        label: "Print config",
        currentValue: "open",
        description: "Show the selected config JSON with sensitive fields redacted.",
        submenu: (_value, done) =>
          textPanel(
            "Config",
            JSON.stringify(redactDiagnosticValue(readRawConfig(cfg.configPath)), null, 2).split(
              "\n",
            ),
            () => done(),
          ),
      },
    ];
  }

  function buildSettingsSections(ctx: ExtensionContext, cfg: ResolvedConfig): SettingsPickerItem[] {
    return [
      {
        id: "section.fast",
        label: "Fast mode",
        currentValue: fastSettingsSummary(ctx, cfg),
        description: "Configure OpenAI fast mode and persistence.",
        submenu: (_value, done) =>
          settingsSubmenu(
            "Fast mode settings",
            () => buildFastSettingsItems(config(ctx)),
            ctx,
            () => done(fastSettingsSummary(ctx, config(ctx))),
          ),
      },
      {
        id: "section.footer",
        label: "Footer",
        currentValue: cfg.footer.mode,
        description: "Configure Better OpenAI footer ownership.",
        submenu: (_value, done) =>
          settingsSubmenu(
            "Footer settings",
            () => buildFooterSettingsItems(config(ctx)),
            ctx,
            () => done(config(ctx).footer.mode),
          ),
      },
      {
        id: "section.usage",
        label: "Usage",
        currentValue: usageSettingsSummary(cfg),
        description: "Configure subscription usage fetching and display.",
        submenu: (_value, done) =>
          settingsSubmenu(
            "Usage settings",
            () => buildUsageSettingsItems(config(ctx)),
            ctx,
            () => done(usageSettingsSummary(config(ctx))),
          ),
      },
      {
        id: "section.image",
        label: "Image tool",
        currentValue: imageSettingsSummary(cfg),
        description: "Configure OpenAI image generation defaults.",
        submenu: (_value, done) =>
          settingsSubmenu(
            "Image tool settings",
            () => buildImageSettingsItems(config(ctx)),
            ctx,
            () => done(imageSettingsSummary(config(ctx))),
          ),
      },
      {
        id: "section.pets",
        label: "Footer pet",
        currentValue: petSettingsSummary(cfg),
        description: "Configure footer pet visibility, animation-state mapping, and size.",
        submenu: (_value, done) => {
          petController.setSettingsPreviewActive(ctx, true);
          return settingsSubmenu(
            "Footer pet settings",
            () => buildPetSettingsItems(config(ctx)),
            ctx,
            () => done(petSettingsSummary(config(ctx))),
            {
              onSelection: (item) => {
                const previewState = petPreviewFromItem(item);
                if (previewState !== petController.previewState) {
                  petController.setPreviewState(previewState);
                  updateFooter(ctx);
                }
              },
              onClose: () => {
                petController.setPreviewState(undefined);
                petController.setSettingsPreviewActive(ctx, false);
                updateFooter(ctx);
              },
              renderExtra: (width) => renderPetSettingsPreview(ctx, width),
            },
          );
        },
      },
      {
        id: "section.diagnostics",
        label: "Diagnostics",
        currentValue: "debug / config",
        description: "Show Better OpenAI diagnostics and raw config details.",
        submenu: (_value, done) =>
          settingsSubmenu(
            "Diagnostics",
            () => buildDiagnosticsSettingsItems(ctx, config(ctx)),
            ctx,
            () => done("debug / config"),
          ),
      },
    ];
  }

  function writeSetting(ctx: ExtensionContext, id: string, rawValue: string): void {
    const cfg = refresh(ctx);
    const current = readRawConfig(cfg.configPath);
    const bool = rawValue === "true";
    if (id === "fast.enabled") {
      fastController.setDesired(ctx, cfg, bool);
    }
    const petKey = id.startsWith("pets.") ? id.slice("pets.".length) : undefined;
    const nextRawConfig = applySettingToRawConfig(current, id, rawValue, {
      persistState: cfg.persistState,
      active: fastController.active,
      desiredActive: fastController.desiredActive,
      petEmptyValue: PET_EMPTY_VALUE,
    });
    if (petKey) {
      if (petKey === "enabled" || petKey === "sizeCells" || petKey === "slug")
        petController.invalidateLoadKey();
      if (petKey === "placement" || petKey === "sizeCells" || petKey === "slug")
        petController.resetRenderCache();
      if (petKey === "idleEmotes" || petKey === "idleEmoteIntervalMs")
        petController.stopIdleEmotes();
    }
    writeConfig(cfg.configPath, nextRawConfig);
    const next = refresh(ctx);
    if (id === "pets.enabled" || id === "pets.sizeCells" || id === "pets.slug")
      void petController.refresh(ctx, next);
    if (id.startsWith("usage.")) {
      usageController.restartAfterSettingsChange(ctx, next);
    }
    updateFooter(ctx);
  }

  async function showSettingsPicker(ctx: ExtensionContext): Promise<void> {
    if (!hasTerminalUI(ctx)) {
      ctx.ui.notify("Better OpenAI settings require interactive TUI mode.", "warning");
      return;
    }
    try {
      petController.settingsPets = await listCodexPets();
    } catch {
      petController.settingsPets = [];
    }
    try {
      await ctx.ui.custom((tui, theme, _kb, done) => {
        petController.setSettingsRenderRequest(() => tui.requestRender());
        const container = new Container();
        container.addChild(
          new (class {
            render(_width: number) {
              const cfg = config(ctx);
              return [
                theme.fg("accent", theme.bold("Better OpenAI Settings")),
                theme.fg("dim", cfg.configPath),
                "",
              ];
            }
            invalidate() {}
          })(),
        );
        const settingsList = new SettingsList(
          buildSettingsSections(ctx, refresh(ctx)),
          8,
          getSettingsListTheme(),
          (id, newValue) => {
            if (!id.startsWith("section.")) writeSetting(ctx, id, newValue);
            settingsList.updateValue(
              id,
              buildSettingsSections(ctx, config(ctx)).find((item) => item.id === id)
                ?.currentValue ?? newValue,
            );
            tui.requestRender();
          },
          () => done(undefined),
          { enableSearch: true },
        );
        container.addChild(settingsList);
        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            settingsList.handleInput(data);
            tui.requestRender();
          },
        };
      });
    } finally {
      petController.setSettingsRenderRequest(undefined);
      petController.setPreviewState(undefined);
      petController.setSettingsPreviewActive(ctx, false);
      updateFooter(ctx);
    }
  }

  pi.registerCommand(OPENAI_SETTINGS_COMMAND, {
    description: "Open Better OpenAI settings picker",
    handler: async (_args, ctx) => {
      await showSettingsPicker(ctx);
    },
  });

  registerOpenAIImage(pi, config);
  registerOpenAIPets(pi, {
    wake: async (ctx, slug) => {
      const pets = await listCodexPets();
      const requestedSlug = (slug ?? config(ctx).pets.slug) || undefined;
      const selectedPet = findReadyCodexPet(pets, requestedSlug);
      if (!selectedPet) {
        const issue = describeCodexPetSelectionIssue(pets, requestedSlug);
        ctx.ui.notify(issue.message, "warning");
        return;
      }

      const next = writePetConfig(ctx, {
        enabled: true,
        slug: selectedPet.slug,
      });
      updateFooter(ctx);
      if (hasTerminalUI(ctx)) await petController.refresh(ctx, next, true);
      else
        ctx.ui.notify(
          `Enabled ${selectedPet.name} (${selectedPet.slug}); footer pets render in interactive TUI mode.`,
          "info",
        );
    },
    tuck: (ctx) => {
      writePetConfig(ctx, { enabled: false });
      petController.tuck();
      updateFooter(ctx);
      ctx.ui.notify("Footer pet tucked away.", "info");
    },
    select: async (ctx, slug) => {
      const pets = await listCodexPets();
      if (!slug) {
        const prompt = formatPetSelectPrompt(pets);
        ctx.ui.notify(prompt.message, prompt.level);
        return;
      }

      const selectedPet = findReadyCodexPet(pets, slug);
      if (!selectedPet) {
        const issue = describeCodexPetSelectionIssue(pets, slug);
        ctx.ui.notify(issue.message, "warning");
        return;
      }

      const next = writePetConfig(ctx, { slug: selectedPet.slug });
      updateFooter(ctx);
      if (petController.shouldLoadForConfig(next)) {
        if (hasTerminalUI(ctx)) await petController.refresh(ctx, next, true);
        else
          ctx.ui.notify(
            `Selected ${selectedPet.name} (${selectedPet.slug}); footer pets render in interactive TUI mode.`,
            "info",
          );
      } else {
        ctx.ui.notify(
          `Selected ${selectedPet.name} (${selectedPet.slug}) for the footer pet. Use /pets wake to show it.`,
          "info",
        );
      }
    },
  });

  function installFooter(ctx: ExtensionContext): void {
    if (footerInstalled) {
      petController.requestFooterRenderNow();
      return;
    }
    footerInstalled = true;
    ctx.ui.setFooter((tui, theme, footerData) => {
      petController.setFooterRenderRequest(() => tui.requestRender());
      const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());
      let lastFooterSizeKey: string | undefined;
      return {
        dispose: () => {
          unsubscribe?.();
          petController.stopIdleEmotes();
          petController.stopAnimation();
          petController.stopPendingRenderRequest();
          petController.disposeKittyNow();
          footerInstalled = false;
          petController.setFooterRenderRequest(undefined);
        },
        invalidate() {
          petController.queueKittyCleanup();
          petController.resetRenderCache();
        },
        render(width: number): string[] {
          const now = Date.now();
          const footerSizeKey = `${width}:${process.stdout.rows ?? 0}`;
          if (lastFooterSizeKey !== undefined && lastFooterSizeKey !== footerSizeKey) {
            petController.freezeForResize(ctx, now);
          }
          lastFooterSizeKey = footerSizeKey;
          const freezePetFrame = petController.isResizeFrozen(now);

          const totalInput = footerTotals.input;
          const totalOutput = footerTotals.output;
          const totalCacheRead = footerTotals.cacheRead;
          const totalCacheWrite = footerTotals.cacheWrite;
          const totalCost = footerTotals.cost;

          let pwd = abbreviateHomePath(ctx.sessionManager.getCwd());

          const branch = footerData.getGitBranch?.();
          if (branch) pwd = `${pwd} (${branch})`;

          const currentSessionName = sessionName(ctx);
          if (currentSessionName) pwd = `${pwd} • ${currentSessionName}`;

          const parts: string[] = [];
          if (totalInput) parts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) parts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) parts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) parts.push(`W${formatTokens(totalCacheWrite)}`);

          const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
          if (totalCost || usingSubscription)
            parts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

          const currentContextUsage = contextUsage(ctx);
          const contextWindow = currentContextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = currentContextUsage?.percent ?? 0;
          const contextPercent =
            currentContextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
          const contextDisplay =
            contextPercent === "?"
              ? `?/${formatTokens(contextWindow)} (auto)`
              : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
          const contextText =
            contextPercentValue > 90
              ? theme.fg("error", contextDisplay)
              : contextPercentValue > 70
                ? theme.fg("warning", contextDisplay)
                : contextDisplay;
          parts.push(contextText);

          const cfg = config(ctx);
          const shouldRenderPet = petController.shouldRenderInFooter(cfg);
          const requestedPetPlacement = cfg.pets.placement;
          const requestedPetSizeCells = petSizeCellsForPlacement(
            requestedPetPlacement,
            cfg.pets.sizeCells,
          );
          const inlinePet = Boolean(
            shouldRenderPet &&
            petController.loadedPet &&
            isInlinePetPlacement(requestedPetPlacement) &&
            width >= requestedPetSizeCells + 32,
          );
          const petRenderSizeCells = inlinePet ? requestedPetSizeCells : cfg.pets.sizeCells;
          const petColumnWidth = Math.min(petRenderSizeCells, Math.max(1, width - 1));
          const footerTextWidth = inlinePet ? Math.max(1, width - petColumnWidth - 2) : width;

          const usageStatusLine = usageController.statusLine(ctx, cfg, usingSubscription);
          const usageLine = usageStatusLine ? theme.fg("dim", usageStatusLine) : undefined;

          let statsLeft = parts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > footerTextWidth) {
            statsLeft = truncateToWidth(statsLeft, footerTextWidth, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }

          const modelName = ctx.model?.id || "no-model";
          const thinkingLevel = pi.getThinkingLevel();
          const fastSuffix =
            fastController.active && supportsFast(ctx, cfg.supportedModels) ? " fast" : "";
          let rightWithoutProvider = modelName;
          if (ctx.model?.reasoning) {
            rightWithoutProvider =
              thinkingLevel === "off"
                ? `${modelName}${fastSuffix} • thinking off`
                : `${modelName}${fastSuffix} • ${thinkingLevel}`;
          } else if (fastSuffix) {
            rightWithoutProvider = `${modelName}${fastSuffix}`;
          }

          let rightSide = rightWithoutProvider;
          if ((footerData.getAvailableProviderCount?.() ?? 0) > 1 && ctx.model) {
            const withProvider = `(${ctx.model.provider}) ${rightWithoutProvider}`;
            if (statsLeftWidth + 2 + visibleWidth(withProvider) <= footerTextWidth)
              rightSide = withProvider;
          }

          const rightWidth = visibleWidth(rightSide);
          const totalNeeded = statsLeftWidth + 2 + rightWidth;
          let statsLine: string;
          if (totalNeeded <= footerTextWidth) {
            statsLine =
              statsLeft + " ".repeat(footerTextWidth - statsLeftWidth - rightWidth) + rightSide;
          } else {
            const availableForRight = footerTextWidth - statsLeftWidth - 2;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
              statsLine =
                statsLeft +
                " ".repeat(
                  Math.max(0, footerTextWidth - statsLeftWidth - visibleWidth(truncatedRight)),
                ) +
                truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          const textLines: string[] = [
            truncateToWidth(theme.fg("dim", pwd), footerTextWidth, theme.fg("dim", "...")),
            theme.fg("dim", statsLeft) + theme.fg("dim", statsLine.slice(statsLeft.length)),
          ];

          if (usageLine) {
            textLines.push(truncateToWidth(usageLine, footerTextWidth, theme.fg("dim", "...")));
          }

          const extensionStatuses = footerData.getExtensionStatuses?.();
          if (extensionStatuses?.size) {
            const statusLines = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => String(a).localeCompare(String(b)))
              .map(([, text]) => theme.fg("dim", sanitizeStatusText(String(text))));
            textLines.push(
              ...statusLines.map((line) =>
                truncateToWidth(line, footerTextWidth, theme.fg("dim", "...")),
              ),
            );
          }

          const petLines = petController.renderPetLines(ctx, cfg, {
            shouldRenderPet,
            freezePetFrame,
            requestedPetPlacement,
            petColumnWidth,
            petRenderSizeCells,
            width,
            theme,
          });

          if (!shouldRenderPet || petLines.length === 0)
            return petController.withPendingKittyCleanup(textLines);

          if (inlinePet) {
            return petController.withPendingKittyCleanup(
              combineInlinePetFooter(
                petLines,
                textLines,
                width,
                requestedPetPlacement,
                petColumnWidth,
              ),
            );
          }

          if (requestedPetPlacement === "habitat" && petController.loadedPet) {
            const label = ` ${petController.loadedPet.pet.name} `;
            const divider = theme.fg(
              "dim",
              truncateToWidth(`─${label}${"─".repeat(width)}`, width, ""),
            );
            return petController.withPendingKittyCleanup([divider, ...petLines, ...textLines]);
          }

          return petController.withPendingKittyCleanup([...petLines, ...textLines]);
        },
      };
    });
  }

  function clearFooter(ctx: ExtensionContext): void {
    if (!footerInstalled) return;
    petController.disposeKittyNow();
    ctx.ui.setFooter(undefined);
    footerInstalled = false;
    petController.setFooterRenderRequest(undefined);
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined): void {
    if (!text && !statusInstalled) return;
    ctx.ui.setStatus(STATUS_KEY, text);
    statusInstalled = text !== undefined;
  }

  function setStatusWidget(ctx: ExtensionContext, text: string | undefined): void {
    if (!text && !statusWidgetInstalled) return;
    ctx.ui.setWidget(
      STATUS_KEY,
      text
        ? (_tui, theme) => ({
            invalidate() {},
            render(width: number): string[] {
              const line = theme.fg("dim", sanitizeStatusText(text));
              return [truncateToWidth(line, width, theme.fg("dim", "..."))];
            },
          })
        : undefined,
      { placement: "belowEditor" },
    );
    statusWidgetInstalled = text !== undefined;
  }

  function updateFooter(ctx: ExtensionContext): void {
    const cfg = config(ctx);

    if (!hasTerminalUI(ctx)) {
      if (cfg.footer.mode === "off") {
        setStatus(ctx, undefined);
        return;
      }
      const fast = fastController.statusSegment(ctx, cfg);
      const usage = usageController.statusLine(ctx, cfg);
      setStatus(ctx, [fast, usage].filter(Boolean).join(" | ") || undefined);
      return;
    }

    petController.updateActivity(ctx, cfg);
    const shouldRenderPet = petController.shouldRenderInFooter(cfg);

    if (cfg.footer.mode === "replace" || shouldRenderPet) {
      setStatus(ctx, undefined);
      setStatusWidget(ctx, undefined);
      installFooter(ctx);
      return;
    }

    clearFooter(ctx);
    setStatus(ctx, undefined);

    if (cfg.footer.mode === "off") {
      setStatusWidget(ctx, undefined);
      return;
    }

    const fast = fastController.statusSegment(ctx, cfg);
    const usage = usageController.statusLine(ctx, cfg);
    setStatusWidget(ctx, [fast, usage].filter(Boolean).join(" | ") || undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    invalidateContextUsage();
    invalidateSessionName();
    const nextConfig = refresh(ctx);
    fastController.initializeForSession(ctx, nextConfig, pi.getFlag(FLAG) === true);
    if (
      fastController.desiredActive !== nextConfig.desiredActive ||
      fastController.active !== nextConfig.active
    )
      persist(nextConfig);
    if (fastController.desiredActive && !fastController.active) {
      ctx.ui.notify(fastController.unsupportedRequestMessage(ctx, nextConfig), "warning");
    }
    if (hasTerminalUI(ctx)) petController.installResizeGuard(ctx);
    refreshFooterTotals(ctx);
    updateFooter(ctx);
    if (hasTerminalUI(ctx) && nextConfig.pets.enabled) void petController.refresh(ctx, nextConfig);
    usageController.start(ctx);
    if (fastController.active) ctx.ui.notify(fastController.stateText(ctx, nextConfig), "info");
  });

  pi.on("agent_start", (_event, ctx) => {
    invalidateContextUsage();
    petController.agentStart(ctx);
    updateFooter(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    petController.toolStart(ctx, event.toolCallId);
    updateFooter(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    petController.toolEnd(ctx, event.toolCallId, event.isError);
    if (!event.isError) updateFooter(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    petController.agentEnd();
    updateFooter(ctx);
  });

  pi.on("turn_end", (event, ctx) => {
    invalidateContextUsage();
    if (event.message?.role === "assistant") {
      footerTotals.input += event.message.usage.input;
      footerTotals.output += event.message.usage.output;
      footerTotals.cacheRead += event.message.usage.cacheRead;
      footerTotals.cacheWrite += event.message.usage.cacheWrite;
      footerTotals.cost += event.message.usage.cost.total;
    } else refreshFooterTotals(ctx);
    updateFooter(ctx);
    void usageController.refresh(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    invalidateContextUsage();
    refreshFooterTotals(ctx);
    petController.queueKittyCleanup();
    petController.resetRenderCache();
    updateFooter(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    invalidateContextUsage();
    refreshFooterTotals(ctx);
    petController.queueKittyCleanup();
    petController.resetRenderCache();
    updateFooter(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    invalidateContextUsage();
    const cfg = config(ctx);
    const wasActive = fastController.active;
    fastController.applyDesiredState(ctx, cfg);
    if (fastController.active !== wasActive) {
      persist(cfg);
      ctx.ui.notify(
        fastController.active
          ? fastController.stateText(ctx, cfg)
          : fastController.inactiveForModelMessage(ctx),
        fastController.active ? "info" : "warning",
      );
    }
    updateFooter(ctx);
    void usageController.refresh(ctx, event.model.id, { force: true });
  });

  pi.on("session_shutdown", () => {
    invalidateContextUsage();
    invalidateSessionName();
    usageController.shutdown();
    petController.shutdown();
  });

  pi.on("before_provider_request", (event, ctx) => {
    return fastController.injectProviderPayload(event, ctx, config(ctx));
  });

  pi.on("message_start", invalidateContextUsage);
  pi.on("message_update", invalidateContextUsage);
  pi.on("message_end", invalidateContextUsage);
}

export const _test = {
  CONFIG_BASENAME,
  DEFAULT_SUPPORTED_MODELS,
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_PET_CONFIG,
  SERVICE_TIER,
  configPaths,
  abbreviateHomePath,
  parseModelKey,
  normalizeModelKeys,
  parseModels,
  resolveConfig,
  readRawConfig,
  supportsFast,
  combineInlinePetFooter,
  PET_EMPTY_VALUE,
  readyPetPickerValues,
  petConfigPickerValue,
  petSlugFromPickerValue,
  petPickerDescription,
  formatPetSelectPrompt,
  parseUsageSnapshot,
  formatPercent,
  formatUsageSnapshot,
  readCodexAuth,
  textPanel,
  imageTest: _imageTest,
  petsTest: _petsTest,
};
