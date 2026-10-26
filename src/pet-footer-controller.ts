import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { calculateImageRows, getCapabilities, getCellDimensions } from "@earendil-works/pi-tui";
import type { PetPlacement, PetState, ResolvedConfig } from "./config.ts";
import {
  animationFrameAt,
  type CodexPetPackage,
  CodexPetKittyManager,
  describeCodexPetSelectionIssue,
  type LoadedCodexPet,
  loadCodexPet,
  nextAnimationFrameDelayMs,
  PET_ANIMATION_ROWS,
  renderCodexPetFrame,
  listCodexPets,
} from "./pets.ts";
import { truncateToWidth } from "./format.ts";

const PET_RESIZE_FREEZE_MS = 120;
const PET_RENDER_CACHE_LIMIT = 48;

type ThemeLike = {
  fg(color: string, value: string): string;
};

function randomIdleEmoteState(idleState: PetState, random = Math.random): PetState {
  const candidates = (["waving", "jumping"] as const).filter((state) => state !== idleState);
  return candidates[Math.floor(random() * candidates.length)] ?? "waving";
}

function petStateAnimationDurationMs(state: PetState): number {
  return PET_ANIMATION_ROWS[state].durations.reduce((sum, duration) => sum + duration, 0);
}

function petFrameInfo(pet: LoadedCodexPet, state: PetState, elapsedMs: number) {
  const frames = pet.states[state] ?? pet.states.idle;
  const frame = animationFrameAt(frames, elapsedMs);
  return { frame, frameIndex: frame ? frames.indexOf(frame) : -1 };
}

function petFrameRows(
  pet: LoadedCodexPet,
  state: PetState,
  elapsedMs: number,
  width: number,
  sizeCells: number,
): number {
  const { frame } = petFrameInfo(pet, state, elapsedMs);
  if (!frame || !getCapabilities().images) return 0;
  const columns = Math.max(1, Math.min(Math.max(1, width - 2), sizeCells));
  return calculateImageRows(
    { widthPx: frame.widthPx, heightPx: frame.heightPx },
    columns,
    getCellDimensions(),
  );
}

function petPlaceholderLines(
  pet: LoadedCodexPet,
  state: PetState,
  elapsedMs: number,
  width: number,
  sizeCells: number,
): string[] {
  return Array.from({ length: petFrameRows(pet, state, elapsedMs, width, sizeCells) }, () => "");
}

function petRenderCacheKey(
  pet: LoadedCodexPet,
  state: PetState,
  frameIndex: number,
  placement: PetPlacement,
  width: number,
  sizeCells: number,
): string {
  const cellDimensions = getCellDimensions();
  const imageProtocol = getCapabilities().images ?? "none";
  return [
    pet.pet.slug,
    state,
    frameIndex,
    placement,
    width,
    sizeCells,
    imageProtocol,
    cellDimensions.widthPx,
    cellDimensions.heightPx,
  ].join(":");
}

export class PetFooterController {
  private pet: LoadedCodexPet | undefined;
  private petError: string | undefined;
  private petLoadKey: string | undefined;
  private petLoadInFlight = false;
  private petLoadingKey: string | undefined;
  private petLoadNotify = false;
  private queuedPetRefresh: { ctx: ExtensionContext; notify: boolean } | undefined;
  private petTimer: ReturnType<typeof setTimeout> | undefined;
  private petRenderRequestTimer: ReturnType<typeof setTimeout> | undefined;
  private petRuntimeState: PetState = "idle";
  private petPreviewState: PetState | undefined;
  private petSettingsPreviewActive = false;
  settingsPets: CodexPetPackage[] = [];
  private petFlashState: PetState | undefined;
  private petFlashUntil: number | undefined;
  private petFlashTimer: ReturnType<typeof setTimeout> | undefined;
  private petIdleEmoteTimer: ReturnType<typeof setTimeout> | undefined;
  private petResizeTimer: ReturnType<typeof setTimeout> | undefined;
  private petResizeFreezeUntil = 0;
  private stdoutResizeHandler: (() => void) | undefined;
  private petAnimationState: PetState | undefined;
  private petAnimationStartedAt = Date.now();
  private readonly petRenderCache = new Map<string, string[]>();
  private readonly activeToolCallIds = new Set<string>();
  private readonly petImageId = 0x70657401;
  private readonly petKittyManager = new CodexPetKittyManager(this.petImageId);
  private requestFooterRender: (() => void) | undefined;
  private requestSettingsRender: (() => void) | undefined;
  private shuttingDown = false;
  private readonly getConfig: (ctx: ExtensionContext) => ResolvedConfig;
  private readonly updateFooter: (ctx: ExtensionContext) => void;
  private readonly getFooterInstalled: () => boolean;

