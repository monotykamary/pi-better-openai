import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { reserveBankedResetRedemption } from "../src/reset-guard.ts";
import { BANKED_RESET_AUTO_REDEEM_LEAD_MS } from "../src/resets.ts";

const LEAD_MS = BANKED_RESET_AUTO_REDEEM_LEAD_MS;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-reset-process-safety-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

describe("due-only durable reservations", () => {
  test.each([-1, 0, LEAD_MS + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects automatic reservations outside the final lead window (%s)",
    (offset) => {
      vi.useFakeTimers();
      const now = Date.now();
      expect(
        reserveBankedResetRedemption("fake-account", "future", { expiresAtMs: now + offset }),
      ).toBe(false);
      // Rejections must not claim the account or credit.
      expect(
        reserveBankedResetRedemption("fake-account", "future", { expiresAtMs: now + LEAD_MS }),
      ).toBe(true);
    },
  );

  test("migrates the previous release's reservation without forgetting its attempted credit", () => {
    vi.useFakeTimers();
    expect(reserveBankedResetRedemption("fake-account", "first")).toBe(true);
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const path = join(
      agentDir,
      "pi-better-openai",
      "reset-redemptions",
      `${digest("fake-account")}.json`,
    );
    writeFileSync(
      path,
      JSON.stringify({ blockedUntilMs: Date.now() + LEAD_MS, creditHash: digest("first") }),
    );
    vi.advanceTimersByTime(LEAD_MS);
    expect(reserveBankedResetRedemption("fake-account", "second")).toBe(true);
    vi.advanceTimersByTime(LEAD_MS);
    expect(reserveBankedResetRedemption("fake-account", "first")).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).attemptedCreditHashes).toEqual([
      digest("first"),
      digest("second"),
    ]);
  });

  test.skipIf(process.platform === "win32")(
    "replaces the durable inode without mutating old readers",
    () => {
      vi.useFakeTimers();
      expect(reserveBankedResetRedemption("fake-account", "first")).toBe(true);
      const hash = createHash("sha256").update("fake-account").digest("hex");
      const dir = join(agentDir, "pi-better-openai", "reset-redemptions");
      const path = join(dir, `${hash}.json`);
      const snapshot = join(dir, "old-inode");
      linkSync(path, snapshot);
      const first = readFileSync(path, "utf8");

      vi.advanceTimersByTime(LEAD_MS);
      expect(reserveBankedResetRedemption("fake-account", "second")).toBe(true);
      expect(readFileSync(snapshot, "utf8")).toBe(first);
      expect(JSON.parse(readFileSync(path, "utf8")).attemptedCreditHashes).toHaveLength(2);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir).sort()).toEqual([`${hash}.json`, "old-inode"].sort());
    },
  );

  test("fails closed on malformed attempt history", () => {
    vi.useFakeTimers();
    reserveBankedResetRedemption("fake-account", "first");
    const hash = createHash("sha256").update("fake-account").digest("hex");
    const path = join(agentDir, "pi-better-openai", "reset-redemptions", `${hash}.json`);
    const state = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...state, attemptedCreditHashes: [null] }));
    vi.advanceTimersByTime(LEAD_MS);
    expect(() => reserveBankedResetRedemption("fake-account", "second")).toThrow(
      "safety reservation",
    );
  });
});

describe("independent pi process coordination (no HTTP or credentials)", () => {
  test.each(["same-credit", "different-credits"])(
    "only one of eight processes reserves %s",
    async (scenario) => {
      const moduleUrl = new URL("../src/reset-guard.ts", import.meta.url).href;
      const source = `
      globalThis.fetch = () => { throw new Error("Network forbidden in reservation probe"); };
      const { reserveBankedResetRedemption } = await import(${JSON.stringify(moduleUrl)});
      console.log(reserveBankedResetRedemption("fake-account", process.env.RESET_TEST_CREDIT, {
        expiresAtMs: Number(process.env.RESET_TEST_EXPIRY),
      }));
    `;
      const expiresAtMs = String(Date.now() + INSIDE_LEAD_MS);
      const results = await Promise.all(
        Array.from(
          { length: 8 },
          (_, index) =>
            new Promise<string>((resolve, reject) => {
              execFile(
                "bun",
                ["--eval", source],
                {
                  timeout: 10_000,
                  env: {
                    PATH: process.env.PATH,
                    HOME: agentDir,
                    PI_CODING_AGENT_DIR: agentDir,
                    RESET_TEST_CREDIT:
                      scenario === "same-credit" ? "fake-credit" : `fake-credit-${index}`,
                    RESET_TEST_EXPIRY: expiresAtMs,
                  },
                },
                (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
              );
            }),
        ),
      );
      expect(results.filter((value) => value === "true")).toHaveLength(1);
      expect(results.filter((value) => value === "false")).toHaveLength(7);
    },
    15_000,
  );
});

const INSIDE_LEAD_MS = LEAD_MS - 1_000;
