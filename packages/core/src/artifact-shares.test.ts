import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  buildArtifactSharePath,
  deleteArtifactShareSnapshot,
  generateArtifactShareToken,
  readArtifactShareSnapshot,
  sanitizeArtifactShareFilename,
  writeArtifactShareSnapshot,
} from "./artifact-shares";
import { getArtifactSharesDir } from "./soul/resolve";

const TEST_CONFIG_DIR = path.join(
  process.cwd(),
  ".tmp-test-config",
  `artifact-shares-${crypto.randomUUID()}`
);
const ORIGINAL_CONFIG_DIR = process.env.ATLAS_CONFIG_DIR;

describe("artifact shares", () => {
  afterEach(async () => {
    if (ORIGINAL_CONFIG_DIR === undefined) {
      delete process.env.ATLAS_CONFIG_DIR;
    } else {
      process.env.ATLAS_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
    }
    await rm(TEST_CONFIG_DIR, { force: true, recursive: true });
  });

  test("generateArtifactShareToken returns high-entropy share tokens without underscores", () => {
    const token = generateArtifactShareToken();
    expect(token.startsWith("nkshare")).toBe(true);
    expect(token).not.toContain("_");
    expect(token.length).toBeGreaterThan(40);
  });

  test("buildArtifactSharePath returns SPA route", () => {
    expect(buildArtifactSharePath("abc123")).toBe("/s/abc123");
  });

  test("write and read snapshot round-trip", async () => {
    process.env.ATLAS_CONFIG_DIR = TEST_CONFIG_DIR;
    await mkdir(TEST_CONFIG_DIR, { recursive: true });

    const orgId = "org_test";
    const shareId = "share_test";
    const bytes = Buffer.from("# Hello", "utf8");
    const storagePath = await writeArtifactShareSnapshot({
      bytes,
      filename: "report.md",
      orgId,
      shareId,
    });

    expect(storagePath.startsWith(getArtifactSharesDir(orgId))).toBe(true);
    expect(await readArtifactShareSnapshot(storagePath)).toEqual(bytes);
    await deleteArtifactShareSnapshot(storagePath);
  });

  test("sanitizeArtifactShareFilename strips CR/LF and quotes", () => {
    expect(sanitizeArtifactShareFilename('evil\r\nname".md')).toBe(
      "evil_name_.md"
    );
  });
});