  constructor(
    getConfig: (ctx: ExtensionContext) => ResolvedConfig,
    updateFooter: (ctx: ExtensionContext) => void,
    getFooterInstalled: () => boolean = () => false,
  ) {
    this.getConfig = getConfig;
    this.updateFooter = updateFooter;
    this.getFooterInstalled = getFooterInstalled;
  }

  get loadedPet(): LoadedCodexPet | undefined {
    return this.pet;
  }

  get error(): string | undefined {
    return this.petError;
  }

  get previewState(): PetState | undefined {
    return this.petPreviewState;
  }

  setPreviewState(state: PetState | undefined): void {
    this.petPreviewState = state;
  }

  setFooterRenderRequest(request: (() => void) | undefined): void {
    this.requestFooterRender = request;
  }

  requestFooterRenderNow(): void {
    this.requestFooterRender?.();
  }

  setSettingsRenderRequest(request: (() => void) | undefined): void {
    this.requestSettingsRender = request;
  }

  shouldLoadForConfig(cfg: ResolvedConfig): boolean {
    return cfg.pets.enabled || this.petSettingsPreviewActive;
  }

  shouldRenderInFooter(cfg: ResolvedConfig, footerInstalled = this.getFooterInstalled()): boolean {
    return (
      footerInstalled &&
      cfg.footer.mode === "replace" &&
      (cfg.pets.enabled || this.petSettingsPreviewActive)
    );
  }

  setSettingsPreviewActive(ctx: ExtensionContext, next: boolean): void {
    if (this.petSettingsPreviewActive === next) return;
    this.petSettingsPreviewActive = next;
    if (!this.getConfig(ctx).pets.enabled) this.petLoadKey = undefined;
    void this.refresh(ctx, this.getConfig(ctx)).then(() => {
      if (this.shuttingDown) return;
      if (!this.shouldRenderInFooter(this.getConfig(ctx))) this.flushKittyCleanupNow();
      this.requestSettingsRender?.();
    });
    this.updateFooter(ctx);
  }

  clearFlash(): void {
    if (this.petFlashTimer) clearTimeout(this.petFlashTimer);
    this.petFlashTimer = undefined;
    this.petFlashState = undefined;
    this.petFlashUntil = undefined;
    this.petAnimationState = undefined;
  }

  stopIdleEmotes(): void {
    if (this.petIdleEmoteTimer) clearTimeout(this.petIdleEmoteTimer);
    this.petIdleEmoteTimer = undefined;
  }

  stopAnimation(): void {
    if (this.petTimer) clearTimeout(this.petTimer);
    this.petTimer = undefined;
  }

  stopPendingRenderRequest(): void {
    if (this.petRenderRequestTimer) clearTimeout(this.petRenderRequestTimer);
    this.petRenderRequestTimer = undefined;
  }

  resetRenderCache(): void {
    this.petRenderCache.clear();
  }

  invalidateLoadKey(): void {
    this.petLoadKey = undefined;
  }

  queueKittyCleanup(target = this.pet): void {
    this.petKittyManager.invalidate(target);
  }

  private takeKittyCleanupSequence(): string {
    return this.petKittyManager.takeCleanupSequence();
  }

