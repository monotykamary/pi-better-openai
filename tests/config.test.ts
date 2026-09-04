import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { _test } from "../index.ts";
import {
  SETTINGS_OPTION_DESCRIPTORS,
  applySettingToRawConfig,
  isRecord,
  readConfig,
  readRawConfig,
  writeConfig,
} from "../src/config.ts";

function withTempDir<T>(run: (tempDir: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-better-openai-"));
  try {
    return run(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function withHome<T>(home: string, run: () => T): T {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    return run();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

describe("config helpers", () => {
  test("exposes expected defaults", () => {
    expect(_test.CONFIG_BASENAME).toBe("pi-better-openai.json");
    expect(_test.DEFAULT_CONFIG.desiredActive).toBe(false);
    expect(_test.DEFAULT_IMAGE_CONFIG.defaultModel).toBe("gpt-image-2");
    expect(_test.DEFAULT_IMAGE_CONFIG.defaultSave).toBe("project");
    expect(_test.DEFAULT_LIVE_CONFIG).toEqual({ enabled: true, voice: "sol" });
    expect(_test.DEFAULT_PET_CONFIG.placement).toBe("inline-right");
    expect(_test.DEFAULT_PET_CONFIG.state).toBe("idle");
    expect(_test.DEFAULT_PET_CONFIG.thinkingState).toBe("review");
    expect(_test.DEFAULT_PET_CONFIG.toolState).toBe("running");
    expect(_test.DEFAULT_PET_CONFIG.failedToolState).toBe("failed");
    expect(_test.DEFAULT_PET_CONFIG.idleEmotes).toBe(true);
    expect(_test.DEFAULT_PET_CONFIG.idleEmoteIntervalMs).toBe(30000);
    expect(_test.DEFAULT_SUPPORTED_MODELS).toEqual([
      "openai/gpt-5.4",
      "openai/gpt-5.5",
      "openai-codex/gpt-6-astra",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.4",
      "openai-codex/gpt-5.5",
    ]);
  });

  test("parses and normalizes model keys", () => {
    expect(_test.parseModelKey("openai/gpt-5.5")).toEqual({
      provider: "openai",
      id: "gpt-5.5",
    });
    expect(_test.parseModelKey("bad")).toBeUndefined();
    expect(_test.normalizeModelKeys(["openai/gpt-5.5", "bad", 42])).toEqual(["openai/gpt-5.5"]);
  });

  test("migrates legacy Responses image models to the standalone image model", () => {
    withTempDir((tempDir) => {
      const configPath = _test.configPaths(tempDir).project;
      writeConfig(configPath, { image: { defaultModel: "openai-codex/gpt-5.5" } });

      expect(_test.resolveConfig(tempDir).image.defaultModel).toBe("gpt-image-2");
    });
  });

  test("uses PI_CODING_AGENT_DIR for global config and expands a home-relative path", () => {
    expect(
      _test.configPaths("/project", "/home/alice", {
        PI_CODING_AGENT_DIR: "~/custom-agent",
      }).global,
    ).toBe("/home/alice/custom-agent/extensions/pi-better-openai.json");
  });

  test("preserves unknown config fields while writing updates", () => {
    withTempDir((tempDir) => {
      const configPath = join(tempDir, "config.json");
      writeConfig(configPath, {
        active: false,
        unknownField: "keep me",
        usage: { enabled: true, unknownUsageField: 123 },
      });
      const current = readRawConfig(configPath);
      writeConfig(configPath, { ...current, active: true });
      const afterActiveWrite = readRawConfig(configPath);
      expect(afterActiveWrite.active).toBe(true);
      expect(afterActiveWrite.unknownField).toBe("keep me");
      expect(afterActiveWrite.usage).toEqual({ enabled: true, unknownUsageField: 123 });

      const currentUsage = isRecord(afterActiveWrite.usage) ? afterActiveWrite.usage : {};
      writeConfig(configPath, { ...afterActiveWrite, usage: { ...currentUsage, enabled: false } });
      const afterUsageWrite = readRawConfig(configPath);
      expect(afterUsageWrite.usage).toEqual({ enabled: false, unknownUsageField: 123 });

      const projectConfigPath = _test.configPaths(tempDir).project;
      writeConfig(projectConfigPath, {
        image: { defaultSave: "global", outputFormat: "webp", timeoutMs: 1 },
      });
      const resolved = _test.resolveConfig(tempDir);
      expect(resolved.image.defaultSave).toBe("global");
      expect(resolved.image.outputFormat).toBe("webp");
      expect(resolved.image.timeoutMs).toBe(30000);
    });
  });

  test("project config overrides global config while global fills missing nested values", () => {
    withTempDir((tempDir) => {
      const cwd = join(tempDir, "project");
      const home = join(tempDir, "home");
      withHome(home, () => {
        const paths = _test.configPaths(cwd, home);
        writeConfig(paths.global, {
          usage: { enabled: false, refreshIntervalMs: 20000, showResetTimes: false },
          footer: { mode: "replace" },
          image: { defaultSave: "global", outputFormat: "jpeg", timeoutMs: 40000 },
          live: { enabled: false, voice: "spruce" },
          pets: {
            placement: "badge",
            idleEmotes: false,
            idleEmoteIntervalMs: 10000,
            sizeCells: 14,
          },
        });
        writeConfig(paths.project, {
          usage: { enabled: true },
          footer: { mode: "status" },
          image: { outputFormat: "webp" },
          live: { enabled: true },
          pets: { sizeCells: 6 },
        });

        const resolved = _test.resolveConfig(cwd);

        expect(resolved.usage).toMatchObject({
          enabled: true,
          refreshIntervalMs: 20000,
          showResetTimes: false,
        });
        expect(resolved.footer.mode).toBe("status");
        expect(resolved.image).toMatchObject({
          defaultSave: "global",
          outputFormat: "webp",
          timeoutMs: 40000,
        });
        expect(resolved.live).toEqual({ enabled: true, voice: "spruce" });
        expect(resolved.pets).toMatchObject({
          placement: "badge",
          idleEmotes: false,
          idleEmoteIntervalMs: 10000,
          sizeCells: 6,
        });
      });
    });
  });

  test("ignores invalid enum values while reading config", () => {
    withTempDir((tempDir) => {
      const configPath = join(tempDir, "config.json");
      writeConfig(configPath, {
        footer: { mode: "float" },
        image: { enabled: true, defaultSave: "desktop", outputFormat: "gif" },
        live: { enabled: false, voice: "robot" },
        pets: { enabled: true, placement: "ceiling", state: "sleeping", thinkingState: "ponder" },
      });

      const parsed = readConfig(configPath);

      expect(parsed?.footer).toBeUndefined();
      expect(parsed?.image).toEqual({ enabled: true });
      expect(parsed?.live).toEqual({ enabled: false });
      expect(parsed?.pets).toEqual({ enabled: true });
    });
  });

  test("clamps numeric usage, image, and pet settings", () => {
    withTempDir((tempDir) => {
      const projectConfigPath = _test.configPaths(tempDir).project;
      writeConfig(projectConfigPath, {
        usage: { refreshIntervalMs: 1 },
        image: { timeoutMs: 1 },
        pets: { idleEmoteIntervalMs: 1, sizeCells: 99 },
      });

      const resolved = _test.resolveConfig(tempDir);

      expect(resolved.usage.refreshIntervalMs).toBe(15000);
      expect(resolved.image.timeoutMs).toBe(30000);
      expect(resolved.pets.idleEmoteIntervalMs).toBe(5000);
      expect(resolved.pets.sizeCells).toBe(16);
    });
  });

  test("settings descriptors parse representative raw value types", () => {
    const descriptors = new Map(
      SETTINGS_OPTION_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
    );

    expect(descriptors.get("usage.enabled")?.parse("true")).toBe(true);
    expect(descriptors.get("usage.refreshIntervalMs")?.parse("15000")).toBe(15000);
    expect(descriptors.get("footer.mode")?.parse("status")).toBe("status");
    expect(
      descriptors.get("pets.slug")?.parse("not selected", { petEmptyValue: "not selected" }),
    ).toBe("");
    expect(descriptors.get("pets.sizeCells")?.parse("12")).toBe(12);
    expect(descriptors.get("image.timeoutMs")?.parse("45000")).toBe(45000);
    expect(descriptors.get("live.enabled")?.parse("true")).toBe(true);
    expect(descriptors.get("live.voice")?.parse("vale")).toBe("vale");
  });

  test("applies settings writes with persisted raw config shapes", () => {
    const raw = {
      unknown: "preserved",
      usage: { unknownUsage: true },
      pets: { unknownPet: "yes" },
      live: { unknownLive: "yes" },
    };

    expect(
      applySettingToRawConfig(raw, "fast.enabled", "true", {
        persistState: true,
        active: true,
        desiredActive: true,
      }),
    ).toMatchObject({ active: true, desiredActive: true, unknown: "preserved" });
    expect(
      applySettingToRawConfig(raw, "fast.enabled", "true", {
        persistState: false,
        active: true,
        desiredActive: true,
      }),
    ).not.toHaveProperty("active");

    expect(applySettingToRawConfig(raw, "usage.refreshIntervalMs", "15000").usage).toEqual({
      unknownUsage: true,
      refreshIntervalMs: 15000,
    });
    expect(applySettingToRawConfig(raw, "footer.mode", "status").footer).toEqual({
      mode: "status",
    });
    expect(
      applySettingToRawConfig(raw, "pets.slug", "not selected", { petEmptyValue: "not selected" })
        .pets,
    ).toEqual({ unknownPet: "yes", slug: "" });
    expect(applySettingToRawConfig(raw, "pets.sizeCells", "12").pets).toMatchObject({
      sizeCells: 12,
    });
    expect(applySettingToRawConfig(raw, "image.timeoutMs", "45000").image).toEqual({
      timeoutMs: 45000,
    });
    expect(applySettingToRawConfig(raw, "live.voice", "vale").live).toEqual({
      unknownLive: "yes",
      voice: "vale",
    });
  });
});
