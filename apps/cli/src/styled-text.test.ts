import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearMacOsThemeSessionCache,
  detectMacOsTheme,
  getCliStatePath,
} from "./styled-text";

describe("detectMacOsTheme", () => {
  let configDir = "";
  let previousConfigDir: string | undefined;

  afterEach(async () => {
    clearMacOsThemeSessionCache();
    if (previousConfigDir === undefined) {
      delete process.env.ATLAS_CONFIG_DIR;
    } else {
      process.env.ATLAS_CONFIG_DIR = previousConfigDir;
    }
    if (configDir) {
      await rm(configDir, { force: true, recursive: true });
      configDir = "";
    }
  });

  async function useTempConfigDir(): Promise<void> {
    configDir = await mkdtemp(join(tmpdir(), "atlas-cli-theme-"));
    previousConfigDir = process.env.ATLAS_CONFIG_DIR;
    process.env.ATLAS_CONFIG_DIR = configDir;
    clearMacOsThemeSessionCache();
  }

  test("reads defaults once and caches by preferences mtime", async () => {
    await useTempConfigDir();
    let reads = 0;

    const first = await detectMacOsTheme({
      prefsMtimeMs: () => 1000,
      readDefaults: () => {
        reads += 1;
        return "dark";
      },
    });
    expect(first).toBe("dark");
    expect(reads).toBe(1);

    const raw = await readFile(getCliStatePath(), "utf8");
    expect(JSON.parse(raw)).toEqual({
      macosTheme: "dark",
      macosThemePrefsMtimeMs: 1000,
    });

    clearMacOsThemeSessionCache();
    const second = await detectMacOsTheme({
      prefsMtimeMs: () => 1000,
      readDefaults: () => {
        reads += 1;
        return "light";
      },
    });
    expect(second).toBe("dark");
    expect(reads).toBe(1);
  });

  test("re-reads defaults when preferences mtime changes", async () => {
    await useTempConfigDir();
    let reads = 0;

    await detectMacOsTheme({
      prefsMtimeMs: () => 1000,
      readDefaults: () => {
        reads += 1;
        return "dark";
      },
    });

    clearMacOsThemeSessionCache();
    const next = await detectMacOsTheme({
      prefsMtimeMs: () => 2000,
      readDefaults: () => {
        reads += 1;
        return "light";
      },
    });
    expect(next).toBe("light");
    expect(reads).toBe(2);

    const raw = await readFile(getCliStatePath(), "utf8");
    expect(JSON.parse(raw)).toEqual({
      macosTheme: "light",
      macosThemePrefsMtimeMs: 2000,
    });
  });

  test("uses the in-memory cache without re-reading disk", async () => {
    await useTempConfigDir();
    let reads = 0;

    await detectMacOsTheme({
      prefsMtimeMs: () => 1000,
      readDefaults: () => {
        reads += 1;
        return "dark";
      },
    });

    const again = await detectMacOsTheme({
      prefsMtimeMs: () => {
        throw new Error("preferences should not be read again in-session");
      },
      readDefaults: () => {
        reads += 1;
        return "light";
      },
    });
    expect(again).toBe("dark");
    expect(reads).toBe(1);
  });

  test("calls defaults when preferences mtime is unavailable", async () => {
    await useTempConfigDir();
    let reads = 0;

    const theme = await detectMacOsTheme({
      prefsMtimeMs: () => null,
      readDefaults: () => {
        reads += 1;
        return "light";
      },
    });
    expect(theme).toBe("light");
    expect(reads).toBe(1);

    const raw = await readFile(getCliStatePath(), "utf8");
    expect(JSON.parse(raw)).toEqual({ macosTheme: "light" });
  });
});
