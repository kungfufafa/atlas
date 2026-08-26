import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getErrorTrackingConfigPath,
  isErrorTrackingEnabled,
  loadErrorTrackingConfig,
  resolveErrorTrackingDsn,
  saveErrorTrackingDsn,
} from "./error-tracking-config";

const DSN = "https://public-key@errors.example.com/7";

let configDir = "";
let previousConfigDir: string | undefined;
let previousDsn: string | undefined;
let previousDoNotTrack: string | undefined;

beforeEach(async () => {
  previousConfigDir = process.env.ATLAS_CONFIG_DIR;
  previousDsn = process.env.ATLAS_ERROR_TRACKING_DSN;
  previousDoNotTrack = process.env.DO_NOT_TRACK;
  configDir = await mkdtemp(join(tmpdir(), "atlas-error-tracking-"));
  process.env.ATLAS_CONFIG_DIR = configDir;
  delete process.env.ATLAS_ERROR_TRACKING_DSN;
  delete process.env.DO_NOT_TRACK;
});

afterEach(async () => {
  restoreEnv("ATLAS_CONFIG_DIR", previousConfigDir);
  restoreEnv("ATLAS_ERROR_TRACKING_DSN", previousDsn);
  restoreEnv("DO_NOT_TRACK", previousDoNotTrack);
  await rm(configDir, { force: true, recursive: true });
});

test("an install with no DSN has tracking disabled", async () => {
  expect(await loadErrorTrackingConfig()).toEqual({ dsn: null });
  expect(await isErrorTrackingEnabled()).toBe(false);
});

test("a saved DSN round trips in a private config file", async () => {
  await saveErrorTrackingDsn(DSN);

  expect(await loadErrorTrackingConfig()).toEqual({ dsn: DSN });
  expect(await isErrorTrackingEnabled()).toBe(true);
  expect(await readFile(getErrorTrackingConfigPath(), "utf8")).toContain(
    `dsn=${DSN}`
  );
  expect(
    (await stat(getErrorTrackingConfigPath())).mode.toString(8).slice(-3)
  ).toBe("600");
});

test("a legacy DSN password is never persisted", async () => {
  const configured = await saveErrorTrackingDsn(
    "https://public-key:legacy-secret@errors.example.com/7"
  );
  const stored = await readFile(getErrorTrackingConfigPath(), "utf8");

  expect(configured.dsn).toBe("https://public-key@errors.example.com/7");
  expect(stored).not.toContain("legacy-secret");
});

test("DO_NOT_TRACK overrides both file and environment DSNs", () => {
  expect(
    resolveErrorTrackingDsn(
      { dsn: DSN },
      {
        ATLAS_ERROR_TRACKING_DSN: "https://other@example.com/9",
        DO_NOT_TRACK: "true",
      }
    )
  ).toBeNull();
});

test("the environment DSN overrides the file and empty means disabled", () => {
  expect(
    resolveErrorTrackingDsn(
      { dsn: DSN },
      { ATLAS_ERROR_TRACKING_DSN: "https://other@example.com/9" }
    )
  ).toBe("https://other@example.com/9");
  expect(
    resolveErrorTrackingDsn({ dsn: DSN }, { ATLAS_ERROR_TRACKING_DSN: "" })
  ).toBeNull();
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
