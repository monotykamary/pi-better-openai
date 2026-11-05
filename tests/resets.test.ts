import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildBankedResetConfirmation,
  formatConsumeOutcome,
  parseBankedResetCredits,
  selectBankedResetCredit,
  type BankedResetCredit,
} from "../src/resets.ts";
import { formatBankedResetsSuffix, formatUsageSnapshot, parseUsageSnapshot } from "../src/usage.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;

const tempDirs: string[] = [];
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeCodexAuth(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "auth.json"),
    `${JSON.stringify(
      {
        openai: { type: "oauth", access: "direct-openai-access", expires: Date.now() + 3600000 },
        "openai-codex": {
          type: "oauth",
          access: "resets-access",
          accountId: "acct_resets",
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
    rate_limit_reset_credits: { available_count: 1 },
  };
}

function creditsResponseBody() {
  return {
    credits: [
      {
        id: "RateLimitResetCredit_test1",
        reset_type: "codex_rate_limits",
        status: "available",
        granted_at: "2026-06-17T00:00:00Z",
        expires_at: "2026-07-17T00:00:00Z",
        title: "Full reset (Weekly + 5 hr)",
        description: "Ready to redeem",
      },
    ],
    available_count: 1,
  };
}

function consumeCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return (fetchMock.mock.calls as unknown[][]).filter(
    (call) => (call[1] as RequestInit | undefined)?.method === "POST",
  );
}

function stubResetsFetch() {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (url.includes("rate-limit-reset-credits/consume")) {
      return new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), { status: 200 });
    }
    if (url.includes("rate-limit-reset-credits")) {
      return new Response(JSON.stringify(creditsResponseBody()), { status: 200 });
    }
    return new Response(JSON.stringify(usageResponseBody()), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function importResetsWithAgentDir(agentDir: string) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  return import("../src/resets.ts");
}

async function importResetControllerWithAgentDir(agentDir: string) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  return import("../src/reset-controller.ts");
}

async function emit(
  harness: { handlers: Map<string, EventHandler[]>; ctx: ExtensionContext },
  event: string,
  payload: unknown = {},
): Promise<void> {
  const handlers = harness.handlers.get(event) ?? [];
  for (const handler of handlers) {
    await handler(payload, harness.ctx);
  }
}

async function settleAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function createResetsHarness(config: Record<string, unknown> = {}): Promise<{
  ctx: ExtensionContext;
  commands: Map<string, { handler: CommandHandler }>;
  handlers: Map<string, EventHandler[]>;
}> {
  const cwd = createTempDir("pi-better-openai-resets-project-");
  const agentDir = createTempDir("pi-better-openai-resets-agent-");
  writeCodexAuth(agentDir);
  writeProjectConfig(cwd, { usage: { enabled: true, refreshIntervalMs: 60000 }, ...config });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  const { default: betterOpenAI } = await import("../index.ts");

  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, { handler: CommandHandler }>();
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
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    model: { provider: "openai", id: "gpt-6.1-sol" },
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      confirm: vi.fn(),
      setFooter: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getCwd: vi.fn(() => cwd),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => true),
      getApiKeyForProvider: vi.fn(() => Promise.resolve(undefined)),
    },
    getContextUsage: vi.fn(() => ({ contextWindow: 0, percent: 0 })),
  } as unknown as ExtensionContext;

  betterOpenAI(pi);
  return { ctx, commands, handlers };
}

function credit(overrides: Partial<BankedResetCredit> = {}): BankedResetCredit {
  return {
    id: "c",
    resetType: "codex_rate_limits",
    status: "available",
    grantedAtMs: 0,
    expiresAtMs: null,
    title: null,
    description: null,
    ...overrides,
  };
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

describe("parseBankedResetCredits", () => {
  test("uses available_count as authoritative and skips malformed rows", () => {
    const parsed = parseBankedResetCredits({
      credits: [
        {
          id: "c1",
          reset_type: "codex_rate_limits",
          status: "available",
          granted_at: "2026-06-17T00:00:00Z",
          expires_at: "2026-07-17T00:00:00Z",
          title: "Full reset (Weekly + 5 hr)",
          description: "Ready to redeem",
        },
        { id: "c2", status: "redeemed", granted_at: 1781234567, expires_at: null },
        "garbage",
        { nope: true },
      ],
      available_count: 2,
      total_earned_count: 0,
    });

    expect(parsed.availableCount).toBe(2);
    expect(parsed.applicableCount).toBeNull();
    expect(parsed.credits).toHaveLength(2);
    expect(parsed.credits[0]?.id).toBe("c1");
    expect(parsed.credits[0]?.expiresAtMs).toBe(Date.parse("2026-07-17T00:00:00Z"));
    expect(parsed.credits[1]?.status).toBe("redeemed");
    expect(parsed.credits[1]?.expiresAtMs).toBeNull();
  });

  test("treats a missing count as zero and parses the applicable count when present", () => {
    expect(parseBankedResetCredits({ available_count: 3 }).applicableCount).toBeNull();
    expect(
      parseBankedResetCredits({ available_count: 3, applicable_available_count: 1 })
        .applicableCount,
    ).toBe(1);
    expect(parseBankedResetCredits({}).availableCount).toBe(0);
    expect(parseBankedResetCredits(undefined)).toEqual({
      availableCount: 0,
      applicableCount: null,
      credits: [],
    });
  });
});

describe("selectBankedResetCredit", () => {
  test("prefers the soonest-expiring available credit and skips redeemed ones", () => {
    const selected = selectBankedResetCredit([
      credit({ id: "late", expiresAtMs: Date.parse("2026-08-01T00:00:00Z") }),
      credit({
        id: "redeemed",
        status: "redeemed",
        expiresAtMs: Date.parse("2026-06-01T00:00:00Z"),
      }),
      credit({ id: "soon", expiresAtMs: Date.parse("2026-07-01T00:00:00Z") }),
      credit({ id: "no-expiry" }),
    ]);

    expect(selected?.id).toBe("soon");
  });

  test("returns undefined when no credits are available", () => {
    expect(selectBankedResetCredit([credit({ status: "redeemed" })])).toBeUndefined();
    expect(selectBankedResetCredit([])).toBeUndefined();
  });
});

describe("formatConsumeOutcome", () => {
  test("maps consume codes to notifications", () => {
    expect(formatConsumeOutcome({ code: "reset", windowsReset: 2 })).toEqual({
      message: "Banked reset redeemed — 2 usage windows refreshed.",
      level: "info",
    });
    expect(formatConsumeOutcome({ code: "reset", windowsReset: 1 }).message).toBe(
      "Banked reset redeemed — 1 usage window refreshed.",
    );
    expect(formatConsumeOutcome({ code: "nothing_to_reset", windowsReset: null }).level).toBe(
      "warning",
    );
    expect(formatConsumeOutcome({ code: "no_credit", windowsReset: null }).level).toBe("warning");
    expect(formatConsumeOutcome({ code: "already_redeemed", windowsReset: null }).level).toBe(
      "warning",
    );
  });
});

describe("buildBankedResetConfirmation", () => {
  test("shows credit details, availability, usage, and the irreversibility warning", () => {
    const confirmation = buildBankedResetConfirmation({
      credit: credit({
        id: "c1",
        title: "Full reset (Weekly + 5 hr)",
        description: "Ready to redeem",
        grantedAtMs: Date.parse("2026-06-17T00:00:00Z"),
        expiresAtMs: Date.parse("2026-07-17T00:00:00Z"),
      }),
      availableCount: 2,
      snapshot: { fiveHourLeftPercent: 73, sevenDayLeftPercent: 96 },
    });

    expect(confirmation.title).toBe("Redeem banked Codex reset?");
    expect(confirmation.message).toContain("Full reset (Weekly + 5 hr)");
    expect(confirmation.message).toContain("Available: 2");
    expect(confirmation.message).toContain("5h 73% left");
    expect(confirmation.message).toContain("7d 96% left");
    expect(confirmation.message).toContain("cannot be undone");
  });

  test("falls back to generic copy without a selected credit", () => {
    const confirmation = buildBankedResetConfirmation({ availableCount: 1 });

    expect(confirmation.message).toContain("Codex banked rate-limit reset");
    expect(confirmation.message).toContain("Expires: unknown");
    expect(confirmation.message).toContain("Available: 1");
  });
});

describe("usage status line banked resets", () => {
  test("appends the banked reset count from the usage payload", () => {
    const usage = parseUsageSnapshot(
      {
        rate_limit: { primary_window: { used_percent: 10 } },
        rate_limit_reset_credits: { available_count: 2 },
      },
      "gpt-5.5",
    );

    expect(usage.bankedResets).toBe(2);
    expect(formatUsageSnapshot(usage, { showResetTimes: false })).toBe(
      "Usage: 5h: 90% · 2 banked resets",
    );
    expect(formatUsageSnapshot(usage, { showResetTimes: false, showBankedResets: false })).toBe(
      "Usage: 5h: 90%",
    );
  });

  test("omits the suffix without credits and singularizes one reset", () => {
    const usage = parseUsageSnapshot(
      { rate_limit: { primary_window: { used_percent: 10 } } },
      "gpt-5.5",
    );

    expect(usage.bankedResets).toBeNull();
    expect(formatUsageSnapshot(usage, { showResetTimes: false })).toBe("Usage: 5h: 90%");

    const one = parseUsageSnapshot(
      {
        rate_limit: { primary_window: { used_percent: 10 } },
        rate_limit_reset_credits: { available_count: 1 },
      },
      "gpt-5.5",
    );

    expect(formatBankedResetsSuffix(1)).toBe("1 banked reset");
    expect(formatUsageSnapshot(one, { showResetTimes: false })).toBe(
      "Usage: 5h: 90% · 1 banked reset",
    );
    expect(formatBankedResetsSuffix(0)).toBeNull();
    expect(formatBankedResetsSuffix(null)).toBeNull();
  });
});

describe("banked reset network plumbing", () => {
  test("sends chatgpt auth headers for the credits listing", async () => {
    const agentDir = createTempDir("pi-better-openai-resets-agent-");
    writeCodexAuth(agentDir);
    const fetchMock = stubResetsFetch();
    const resets = await importResetsWithAgentDir(agentDir);

    const credits = await resets.requestBankedResetCredits();

    expect(credits?.availableCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(resets.RESET_CREDITS_URL);
    expect(init.headers).toMatchObject({
      authorization: "Bearer resets-access",
      "chatgpt-account-id": "acct_resets",
    });
  });

  test("posts a uuid redeem request id and the credit id to the consume endpoint", async () => {
    const agentDir = createTempDir("pi-better-openai-resets-agent-");
    writeCodexAuth(agentDir);
    const fetchMock = stubResetsFetch();
    const resets = await importResetsWithAgentDir(agentDir);

    const result = await resets.consumeBankedReset(undefined, "credit_1", "req-uuid");

    expect(result).toEqual({ code: "reset", windowsReset: 2 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(resets.CONSUME_RESET_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      credit_id: "credit_1",
      redeem_request_id: "req-uuid",
    });
  });

  test.each([undefined, "", " "])(
    "rejects missing or blank credit IDs (%s) without a generic POST",
    async (creditId) => {
      const agentDir = createTempDir("pi-better-openai-resets-agent-");
      writeCodexAuth(agentDir);
      const fetchMock = stubResetsFetch();
      const resets = await importResetsWithAgentDir(agentDir);

      await expect(resets.consumeBankedReset(undefined, creditId, "req-uuid")).rejects.toThrow(
        "explicit",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test("does not call the network without credentials and fails the consume loudly", async () => {
    const agentDir = createTempDir("pi-better-openai-resets-agent-");
    mkdirSync(agentDir, { recursive: true });
    const fetchMock = stubResetsFetch();
    const resets = await importResetsWithAgentDir(agentDir);

    await expect(resets.requestBankedResetCredits()).resolves.toBeUndefined();
    await expect(resets.consumeBankedReset(undefined, "credit_1", "req-uuid")).rejects.toThrow(
      "authentication is unavailable",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("surfaces non-ok responses as errors", async () => {
    const agentDir = createTempDir("pi-better-openai-resets-agent-");
    writeCodexAuth(agentDir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const resets = await importResetsWithAgentDir(agentDir);

    await expect(resets.requestBankedResetCredits()).rejects.toThrow(
      "Codex reset credit request failed (500)",
    );
    await expect(resets.consumeBankedReset(undefined, "credit_1", "req-uuid")).rejects.toThrow(
      "Codex reset consume request failed (500)",
    );
  });
});

describe("/openai-resets command", () => {
  // The first harness cold-imports the full extension and its dependencies.
  // Parallel full-suite runs can spend over five seconds in module loading.
  test("offers no confirmation when no banked credits are available", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.includes("rate-limit-reset-credits")) {
        return new Response(JSON.stringify({ credits: [], available_count: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify(usageResponseBody()), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, commands } = await createResetsHarness();

    await commands.get("openai-resets")?.handler("", ctx);
    await new Promise((resolve) => setImmediate(resolve));

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No banked Codex resets are available for this account.",
      "info",
    );
    expect(consumeCalls(fetchMock)).toHaveLength(0);
  }, 15_000);

  test("requires explicit confirmation and sends nothing when declined", async () => {
    const fetchMock = stubResetsFetch();
    const { ctx, commands } = await createResetsHarness();
    vi.mocked(ctx.ui.confirm).mockResolvedValue(false);

    await commands.get("openai-resets")?.handler("", ctx);
    await new Promise((resolve) => setImmediate(resolve));

    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    const [title, message] = vi.mocked(ctx.ui.confirm).mock.calls[0] as unknown as [string, string];
    expect(title).toBe("Redeem banked Codex reset?");
    expect(message).toContain("Full reset (Weekly + 5 hr)");
    expect(message).toContain("Available: 1");
    expect(message).toContain("cannot be undone");
    expect(consumeCalls(fetchMock)).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Banked reset redemption cancelled.", "info");
  });

  test("redeems one Codex credit after confirmation while using OpenAI with both logins", async () => {
    const fetchMock = stubResetsFetch();
    const { ctx, commands } = await createResetsHarness();
    vi.mocked(ctx.ui.confirm).mockResolvedValue(true);

    await commands.get("openai-resets")?.handler("", ctx);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    expect(ctx.ui.select).not.toHaveBeenCalled();
    const posts = consumeCalls(fetchMock);
    expect(posts).toHaveLength(1);
    const [url, init] = posts[0] as unknown as [string, RequestInit];
    expect(url).toContain("rate-limit-reset-credits/consume");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.credit_id).toBe("RateLimitResetCredit_test1");
    for (const [, request] of fetchMock.mock.calls) {
      expect(request?.headers).toMatchObject({
        authorization: "Bearer resets-access",
        "chatgpt-account-id": "acct_resets",
      });
    }
    expect(
      vi
        .mocked(ctx.modelRegistry.getApiKeyForProvider)
        .mock.calls.every(([provider]) => provider === "openai-codex"),
    ).toBe(true);
    expect(body.redeem_request_id).toMatch(/^[0-9a-f][0-9a-f-]{35}$/);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Banked reset redeemed — 2 usage windows refreshed.",
      "info",
    );
  });

  test("asks which credit to redeem when several are available", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.includes("rate-limit-reset-credits/consume")) {
        return new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), { status: 200 });
      }
      if (url.includes("rate-limit-reset-credits")) {
        return new Response(
          JSON.stringify({
            credits: [
              {
                id: "credit_a",
                status: "available",
                granted_at: "2026-06-17T00:00:00Z",
                expires_at: "2026-07-01T00:00:00Z",
                title: "Reset A",
              },
              {
                id: "credit_b",
                status: "available",
                granted_at: "2026-06-17T00:00:00Z",
                expires_at: "2026-09-01T00:00:00Z",
                title: "Reset B",
              },
            ],
            available_count: 2,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(usageResponseBody()), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, commands } = await createResetsHarness();
    vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
    vi.mocked(ctx.ui.select).mockImplementation(async (_title, options) => options[1]);

    await commands.get("openai-resets")?.handler("", ctx);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    const [title, options] = vi.mocked(ctx.ui.select).mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(title).toBe("Redeem which banked reset?");
    expect(options).toHaveLength(2);
    expect(options[0]).toContain("Reset A");
    expect(options[1]).toContain("Reset B");
    const posts = consumeCalls(fetchMock);
    const [, init] = posts[0] as unknown as [string, RequestInit];
    expect((JSON.parse(init.body as string) as Record<string, unknown>).credit_id).toBe("credit_b");
    const [, confirmMessage] = vi.mocked(ctx.ui.confirm).mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(confirmMessage).toContain("Reset B");
  });
});

describe("automatic reset extension wiring", () => {
  test.each([
    { enabled: true, provider: "openai" },
    { enabled: false, provider: "openai" },
    { enabled: true, provider: "anthropic" },
    { enabled: false, provider: "anthropic" },
  ])(
    "auto-redemption enabled=$enabled while chatting with $provider and usage hidden",
    async ({ enabled, provider }) => {
      const fetchMock = stubResetsFetch();
      const harness = await createResetsHarness({
        usage: { enabled: false, ...(enabled ? {} : { autoRedeemBankedResets: false }) },
      });
      harness.ctx.model = { provider, id: "test" } as ExtensionContext["model"];
      const base = Date.now();
      const response = creditsResponseBody();
      response.credits[0]!.expires_at = new Date(base + 1_000).toISOString();
      response.credits.push({ ...response.credits[0]!, id: "second_credit" });
      response.available_count = 2;
      const original = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("rate-limit-reset-credits"))
          return new Response(JSON.stringify(response), { status: 200 });
        return original(input, init);
      });
      vi.useFakeTimers({
        toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
      vi.setSystemTime(base);
      await emit(harness, "session_start");
      await settleAsyncWork();
      await vi.advanceTimersByTimeAsync(1);
      expect(consumeCalls(fetchMock)).toHaveLength(enabled ? 1 : 0);
      for (const [, request] of fetchMock.mock.calls) {
        expect(request?.headers).toMatchObject({
          authorization: "Bearer resets-access",
          "chatgpt-account-id": "acct_resets",
        });
      }
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(consumeCalls(fetchMock)).toHaveLength(enabled ? 1 : 0);
      expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
      await emit(harness, "session_shutdown");
    },
  );

  test.each([true, false])(
    "picker expiry notes respect auto-redemption setting (%s)",
    async (enabled) => {
      const fetchMock = stubResetsFetch();
      const response = creditsResponseBody();
      response.credits[0]!.expires_at = new Date(Date.now() + 86400_000).toISOString();
      response.credits.push({ ...response.credits[0]!, id: "second_credit" });
      response.available_count = 2;
      fetchMock.mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
      const harness = await createResetsHarness({ usage: { autoRedeemBankedResets: enabled } });
      vi.mocked(harness.ctx.ui.select).mockResolvedValue(undefined);
      await harness.commands.get("openai-resets")?.handler("", harness.ctx);
      const options = vi.mocked(harness.ctx.ui.select).mock.calls[0]![1];
      expect(options.every((option) => option.includes("auto-redeems "))).toBe(enabled);
      expect(consumeCalls(fetchMock)).toHaveLength(0);
    },
  );
});

describe("ResetController caching", () => {
  function controllerCtx(): ExtensionContext {
    return {
      modelRegistry: { getApiKeyForProvider: () => Promise.resolve(undefined) },
    } as unknown as ExtensionContext;
  }

  test("serves repeated refreshes from the cache within the TTL", async () => {
    const agentDir = createTempDir("pi-better-openai-resets-agent-");
    writeCodexAuth(agentDir);
    const fetchMock = stubResetsFetch();
    const mod = await importResetControllerWithAgentDir(agentDir);
    const controller = new mod.ResetController();
    const ctx = controllerCtx();

    await controller.refresh(ctx);

    expect(controller.snapshot?.credits.availableCount).toBe(1);
    expect(controller.isFresh()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await controller.refresh(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await controller.refresh(ctx, { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("keeps the previous cache and records the error when a refresh fails", async () => {
    const agentDir = createTempDir("pi-better-openai-resets-agent-");
    writeCodexAuth(agentDir);
    const fetchMock = stubResetsFetch();
    const mod = await importResetControllerWithAgentDir(agentDir);
    const controller = new mod.ResetController();
    const ctx = controllerCtx();
    await controller.refresh(ctx);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await controller.refresh(ctx, { force: true });

    expect(controller.lastError).toContain("failed (500)");
    expect(controller.snapshot?.credits.availableCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not fetch without credentials and records the error", async () => {
    const agentDir = createTempDir("pi-better-openai-resets-agent-");
    mkdirSync(agentDir, { recursive: true });
    const fetchMock = stubResetsFetch();
    const mod = await importResetControllerWithAgentDir(agentDir);
    const controller = new mod.ResetController();

    await controller.refresh(controllerCtx());

    expect(controller.snapshot).toBeUndefined();
    expect(controller.lastError).toContain("Missing openai-codex OAuth credentials");
    expect(controller.lastError).toContain("/login openai uses separate");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("/openai-resets cached flow", () => {
  test("opens from the warmed cache without new requests", async () => {
    const fetchMock = stubResetsFetch();
    const harness = await createResetsHarness();
    vi.mocked(harness.ctx.ui.confirm).mockResolvedValue(false);
    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await settleAsyncWork();

    fetchMock.mockClear();
    await harness.commands.get("openai-resets")?.handler("", harness.ctx);
    await settleAsyncWork();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.ctx.ui.confirm).toHaveBeenCalledTimes(1);
    const [, message] = vi.mocked(harness.ctx.ui.confirm).mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(message).toContain("Full reset (Weekly + 5 hr)");
    expect(consumeCalls(fetchMock)).toHaveLength(0);
    await emit(harness, "session_shutdown");
  });

  test("serves a stale cache instantly and refreshes it in the background", async () => {
    const fetchMock = stubResetsFetch();
    const harness = await createResetsHarness();
    vi.mocked(harness.ctx.ui.confirm).mockResolvedValue(false);
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.now();
    try {
      await emit(harness, "session_start");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await settleAsyncWork();
      vi.setSystemTime(base + 6 * 60_000);
      fetchMock.mockClear();
      await harness.commands.get("openai-resets")?.handler("", harness.ctx);
      await settleAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(harness.ctx.ui.confirm).toHaveBeenCalledTimes(1);
      const [, message] = vi.mocked(harness.ctx.ui.confirm).mock.calls[0] as unknown as [
        string,
        string,
      ];
      expect(message).toContain("Full reset (Weekly + 5 hr)");
      expect(consumeCalls(fetchMock)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
    await emit(harness, "session_shutdown");
  });
});