  withPendingKittyCleanup(lines: string[]): string[] {
    const sequence = this.takeKittyCleanupSequence();
    if (!sequence) return lines;
    if (lines.length === 0) return [sequence];
    return [`${sequence}\x1b[0m${lines[0]}\x1b[0m`, ...lines.slice(1)];
  }

  private writeKittySequence(sequence: string): void {
    if (sequence && process.stdout.isTTY) process.stdout.write(sequence);
  }

  flushKittyCleanupNow(): void {
    this.writeKittySequence(this.takeKittyCleanupSequence());
  }

  disposeKittyNow(target = this.pet): void {
    this.writeKittySequence(this.petKittyManager.dispose(target));
  }

  private rememberRender(key: string, lines: string[]): void {
    this.petRenderCache.set(key, lines);
    while (this.petRenderCache.size > PET_RENDER_CACHE_LIMIT) {
      const firstKey = this.petRenderCache.keys().next().value;
      if (firstKey === undefined) break;
      this.petRenderCache.delete(firstKey);
    }
  }

  private recallRender(key: string): string[] | undefined {
    const lines = this.petRenderCache.get(key);
    if (!lines) return undefined;
    this.petRenderCache.delete(key);
    this.petRenderCache.set(key, lines);
    return lines;
  }

  isResizeFrozen(now = Date.now()): boolean {
    return now < this.petResizeFreezeUntil;
  }

  private clearResizeFreeze(): void {
    if (this.petResizeTimer) clearTimeout(this.petResizeTimer);
    this.petResizeTimer = undefined;
    this.petResizeFreezeUntil = 0;
  }

  freezeForResize(ctx: ExtensionContext, now = Date.now()): void {
    this.petResizeFreezeUntil = now + PET_RESIZE_FREEZE_MS;
    this.queueKittyCleanup();
    this.stopAnimation();
    this.stopIdleEmotes();
    this.stopPendingRenderRequest();
    if (this.petResizeTimer) clearTimeout(this.petResizeTimer);
    this.petResizeTimer = setTimeout(() => {
      this.petResizeTimer = undefined;
      this.petResizeFreezeUntil = 0;
      this.petKittyManager.resetForResize(this.pet);
      this.resetRenderCache();
      this.updateFooter(ctx);
    }, PET_RESIZE_FREEZE_MS);
    this.petResizeTimer.unref?.();
  }

  installResizeGuard(ctx: ExtensionContext): void {
    if (this.stdoutResizeHandler || !process.stdout.isTTY) return;
    this.stdoutResizeHandler = () => this.freezeForResize(ctx);
    process.stdout.on("resize", this.stdoutResizeHandler);
  }

  uninstallResizeGuard(): void {
    if (this.stdoutResizeHandler) process.stdout.off("resize", this.stdoutResizeHandler);
    this.stdoutResizeHandler = undefined;
    this.clearResizeFreeze();
  }

  private currentState(ctx: ExtensionContext, cfg = this.getConfig(ctx)): PetState {
    if (this.petPreviewState) return this.petPreviewState;
    const now = Date.now();
    if (this.petFlashState && this.petFlashUntil !== undefined && now < this.petFlashUntil)
      return this.petFlashState;
    if (this.petFlashState) this.clearFlash();
    return this.petRuntimeState === "idle" ? cfg.pets.state : this.petRuntimeState;
  }

  private currentAnimation(ctx: ExtensionContext, cfg = this.getConfig(ctx)) {
    const state = this.currentState(ctx, cfg);
    const now = Date.now();
    if (state !== this.petAnimationState) {
      this.petAnimationState = state;
      this.petAnimationStartedAt = now;
    }
    return { state, elapsedMs: now - this.petAnimationStartedAt };
  }

  private requestFooterAndSettingsRender(): void {
    if (this.petRenderRequestTimer) return;
    this.petRenderRequestTimer = setTimeout(() => {
      this.petRenderRequestTimer = undefined;
      this.requestFooterRender?.();
      this.requestSettingsRender?.();
    }, 16);
    this.petRenderRequestTimer.unref?.();
  }

