import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { _test } from "../index.ts";
import { maskIdentifier, sanitizeDiagnosticError } from "../src/format.ts";
import { MULTIPROVIDER_SERVICE_EVENT, type MultiproviderService } from "../src/multiprovider.ts";
import { UsageController } from "../src/usage-controller.ts";
import { severityForLeftPercent, usageSegments } from "../src/usage.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;

type UsageHarness = {
  ctx: ExtensionContext;
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, { handler: CommandHandler }>;
  /** Delivers a pi-multiprovider service announcement to the extension. */
  publishService(value: unknown): void;
};

const tempDirs: string[] = [];
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeCodexAuth(agentDir: string, expires?: number): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "auth.json"),
    `${JSON.stringify(
      {
        "openai-codex": {
          type: "oauth",
          access: "usage-access",
          accountId: "acct_usage",
          ...(expires === undefined ? {} : { expires }),
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeProjectConfig(cwd: string, config: Record<string, unknown>): void {
  const configDir = join(cwd, ".pi", "extensions");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "pi-better-openai.json"),
    `${JSON.stringify(
      {
        persistState: false,
        active: false,
        desiredActive: false,
        supportedModels: [],
        usage: { enabled: true, refreshIntervalMs: 60000 },
        footer: { mode: "status" },
        image: { enabled: false },
        pets: { enabled: false },
        ...config,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function usageResponseBody() {
  return {
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 10, reset_after_seconds: 60 },
      secondary_window: { used_percent: 20, reset_after_seconds: 3600 },
    },
  };
}

function usageJsonResponse(): Response {
  return new Response(JSON.stringify(usageResponseBody()));
}

function stubUsageFetch(response: Response | (() => Response)): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(typeof response === "function" ? response() : response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function importUsageWithAgentDir(agentDir: string) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  return import("../src/usage.ts");
}

async function createUsageHarness(options: {
  usageConfig?: Record<string, unknown>;
  model?: ExtensionContext["model"];
  isUsingOAuth?: boolean;
  writeAuth?: boolean;
  signal?: AbortSignal;
}): Promise<UsageHarness> {
  const cwd = createTempDir("pi-better-openai-usage-project-");
  const agentDir = createTempDir("pi-better-openai-usage-agent-");
  if (options.writeAuth !== false) writeCodexAuth(agentDir);
  writeProjectConfig(cwd, {
    usage: options.usageConfig ?? { enabled: true, refreshIntervalMs: 60000 },
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  const { default: betterOpenAI } = await import("../index.ts");

  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, { handler: CommandHandler }>();
  const serviceListeners = new Set<(value: unknown) => void>();
  const pi = {
    on(event: string, handler: EventHandler) {
      const currentHandlers = handlers.get(event) ?? [];
      currentHandlers.push(handler);
      handlers.set(event, currentHandlers);
    },
    registerFlag: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn((name: string, command: { handler: CommandHandler }) => {
      commands.set(name, command);
    }),
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerShortcut: vi.fn(),
    sendMessage: vi.fn(),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "off"),
    events: {
      on(event: string, listener: (value: unknown) => void) {
        if (event === MULTIPROVIDER_SERVICE_EVENT) serviceListeners.add(listener);
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    signal: options.signal,
    model: options.model ?? { provider: "openai", id: "gpt-5.5" },
    ui: {
      notify: vi.fn(),
      setFooter: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      theme: { fg: vi.fn((_color: string, value: string) => value) },
    },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getCwd: vi.fn(() => cwd),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => options.isUsingOAuth ?? true),
      getApiKeyForProvider: vi.fn(() => Promise.resolve(undefined)),
    },
    getContextUsage: vi.fn(() => ({ contextWindow: 0, percent: 0 })),
  } as unknown as ExtensionContext;

  betterOpenAI(pi);
  return {
    ctx,
    handlers,
    commands,
    publishService(value: unknown) {
      for (const listener of serviceListeners) listener(value);
    },
  };
}

async function emit(harness: UsageHarness, event: string, payload: unknown = {}): Promise<void> {
  const handlers = harness.handlers.get(event) ?? [];
  for (const handler of handlers) {
    await handler(payload, harness.ctx);
  }
}

async function settleAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
  if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("usage helpers", () => {
  test("masks and sanitizes diagnostic identifiers", () => {
    expect(maskIdentifier("acct_1234567890abcdef")).toBe("acct...cdef");

    const sanitized = sanitizeDiagnosticError(
      `\u001b[31mAuthorization: Bearer sk-secretsecret accountId=acct_1234567890abcdef ${"x".repeat(700)}`,
    );

    expect(sanitized).not.toContain("\u001b");
    expect(sanitized).not.toContain("sk-secretsecret");
    expect(sanitized).not.toContain("acct_1234567890abcdef");
    expect(sanitized.length).toBeLessThanOrEqual(500);
  });

  test("formats percentages", () => {
    expect(_test.formatPercent(99.4)).toBe("99%");
    expect(_test.formatPercent(null)).toBe("--");
  });

  test("parses and formats usage snapshots", () => {
    const usage = _test.parseUsageSnapshot(
      {
        rate_limit: {
          allowed: true,
          primary_window: { used_percent: 1, reset_after_seconds: 60 },
          secondary_window: { used_percent: 49, reset_after_seconds: 3600 },
        },
      },
      "gpt-5.5",
    );
    expect(usage.fiveHourLeftPercent).toBe(99);
    expect(usage.sevenDayLeftPercent).toBe(51);
    expect(usage.isLimited).toBe(false);
    expect(_test.formatUsageSnapshot(usage, { showResetTimes: false })).toMatch(
      /^Usage: 5h: 99% · 7d: 51%$/,
    );
  });

  test("formats a weekly-only primary window as 7d usage", () => {
    const capturedAt = new Date("2026-07-09T12:00:00Z").getTime();
    const usage = _test.parseUsageSnapshot(
      {
        rate_limit: {
          primary_window: {
            used_percent: 58,
            limit_window_seconds: 7 * 86_400,
            reset_after_seconds: 2 * 86_400 + 6 * 3_600,
          },
        },
      },
      "gpt-5.5",
      capturedAt,
    );

    expect(usage.fiveHourLeftPercent).toBeNull();
    expect(usage.sevenDayLeftPercent).toBe(42);
    expect(_test.formatUsageSnapshot(usage, { showResetTimes: true }, capturedAt)).toMatch(
      /^Usage: 7d: 42% · ↺ 2d6h - /,
    );
  });

  test("infers a weekly-only primary window from a reset beyond five hours", () => {
    const usage = _test.parseUsageSnapshot(
      {
        rate_limit: {
          primary_window: { used_percent: 58, reset_after_seconds: 2 * 86_400 },
        },
      },
      "gpt-5.5",
    );

    expect(_test.formatUsageSnapshot(usage, { showResetTimes: false })).toBe("Usage: 7d: 42%");
  });

  test("renders a primary five-hour window without an unavailable weekly placeholder", () => {
    const usage = _test.parseUsageSnapshot(
      { rate_limit: { primary_window: { used_percent: 10, reset_after_seconds: 3_600 } } },
      "gpt-5.5",
    );

    expect(_test.formatUsageSnapshot(usage, { showResetTimes: false })).toBe("Usage: 5h: 90%");
  });

  test("decrements reset countdowns without moving the reset clock", () => {
    const capturedAt = new Date("2026-07-09T12:00:00Z").getTime();
    const usage = _test.parseUsageSnapshot(
      {
        rate_limit: {
          primary_window: { used_percent: 10, reset_after_seconds: 3600 },
        },
      },
      "gpt-5.5",
      capturedAt,
    );

    const initial = _test.formatUsageSnapshot(usage, { showResetTimes: true }, capturedAt);
    const later = _test.formatUsageSnapshot(
      usage,
      { showResetTimes: true },
      capturedAt + 30 * 60_000,
    );
    const expired = _test.formatUsageSnapshot(
      usage,
      { showResetTimes: true },
      capturedAt + 90 * 60_000,
    );

    expect(initial).toContain("↺ 1h0m");
    expect(later).toContain("↺ 30m");
    expect(initial.split(" - ")[1]).toBe(later.split(" - ")[1]);
    expect(expired).toContain("↺ 0s");
    expect(initial.split(" - ")[1]).toBe(expired.split(" - ")[1]);
  });

  test("refreshes cached reset-clock formatters when the time zone changes", () => {
    const previousTimeZone = process.env.TZ;
    const capturedAt = new Date("2026-01-15T12:00:00Z").getTime();
    const usage = _test.parseUsageSnapshot(
      {
        rate_limit: {
          primary_window: { used_percent: 10, reset_after_seconds: 3600 },
        },
      },
      "gpt-5.5",
      capturedAt,
    );

    try {
      process.env.TZ = "UTC";
      const utc = _test.formatUsageSnapshot(usage, { showResetTimes: true }, capturedAt);
      process.env.TZ = "America/Los_Angeles";
      const losAngeles = _test.formatUsageSnapshot(usage, { showResetTimes: true }, capturedAt);
      const expectedLosAngelesTime = new Date(capturedAt + 3600_000).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });

      expect(losAngeles).toContain(expectedLosAngelesTime);
      expect(losAngeles).not.toBe(utc);
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimeZone;
    }
  });

  test("falls back to the base rate limit when Spark-specific usage is absent", () => {
    const usage = _test.parseUsageSnapshot(usageResponseBody(), "gpt-5.3-codex-spark");

    expect(usage.scope).toBe("spark");
    expect(usage.fiveHourLeftPercent).toBe(90);
    expect(usage.sevenDayLeftPercent).toBe(80);
  });
});

