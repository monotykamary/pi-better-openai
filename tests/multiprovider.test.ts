import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { getCodexCredentials } from "../src/codex-auth.ts";
import {
  CODEX_PROVIDER_ID,
  getActiveMultiproviderService,
  isMultiproviderService,
  setActiveMultiproviderService,
  type MultiproviderAccountAuth,
  type MultiproviderService,
} from "../src/multiprovider.ts";

function codexJwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.sig`;
}

function fakeService(
  resolve: () => Promise<MultiproviderAccountAuth | undefined>,
): MultiproviderService {
  return {
    getActiveAccount: vi.fn(async () => undefined),
    resolveActiveAccountAuth: vi.fn(resolve),
    onActiveAccountChanged: vi.fn(() => () => {}),
  };
}

function credentialContext() {
  return {
    modelRegistry: {
      getApiKeyForProvider: vi.fn(() =>
        Promise.resolve(JSON.stringify({ access: "registry-access", accountId: "acct_registry" })),
      ),
    },
    model: undefined,
    sessionManager: { getSessionId: () => "session-1" },
  } as unknown as Parameters<typeof getCodexCredentials>[0];
}

afterEach(() => {
  setActiveMultiproviderService(undefined);
});

test("detects the pi-multiprovider service payload", () => {
  expect(isMultiproviderService(fakeService(async () => undefined))).toBe(true);
  expect(isMultiproviderService(undefined)).toBe(false);
  expect(isMultiproviderService({ getActiveAccount: () => {} })).toBe(false);
  expect(
    isMultiproviderService({
      getActiveAccount: () => {},
      resolveActiveAccountAuth: () => {},
      onActiveAccountChanged: null,
    }),
  ).toBe(false);
});

test("tracks the active service", () => {
  const service = fakeService(async () => undefined);
  setActiveMultiproviderService(service);
  expect(getActiveMultiproviderService()).toBe(service);
  setActiveMultiproviderService(undefined);
  expect(getActiveMultiproviderService()).toBeUndefined();
});

test.each(["openai", "openai-codex"])(
  "prefers the pinned Codex account while chatting with %s",
  async (provider) => {
    const service = fakeService(async () => ({
      accessToken: codexJwt("acct_pooled"),
      label: "Work",
      source: "Work · Codex OAuth",
    }));
    setActiveMultiproviderService(service);
    const ctx = credentialContext();
    if (ctx) ctx.model = { provider, id: "gpt-6.1-sol" } as ExtensionContext["model"];

    const credentials = await getCodexCredentials(ctx);

    expect(credentials).toEqual({
      accessToken: codexJwt("acct_pooled"),
      accountId: "acct_pooled",
      source: "multiprovider",
    });
    expect(service.resolveActiveAccountAuth).toHaveBeenCalledWith(
      CODEX_PROVIDER_ID,
      ctx,
      undefined,
    );
    expect(ctx?.modelRegistry?.getApiKeyForProvider).not.toHaveBeenCalled();
  },
);

test("falls back to registry credentials when no pooled account resolves", async () => {
  setActiveMultiproviderService(fakeService(async () => undefined));
  const credentials = await getCodexCredentials(credentialContext());
  expect(credentials).toEqual({
    accessToken: "registry-access",
    accountId: "acct_registry",
    source: "modelRegistry",
  });
});

test("falls back when the pooled token is not a subscription OAuth token", async () => {
  setActiveMultiproviderService(
    fakeService(async () => ({ accessToken: "plain-api-key", label: "Key" })),
  );
  const credentials = await getCodexCredentials(credentialContext());
  expect(credentials?.source).toBe("modelRegistry");
});

test("falls back when the multiprovider resolver rejects", async () => {
  setActiveMultiproviderService(fakeService(() => Promise.reject(new Error("store locked"))));
  const credentials = await getCodexCredentials(credentialContext());
  expect(credentials?.source).toBe("modelRegistry");
});

test("uses the registry path when pi-multiprovider is absent", async () => {
  const ctx = credentialContext();
  const credentials = await getCodexCredentials(ctx);
  expect(credentials?.source).toBe("modelRegistry");
  expect(ctx?.modelRegistry?.getApiKeyForProvider).toHaveBeenCalledWith(CODEX_PROVIDER_ID);
});