  private scheduleAnimation(ctx: ExtensionContext): void {
    if (!this.pet || this.petTimer || this.isResizeFrozen() || !getCapabilities().images) return;
    const { state, elapsedMs } = this.currentAnimation(ctx);
    const frames = this.pet.states[state] ?? this.pet.states.idle;
    this.petTimer = setTimeout(
      () => {
        this.petTimer = undefined;
        if (this.isResizeFrozen()) return;
        this.requestFooterAndSettingsRender();
        this.scheduleAnimation(ctx);
      },
      nextAnimationFrameDelayMs(frames, elapsedMs),
    );
    this.petTimer.unref?.();
  }

  startAnimation(ctx: ExtensionContext): void {
    this.scheduleAnimation(ctx);
    void this.refresh(ctx);
  }

  private shouldRunIdleEmotes(ctx: ExtensionContext, cfg = this.getConfig(ctx)): boolean {
    return (
      this.shouldRenderInFooter(cfg) &&
      cfg.pets.idleEmotes &&
      getCapabilities().images !== null &&
      this.pet !== undefined &&
      this.petRuntimeState === "idle" &&
      this.activeToolCallIds.size === 0 &&
      this.petPreviewState === undefined &&
      !this.petSettingsPreviewActive &&
      this.petFlashState === undefined &&
      !this.isResizeFrozen()
    );
  }

  playFlash(ctx: ExtensionContext, state: PetState, cfg = this.getConfig(ctx)): void {
    if (!cfg.pets.enabled || !getCapabilities().images) return;
    this.clearFlash();
    const durationMs = petStateAnimationDurationMs(state);
    this.petFlashState = state;
    this.petFlashUntil = Date.now() + durationMs;
    this.petFlashTimer = setTimeout(() => {
      this.petFlashTimer = undefined;
      this.petFlashState = undefined;
      this.petFlashUntil = undefined;
      this.petAnimationState = undefined;
      this.updateFooter(ctx);
    }, durationMs);
    this.petFlashTimer.unref?.();
    this.updateFooter(ctx);
  }

  scheduleIdleEmote(ctx: ExtensionContext, cfg = this.getConfig(ctx)): void {
    if (this.petIdleEmoteTimer || !this.shouldRunIdleEmotes(ctx, cfg)) return;
    const delayMs = Math.round(cfg.pets.idleEmoteIntervalMs * (0.75 + Math.random() * 0.75));
    this.petIdleEmoteTimer = setTimeout(() => {
      this.petIdleEmoteTimer = undefined;
      const nextConfig = this.getConfig(ctx);
      if (this.shouldRunIdleEmotes(ctx, nextConfig)) {
        this.playFlash(ctx, randomIdleEmoteState(nextConfig.pets.state), nextConfig);
      }
      this.scheduleIdleEmote(ctx, nextConfig);
    }, delayMs);
    this.petIdleEmoteTimer.unref?.();
  }

  updateActivity(ctx: ExtensionContext, cfg: ResolvedConfig): void {
    const resizeFrozen = this.isResizeFrozen();
    const shouldAnimatePet = this.shouldRenderInFooter(cfg) || this.petSettingsPreviewActive;
    if (!shouldAnimatePet || resizeFrozen) {
      this.stopAnimation();
    } else {
      if (this.currentState(ctx, cfg) !== this.petAnimationState) this.stopAnimation();
      this.startAnimation(ctx);
    }
    if (!resizeFrozen && this.shouldRunIdleEmotes(ctx, cfg)) this.scheduleIdleEmote(ctx, cfg);
    else this.stopIdleEmotes();
  }

  private loadKeyForConfig(cfg: ResolvedConfig): string {
    const cellDimensions = getCellDimensions();
    return [
      cfg.pets.slug || "__first__",
      cfg.pets.sizeCells,
      getCapabilities().images ?? "none",
      cellDimensions.widthPx,
      cellDimensions.heightPx,
    ].join(":");
  }