describe("usage display customization", () => {
  const capturedAt = new Date("2026-07-09T12:00:00Z").getTime();
  const usage = _test.parseUsageSnapshot(
    {
      rate_limit: {
        primary_window: { used_percent: 100, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 30, reset_after_seconds: 5 * 86400 + 12 * 3600 },
      },
      rate_limit_reset_credits: { available_count: 2 },
    },
    "gpt-5.5",
    capturedAt,
  );
  const options = {
    style: "compact",
    windows: "weekly",
    resetFormat: "countdown",
    showResetTimes: true,
    showBankedResets: false,
  } as const;

  test("renders the exact compact weekly countdown and adjusts elapsed time", () => {
    expect(_test.formatUsageSnapshot(usage, options, capturedAt)).toBe("W:70% 5d12h");
    expect(_test.formatUsageSnapshot(usage, options, capturedAt + 3600000)).toBe("W:70% 5d11h");
    expect(
      _test.formatUsageSnapshot(usage, { ...options, showResetTimes: false }, capturedAt),
    ).toBe("W:70%");
    expect(
      _test.formatUsageSnapshot(usage, { ...options, showBankedResets: true }, capturedAt),
    ).toBe("W:70% 5d12h · 2 banked resets");
  });

  test("keeps zero quota distinct from missing windows and preserves severity", () => {
    const fiveHour = { ...options, windows: "five-hour" } as const;
    expect(usageSegments(usage, fiveHour, capturedAt)).toEqual([
      { text: "5h:", severity: "muted" },
      { text: "0%", severity: "critical" },
      { text: " 1h0m", severity: "muted" },
    ]);
    const missing = { ...usage, fiveHourLeftPercent: null, fiveHourResetInSeconds: null };
    expect(_test.formatUsageSnapshot(missing, fiveHour, capturedAt)).toBe("5h:--");
    expect(_test.formatUsageSnapshot(missing, { ...options, windows: "all" }, capturedAt)).toBe(
      "W:70% 5d12h",
    );
    expect(_test.formatUsageSnapshot(usage, { ...options, windows: "all" }, capturedAt)).toBe(
      "5h:0% 1h0m · W:70% 5d12h",
    );
  });

  test("supports clock-only and both reset formats in either style", () => {
    for (const style of ["compact", "detailed"] as const) {
      const clock = _test.formatUsageSnapshot(
        usage,
        { ...options, style, resetFormat: "clock" },
        capturedAt,
      );
      const both = _test.formatUsageSnapshot(
        usage,
        { ...options, style, resetFormat: "both" },
        capturedAt,
      );
      expect(clock).not.toContain("5d12h");
      expect(both).toContain(`5d12h - ${clock.split(style === "compact" ? "W:70% " : " · ↺ ")[1]}`);
    }
    expect(_test.formatUsageSnapshot(usage, { ...options, style: "detailed" }, capturedAt)).toBe(
      "Usage: 7d: 70% · ↺ 5d12h",
    );
  });

  test("command status remains detailed with all windows despite display configuration", () => {
    const cwd = createTempDir("pi-better-openai-usage-config-");
    process.env.PI_CODING_AGENT_DIR = cwd;
    const cfg = _test.resolveConfig(cwd);
    cfg.usage = { ...cfg.usage, ...options };
    const controller = new UsageController(
      () => cfg,
      () => {},
    );
    Object.assign(controller, { usageSnapshot: usage });
    const ctx = {
      model: { provider: "openai-codex", id: "gpt-5.5" },
      modelRegistry: { isUsingOAuth: () => true },
    } as unknown as ExtensionContext;
    vi.spyOn(Date, "now").mockReturnValue(capturedAt);
    expect(controller.statusLine(ctx)).toBe("W:70% 5d12h");
    expect(controller.formatStatus(ctx)).toMatch(/^Usage: 5h: 0% · 7d: 70% · 5h ↺ 1h0m - /);
    expect(controller.formatStatus(ctx)).not.toContain("banked");
    cfg.usage.showResetTimes = false;
    expect(controller.formatStatus(ctx)).toBe("Usage: 5h: 0% · 7d: 70%");
  });
});

