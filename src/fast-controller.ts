import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig, ServiceTier, SupportedModel } from "./config.ts";
import { isRecord } from "./config.ts";

export const ULTRAFAST_NOTICE =
  "Ultrafast uses 6x Standard token prices for API GPT-6 Astra (global/US) and GPT-6.1 Sol (global/US/EU). Host cost estimates may exclude tier premiums.";

export function currentModelKey(ctx: ExtensionContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

export function supportsFast(ctx: ExtensionContext, supportedModels: SupportedModel[]): boolean {
  const current = ctx.model;
  if (!current) return false;
  return supportedModels.some(
    (model) => model.provider === current.provider && model.id === current.id,
  );
}

export function supportsUltrafast(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (
    model?.provider !== "openai" ||
    !["gpt-6-astra", "gpt-6.1-sol"].includes(model.id) ||
    model.api !== "openai-responses"
  )
    return false;
  try {
    const url = new URL(model.baseUrl);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (["api.openai.com", "us.api.openai.com"].includes(url.hostname) ||
        (model.id === "gpt-6.1-sol" && url.hostname === "eu.api.openai.com")) &&
      /^\/v1\/?$/.test(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function supportsServiceTier(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  tier: ServiceTier,
): boolean {
  if (tier === "ultrafast") return supportsUltrafast(ctx);
  if (tier === "fast") return supportsFast(ctx, cfg.supportedModels);
  return ctx.model?.provider === "openai" || ctx.model?.provider === "openai-codex";
}

export function modelList(supportedModels: SupportedModel[]): string {
  return supportedModels.length > 0
    ? supportedModels.map((model) => `${model.provider}/${model.id}`).join(", ")
    : "none configured";
}

export function fastStateText(
  ctx: ExtensionContext,
  desiredActive: boolean,
  active: boolean,
  supportedModels: SupportedModel[],
): string {
  const model = currentModelKey(ctx);
  if (active) return `Fast mode is on for ${model}.`;
  if (desiredActive) {
    return `Fast mode is requested, but inactive for unsupported model ${model}. Supported models: ${modelList(supportedModels)}.`;
  }
  return `Fast mode is off. Current model: ${model}.`;
}

export class FastController {
  desiredTier: ServiceTier = "standard";
  active = false;
  private explicitSelection = false;
  private lastInjectedAt: number | undefined;
  private lastInjectedModel: string | undefined;
  private lastInjectedTier: string | undefined;

  private readonly fastServiceTier: string;

  constructor(fastServiceTier = "priority") {
    this.fastServiceTier = fastServiceTier;
  }

  get desiredActive(): boolean {
    return this.desiredTier !== "standard";
  }

  applyDesiredState(ctx: ExtensionContext, cfg: ResolvedConfig): void {
    this.active = this.desiredActive && supportsServiceTier(ctx, cfg, this.desiredTier);
  }

  initializeForSession(ctx: ExtensionContext, cfg: ResolvedConfig): void {
    this.desiredTier = cfg.persistState
      ? (cfg.serviceTier ?? (cfg.desiredActive ? "fast" : "standard"))
      : "standard";
    this.explicitSelection = cfg.persistState && cfg.serviceTier !== undefined;
    this.applyDesiredState(ctx, cfg);
  }

  setDesired(ctx: ExtensionContext, cfg: ResolvedConfig, next: boolean): void {
    this.setTier(ctx, cfg, next ? "fast" : "standard");
  }

  setTier(ctx: ExtensionContext, cfg: ResolvedConfig, tier: ServiceTier): void {
    this.desiredTier = tier;
    this.explicitSelection = true;
    this.applyDesiredState(ctx, cfg);
  }

  stateText(ctx: ExtensionContext, cfg: ResolvedConfig): string {
    if (this.desiredTier === "ultrafast") {
      return this.active
        ? `Ultrafast requested for ${currentModelKey(ctx)}. ${
            this.isSubscription(ctx) ? "Subscription OAuth." : ULTRAFAST_NOTICE
          }`
        : this.unsupportedRequestMessage(ctx, cfg);
    }
    return fastStateText(ctx, this.desiredActive, this.active, cfg.supportedModels);
  }

  private isSubscription(ctx: ExtensionContext): boolean {
    return !!ctx.model && ctx.modelRegistry.isUsingOAuth(ctx.model);
  }

  selectionNoticeLevel(ctx: ExtensionContext): "warning" | "info" {
    return (this.desiredActive && !this.active) ||
      (this.desiredTier === "ultrafast" && !this.isSubscription(ctx))
      ? "warning"
      : "info";
  }

  unsupportedRequestMessage(ctx: ExtensionContext, cfg: ResolvedConfig): string {
    if (this.desiredTier === "ultrafast") {
      return `Ultrafast requested, but inactive for ${currentModelKey(ctx)}. ${ULTRAFAST_NOTICE} No lower-tier fallback will be injected.`;
    }
    return `Fast mode requested, but ${currentModelKey(ctx)} is unsupported. It will activate automatically when you switch to a supported model: ${modelList(cfg.supportedModels)}.`;
  }

  inactiveForModelMessage(ctx: ExtensionContext): string {
    const name = this.desiredTier === "ultrafast" ? "Ultrafast" : "Fast";
    return `${name} mode inactive for unsupported model ${currentModelKey(ctx)}.`;
  }

  settingsSummary(ctx: ExtensionContext, cfg: ResolvedConfig): string {
    return (
      this.desiredTier +
      (this.desiredActive && !supportsServiceTier(ctx, cfg, this.desiredTier) ? " (inactive)" : "")
    );
  }

  statusSegment(ctx: ExtensionContext, cfg: ResolvedConfig): string | undefined {
    return this.active && supportsServiceTier(ctx, cfg, this.desiredTier)
      ? `${ctx.model?.id ?? "model"} ${this.desiredTier}`
      : undefined;
  }

  injectProviderPayload(
    event: { payload?: unknown },
    ctx: ExtensionContext,
    cfg: ResolvedConfig,
  ): unknown {
    if (!isRecord(event.payload) || !supportsServiceTier(ctx, cfg, this.desiredTier))
      return undefined;
    if (typeof event.payload.model === "string" && event.payload.model !== ctx.model?.id)
      return undefined;
    if (this.desiredTier === "standard" && !this.explicitSelection) return undefined;
    const tier =
      this.desiredTier === "standard"
        ? "default"
        : this.desiredTier === "fast"
          ? this.fastServiceTier
          : "ultrafast";
    this.lastInjectedAt = Date.now();
    this.lastInjectedModel = currentModelKey(ctx);
    this.lastInjectedTier = tier;
    return { ...event.payload, service_tier: tier };
  }

  debugLines(ctx: ExtensionContext, cfg: ResolvedConfig): string[] {
    return [
      `Requested service tier: ${this.desiredTier}`,
      `Effective override: ${supportsServiceTier(ctx, cfg, this.desiredTier) ? (this.desiredTier === "standard" && !this.explicitSelection ? "none (provider default)" : this.desiredTier) : "inactive (unsupported)"}`,
      `Current model: ${currentModelKey(ctx)}`,
      `Fast supported: ${supportsFast(ctx, cfg.supportedModels)}`,
      `Ultrafast supported: ${supportsUltrafast(ctx)}`,
      `Last injected: ${this.lastInjectedAt ? `${new Date(this.lastInjectedAt).toLocaleTimeString()} (${this.lastInjectedModel}, ${this.lastInjectedTier})` : "never"}`,
      "Injection records requests, not server-confirmed service tiers or billing.",
      this.isSubscription(ctx)
        ? "Subscription OAuth; reported service tier may remain default."
        : ULTRAFAST_NOTICE,
    ];
  }
}