  async refresh(ctx: ExtensionContext, cfg = this.getConfig(ctx), notify = false): Promise<void> {
    if (this.shuttingDown) return;
    if (!this.shouldLoadForConfig(cfg)) {
      this.queuedPetRefresh = undefined;
      this.queueKittyCleanup();
      this.pet = undefined;
      this.petError = undefined;
      this.petLoadKey = undefined;
      this.resetRenderCache();
      this.clearFlash();
      this.stopIdleEmotes();
      this.stopAnimation();
      return;
    }

    const key = this.loadKeyForConfig(cfg);
    if (this.petLoadKey === key) return;
    if (this.petLoadInFlight) {
      if (this.petLoadingKey === key) this.petLoadNotify ||= notify;
      else this.queuedPetRefresh = { ctx, notify: this.queuedPetRefresh?.notify || notify };
      return;
    }

    this.petLoadInFlight = true;
    this.petLoadingKey = key;
    this.petLoadNotify = notify;
    this.petError = undefined;
    const previousPet = this.pet;

    const shouldApplyLoadResult = (): boolean => {
      if (this.shuttingDown || this.queuedPetRefresh) return false;
      const latestConfig = this.getConfig(ctx);
      return this.shouldLoadForConfig(latestConfig) && this.loadKeyForConfig(latestConfig) === key;
    };

    try {
      const loadedPet = await loadCodexPet(cfg.pets.slug || undefined, undefined, {
        sizeCells: cfg.pets.sizeCells,
      });
      if (!shouldApplyLoadResult()) return;
      if (previousPet) this.queueKittyCleanup(previousPet);
      this.pet = loadedPet;
      const petIssue = this.pet
        ? undefined
        : describeCodexPetSelectionIssue(await listCodexPets(), cfg.pets.slug || undefined);
      this.petAnimationState = undefined;
      this.resetRenderCache();
      this.petLoadKey = key;
      if (!this.pet && petIssue) this.petError = petIssue.short;
      if (this.petLoadNotify) {
        ctx.ui.notify(
          this.pet
            ? this.shouldRenderInFooter(cfg)
              ? `Rendering ${this.pet.pet.name} in the Better OpenAI footer.`
              : `Loaded ${this.pet.pet.name}; select Footer mode replace to render it.`
            : (petIssue?.message ?? "No ready custom Codex pet found."),
          this.pet ? "info" : "warning",
        );
      }
    } catch (error) {
      if (!shouldApplyLoadResult()) return;
      if (previousPet) this.queueKittyCleanup(previousPet);
      this.pet = undefined;
      this.petLoadKey = key;
      this.petError = error instanceof Error ? error.message : String(error);
      if (this.petLoadNotify)
        ctx.ui.notify(`Could not render Codex pet: ${this.petError}`, "warning");
    } finally {
      this.petLoadInFlight = false;
      this.petLoadingKey = undefined;
      this.petLoadNotify = false;
      const queued = this.queuedPetRefresh;
      this.queuedPetRefresh = undefined;
      if (queued && !this.shuttingDown)
        void this.refresh(queued.ctx, this.getConfig(queued.ctx), queued.notify);
      if (!this.shuttingDown) this.updateFooter(ctx);
    }
  }

  agentStart(ctx: ExtensionContext): void {
    this.activeToolCallIds.clear();
    this.clearFlash();
    this.petRuntimeState = this.getConfig(ctx).pets.thinkingState;
  }

  toolStart(ctx: ExtensionContext, toolCallId: string): void {
    this.activeToolCallIds.add(toolCallId);
    this.petRuntimeState = this.getConfig(ctx).pets.toolState;
  }

  toolEnd(ctx: ExtensionContext, toolCallId: string, isError: boolean): void {
    this.activeToolCallIds.delete(toolCallId);
    const cfg = this.getConfig(ctx);
    this.petRuntimeState =
      this.activeToolCallIds.size > 0 ? cfg.pets.toolState : cfg.pets.thinkingState;
    if (isError) this.playFlash(ctx, cfg.pets.failedToolState, cfg);
  }

  agentEnd(): void {
    this.activeToolCallIds.clear();
    this.petRuntimeState = "idle";
  }