describe("usage line colours", () => {
  test("tags each percentage with the severity of the budget left", () => {
    const usage = _test.parseUsageSnapshot(
      {
        rate_limit: {
          primary_window: { used_percent: 10, reset_after_seconds: 3600 },
          secondary_window: { used_percent: 85, reset_after_seconds: 72 * 3600 },
        },
      },
      "gpt-5.5",
    );

    const segments = usageSegments(usage, { showResetTimes: false });

    expect(segments).toEqual([
      { text: "Usage: ", severity: "muted" },
      { text: "5h: ", severity: "muted" },
      { text: "90%", severity: "ok" },
      { text: " · ", severity: "muted" },
      { text: "7d: ", severity: "muted" },
      { text: "15%", severity: "warning" },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(
      _test.formatUsageSnapshot(usage, { showResetTimes: false }),
    );
  });

  test("keeps labels and countdowns dim while the budget drains", () => {
    const capturedAt = new Date("2026-07-09T12:00:00Z").getTime();
    const usage = _test.parseUsageSnapshot(
      {
        rate_limit: {
          primary_window: { used_percent: 95, reset_after_seconds: 3600 },
        },
      },
      "gpt-5.5",
      capturedAt,
    );

    const segments = usageSegments(usage, { showResetTimes: true }, capturedAt);

    expect(segments.filter((segment) => segment.severity !== "muted")).toEqual([
      { text: "5%", severity: "critical" },
    ]);
    expect(segments.some((segment) => segment.text.startsWith(" · ↺ "))).toBe(true);
  });

  test("escalates severity as the remaining budget drains", () => {
    expect(severityForLeftPercent(null)).toBe("muted");
    expect(severityForLeftPercent(31)).toBe("ok");
    expect(severityForLeftPercent(30)).toBe("warning");
    expect(severityForLeftPercent(10)).toBe("critical");
    expect(severityForLeftPercent(0)).toBe("critical");
  });
});

describe("requestCodexUsage", () => {
  test("reads isolated auth and sends usage fetch headers", async () => {
    const agentDir = createTempDir("pi-better-openai-usage-agent-");
    writeCodexAuth(agentDir);
    const fetchMock = stubUsageFetch(usageJsonResponse());
    const usage = await importUsageWithAgentDir(agentDir);

    const response = await usage.requestCodexUsage();

    expect(response).toEqual(usageResponseBody());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(usage.USAGE_URL);
    expect(init.headers).toMatchObject({
      authorization: "Bearer usage-access",
      "chatgpt-account-id": "acct_usage",
    });
  });

  test("uses refreshed model-registry credentials before auth-file fallback", async () => {
    const agentDir = createTempDir("pi-better-openai-usage-agent-");
    const fetchMock = stubUsageFetch(usageJsonResponse());
    const usage = await importUsageWithAgentDir(agentDir);
    const ctx = {
      modelRegistry: {
        getApiKeyForProvider: vi.fn(() =>
          Promise.resolve(
            JSON.stringify({ access: "registry-access", accountId: "acct_registry" }),
          ),
        ),
      },
    } as unknown as ExtensionContext;

    const response = await usage.requestCodexUsage(ctx);

    expect(response).toEqual(usageResponseBody());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(ctx.modelRegistry.getApiKeyForProvider).toHaveBeenCalledWith("openai-codex");
    expect(init.headers).toMatchObject({
      authorization: "Bearer registry-access",
      "chatgpt-account-id": "acct_registry",
    });
  });

  test("never substitutes OpenAI direct OAuth for Codex backend auth", async () => {
    const agentDir = createTempDir("pi-better-openai-usage-agent-");
    const access = codexJwt("acct_openai_only");
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access,
          accountId: "acct_openai_only",
          expires: Date.now() + 3600000,
        },
      }),
    );
    const fetchMock = stubUsageFetch(usageJsonResponse);
    const usage = await importUsageWithAgentDir(agentDir);
    const getApiKeyForProvider = vi.fn(async (provider: string) =>
      provider === "openai" ? access : undefined,
    );
    const ctx = {
      model: { provider: "openai", id: "gpt-5.5" },
      modelRegistry: { getApiKeyForProvider },
    } as unknown as ExtensionContext;

    await expect(usage.requestCodexUsage(ctx)).resolves.toBeUndefined();
    expect(getApiKeyForProvider).toHaveBeenCalledExactlyOnceWith("openai-codex");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns undefined without fetch when isolated auth is missing", async () => {
    const agentDir = createTempDir("pi-better-openai-usage-agent-");
    const fetchMock = stubUsageFetch(usageJsonResponse());
    const usage = await importUsageWithAgentDir(agentDir);

    await expect(usage.requestCodexUsage()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("does not reuse a known-expired auth-file token after registry refresh fails", async () => {
    const agentDir = createTempDir("pi-better-openai-usage-agent-");
    writeCodexAuth(agentDir, Date.now() - 1);
    const fetchMock = stubUsageFetch(usageJsonResponse());
    const usage = await importUsageWithAgentDir(agentDir);
    const ctx = {
      modelRegistry: { getApiKeyForProvider: vi.fn(() => Promise.resolve(undefined)) },
    } as unknown as ExtensionContext;

    await expect(usage.requestCodexUsage(ctx)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("allows an abort signal to release a hung registry credential lookup", async () => {
    const agentDir = createTempDir("pi-better-openai-usage-agent-");
    const usage = await importUsageWithAgentDir(agentDir);
    const controller = new AbortController();
    const ctx = {
      modelRegistry: {
        getApiKeyForProvider: vi.fn(() => new Promise<string | undefined>(() => undefined)),
      },
    } as unknown as ExtensionContext;

    const request = usage.requestCodexUsage(ctx, controller.signal);
    controller.abort(new Error("credential lookup aborted"));

    await expect(request).rejects.toThrow("credential lookup aborted");
  });

  test("does not start a credential lookup for an already-aborted request", async () => {
    const agentDir = createTempDir("pi-better-openai-usage-agent-");
    const usage = await importUsageWithAgentDir(agentDir);
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));
    const getApiKeyForProvider = vi.fn(() => Promise.resolve(undefined));
    const ctx = { modelRegistry: { getApiKeyForProvider } } as unknown as ExtensionContext;

    await expect(usage.requestCodexUsage(ctx, controller.signal)).rejects.toThrow(
      "already aborted",
    );
    expect(getApiKeyForProvider).not.toHaveBeenCalled();
  });
});

describe("usage polling lifecycle", () => {
  test("does not fetch usage when usage display is disabled", async () => {
    const fetchMock = stubUsageFetch(usageJsonResponse());
    const harness = await createUsageHarness({ usageConfig: { enabled: false } });

    await emit(harness, "session_start");
    await settleAsyncWork();
    await emit(harness, "session_shutdown");

    // Default-on reset automation is independent of the usage display.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    ]);
  });

  test("does not fetch usage for non-OAuth subscription-gated models", async () => {
    const fetchMock = stubUsageFetch(usageJsonResponse());
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 60000,
        showOnlyOnSubscriptionModels: true,
      },
      isUsingOAuth: false,
    });

    await emit(harness, "session_start");
    await settleAsyncWork();
    await emit(harness, "session_shutdown");

    // Codex reset automation can use its own auth regardless of the model.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    ]);
  });

  test.each(["openai", "openai-codex"])(
    "labels the Codex quota source for %s models",
    async (provider) => {
      const fetchMock = stubUsageFetch(usageJsonResponse);
      const harness = await createUsageHarness({
        usageConfig: {
          enabled: true,
          refreshIntervalMs: 60000,
          showOnlyOnSubscriptionModels: true,
          showResetTimes: false,
        },
        model: { provider, id: "gpt-5.5" } as ExtensionContext["model"],
        isUsingOAuth: true,
      });

      await emit(harness, "session_start");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(harness.ctx.ui.setStatus).toHaveBeenCalled());
      expect(statusLine(harness)).toContain("Usage:");
      expect(statusLine(harness)).toContain("5h: 90%");
      expect(harness.ctx.ui.theme.fg).toHaveBeenCalledWith("success", "90%");
      expect(harness.ctx.ui.theme.fg).toHaveBeenCalledWith("dim", "Usage: ");
      if (provider === "openai") expect(statusLine(harness)).toContain("Codex Usage:");
      else expect(statusLine(harness)).not.toContain("Codex Usage:");
      await harness.commands.get("openai-usage")!.handler("", harness.ctx);
      if (provider === "openai") {
        expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
          expect.stringContaining("not verified against the active OpenAI login"),
          "info",
        );
      }
      await emit(harness, "session_shutdown");
    },
  );

  test("stops interval polling when the session signal aborts", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const fetchMock = stubUsageFetch(usageJsonResponse);
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 15000,
        showOnlyOnSubscriptionModels: true,
      },
      isUsingOAuth: true,
      signal: abortController.signal,
    });

    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    abortController.abort();
    Object.defineProperty(harness.ctx, "model", {
      get() {
        throw new Error("stale ctx model access");
      },
    });
    fetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(60000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("stops interval polling when pi marks the captured ctx stale", async () => {
    vi.useFakeTimers();
    const fetchMock = stubUsageFetch(usageJsonResponse);
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 15000,
        showOnlyOnSubscriptionModels: true,
      },
      isUsingOAuth: true,
    });

    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    Object.defineProperty(harness.ctx, "model", {
      get() {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    });
    fetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(60000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("throttles repeated turn-end refreshes within the configured interval", async () => {
    const fetchMock = stubUsageFetch(usageJsonResponse);
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 60000,
        showOnlyOnSubscriptionModels: true,
      },
      isUsingOAuth: true,
    });

    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await emit(harness, "turn_end");
    await emit(harness, "turn_end");
    await settleAsyncWork();
    await emit(harness, "session_shutdown");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("forces refreshes for model selection and manual usage status", async () => {
    const fetchMock = stubUsageFetch(usageJsonResponse);
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 60000,
        showOnlyOnSubscriptionModels: true,
      },
      isUsingOAuth: true,
    });

    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    harness.ctx.model = { provider: "openai", id: "gpt-5.5" } as ExtensionContext["model"];
    await emit(harness, "model_select", { model: harness.ctx.model });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await harness.commands.get("openai-usage")?.handler("", harness.ctx);
    await emit(harness, "session_shutdown");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "info");
  });

  test("surfaces usage fetch errors through /openai-usage", async () => {
    const fetchMock = stubUsageFetch(new Response("nope", { status: 500 }));
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 60000,
        showOnlyOnSubscriptionModels: true,
      },
      isUsingOAuth: true,
    });

    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await emit(harness, "turn_end");
    await emit(harness, "turn_end");
    await settleAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await harness.commands.get("openai-usage")?.handler("", harness.ctx);
    await emit(harness, "session_shutdown");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Codex usage request failed (500)"),
      "warning",
    );
  });

  test("hides a successful snapshot and reports a later refresh failure", async () => {
    let usageCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("rate-limit-reset-credits")) {
        return new Response(JSON.stringify({ credits: [], available_count: 0 }));
      }
      usageCalls += 1;
      return usageCalls === 1 ? usageJsonResponse() : new Response("nope", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 60000,
        showOnlyOnSubscriptionModels: true,
        showResetTimes: false,
      },
      isUsingOAuth: true,
    });

    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await harness.commands.get("openai-usage")?.handler("", harness.ctx);
    await emit(harness, "session_shutdown");

    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Codex usage request failed (500)"),
      "warning",
    );
    expect(harness.ctx.ui.notify).not.toHaveBeenLastCalledWith(
      expect.stringContaining("5h: 90%"),
      expect.anything(),
    );
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(expect.any(String), undefined);
  });
});

function codexJwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.sig`;
}

function fakeMultiproviderService() {
  type ChangedEvent = { providerId: string; account: unknown; ctx: ExtensionContext };
  type Auth = { accessToken: string; label: string; source?: string } | undefined;
  const listeners = new Set<(event: ChangedEvent) => void>();
  let resolveAuth: () => Promise<Auth> = async () => undefined;
  const resolveActiveAccountAuth = vi.fn(async () => resolveAuth());
  const value = {
    getActiveAccount: vi.fn(async () => undefined),
    resolveActiveAccountAuth,
    onActiveAccountChanged: vi.fn(
      (_providerId: string, listener: (event: ChangedEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    ),
  } as unknown as MultiproviderService;
  return {
    value,
    resolveActiveAccountAuth,
    resolve(next: () => Promise<Auth>) {
      resolveAuth = next;
    },
    notifyAccountChanged(event: ChangedEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

/** Returns the most recently published public status line. */
function statusLine(harness: UsageHarness): string {
  return vi.mocked(harness.ctx.ui.setStatus).mock.calls.at(-1)?.[1] ?? "";
}

describe("multiprovider resume", () => {
  test("repaints usage with the account a resumed session restores", async () => {
    // Usage is account-scoped: the upstream credential and the pooled account
    // report different numbers, so the widget line identifies who was charged.
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const accountId = String(headers["chatgpt-account-id"] ?? "");
      const usedPercent = accountId === "acct_pinned" ? 70 : 10;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            rate_limit: {
              allowed: true,
              primary_window: { used_percent: usedPercent, reset_after_seconds: 60 },
              secondary_window: { used_percent: usedPercent, reset_after_seconds: 3600 },
            },
          }),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 60000,
        showOnlyOnSubscriptionModels: true,
        showResetTimes: false,
      },
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
      } as unknown as ExtensionContext["model"],
      isUsingOAuth: true,
    });
    await settleAsyncWork();

    const service = fakeMultiproviderService();
    harness.publishService(service.value);

    // Resuming runs this extension's session_start before pi-multiprovider has
    // replayed the session's switch journal, so the first paint shows the
    // upstream account.
    await emit(harness, "session_start");
    await vi.waitFor(() => expect(statusLine(harness)).toContain("5h: 90%"));

    // The replay then restores the account and tells followers about it.
    service.resolve(async () => ({
      accessToken: codexJwt("acct_pinned"),
      label: "Work",
      source: "Work · Codex OAuth",
    }));
    service.notifyAccountChanged({
      providerId: "openai-codex",
      account: { id: "acct_pinned", label: "Work", authKind: "oauth" },
      ctx: harness.ctx,
    });

    await vi.waitFor(() => expect(statusLine(harness)).toContain("5h: 30%"));
    expect(service.resolveActiveAccountAuth).toHaveBeenCalledWith(
      "openai-codex",
      harness.ctx,
      expect.anything(),
    );
    expect(
      fetchMock.mock.calls.some(
        ([, init]) =>
          ((init?.headers ?? {}) as Record<string, string>)["chatgpt-account-id"] === "acct_pinned",
      ),
    ).toBe(true);
    await emit(harness, "session_shutdown");
  });
});