  tuck(): void {
    this.queueKittyCleanup();
    this.pet = undefined;
    this.petError = undefined;
    this.resetRenderCache();
    this.clearFlash();
    this.stopIdleEmotes();
    this.stopAnimation();
  }

  renderSettingsPreview(ctx: ExtensionContext, width: number): string[] {
    if (!this.petSettingsPreviewActive || this.shouldRenderInFooter(this.getConfig(ctx))) return [];
    if (!this.pet) {
      return [this.petError ? `Preview unavailable: ${this.petError}` : "Preview: loading pet…"];
    }
    const cfg = this.getConfig(ctx);
    const { state, elapsedMs } = this.currentAnimation(ctx, cfg);
    const plainTheme = { fg: (_color: string, value: string) => value };
    return [
      `Preview: ${this.pet.pet.name}`,
      ...renderCodexPetFrame(this.pet, state, width, plainTheme, {
        sizeCells: cfg.pets.sizeCells,
        imageId: this.petImageId,
        now: elapsedMs,
        durationMultiplier: 1,
        kittyManager: this.petKittyManager,
      }),
    ];
  }

  renderPetLines(
    ctx: ExtensionContext,
    cfg: ResolvedConfig,
    options: {
      shouldRenderPet: boolean;
      freezePetFrame: boolean;
      requestedPetPlacement: PetPlacement;
      petColumnWidth: number;
      petRenderSizeCells: number;
      width: number;
      theme: ThemeLike;
    },
  ): string[] {
    const petLines: string[] = [];
    if (!options.shouldRenderPet) return petLines;
    if (this.pet) {
      const { state: petState, elapsedMs } = this.currentAnimation(ctx, cfg);
      if (options.freezePetFrame) {
        petLines.push(
          ...petPlaceholderLines(
            this.pet,
            petState,
            elapsedMs,
            options.petColumnWidth,
            options.petRenderSizeCells,
          ),
        );
      } else {
        const imageProtocol = getCapabilities().images;
        if (imageProtocol !== null && imageProtocol !== "kitty") {
          const { frameIndex } = petFrameInfo(this.pet, petState, elapsedMs);
          const cacheKey = petRenderCacheKey(
            this.pet,
            petState,
            frameIndex,
            options.requestedPetPlacement,
            options.petColumnWidth,
            options.petRenderSizeCells,
          );
          const cachedPetLines = this.recallRender(cacheKey);
          if (cachedPetLines) {
            petLines.push(...cachedPetLines);
            return petLines;
          }
          const renderedPetLines = renderCodexPetFrame(
            this.pet,
            petState,
            options.petColumnWidth,
            options.theme,
            {
              sizeCells: options.petRenderSizeCells,
              imageId: this.petImageId,
              now: elapsedMs,
              durationMultiplier: 1,
              kittyManager: this.petKittyManager,
            },
          );
          petLines.push(...renderedPetLines);
          if (renderedPetLines.length > 0) this.rememberRender(cacheKey, renderedPetLines);
        } else {
          petLines.push(
            ...renderCodexPetFrame(this.pet, petState, options.petColumnWidth, options.theme, {
              sizeCells: options.petRenderSizeCells,
              imageId: this.petImageId,
              now: elapsedMs,
              durationMultiplier: 1,
              kittyManager: this.petKittyManager,
            }),
          );
        }
      }
    } else if (this.petError) {
      petLines.push(
        truncateToWidth(options.theme.fg("warning", `pet: ${this.petError}`), options.width, "..."),
      );
    }
    return petLines;
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.queuedPetRefresh = undefined;
    this.petLoadingKey = undefined;
    this.petLoadNotify = false;
    this.activeToolCallIds.clear();
    this.uninstallResizeGuard();
    this.disposeKittyNow();
    this.resetRenderCache();
    this.clearFlash();
    this.stopIdleEmotes();
    this.stopAnimation();
    this.stopPendingRenderRequest();
    this.requestFooterRender = undefined;
    this.requestSettingsRender = undefined;
  }
}
