import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCliConfigPath,
  loadSavedCliOrgId,
  loadSavedCliProfileId,
  saveCliOrgId,
  saveCliProfileId,
} from "./cli-config";

async function withCliConfigDir<T>(run: () => Promise<T>): Promise<T> {
  const configDir = await mkdtemp(join(tmpdir(), "atlas-cli-"));
  const previous = process.env.ATLAS_CONFIG_DIR;
  process.env.ATLAS_CONFIG_DIR = configDir;

  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.ATLAS_CONFIG_DIR;
    } else {
      process.env.ATLAS_CONFIG_DIR = previous;
    }
  }
}

describe("cli-config", () => {
  test("saves and loads profile_id", async () => {
    await withCliConfigDir(async () => {
      await saveCliProfileId("super_agent");
      expect(await loadSavedCliProfileId()).toBe("super_agent");

      const raw = await readFile(getCliConfigPath(), "utf8");
      expect(raw).toContain("profile_id=super_agent");
    });
  });

  test("drops unknown keys when rewriting cli.ini", async () => {
    await withCliConfigDir(async () => {
      const path = getCliConfigPath();
      await writeFile(
        path,
        [
          "# Atlas CLI",
          "profile_id=super_agent",
          "evil=injected",
          "org_id=org_123",
          "another=payload",
          "",
        ].join("\n"),
        { mode: 0o600 }
      );

      expect(await loadSavedCliProfileId()).toBe("super_agent");
      expect(await loadSavedCliOrgId()).toBe("org_123");

      await saveCliOrgId("org_123");
      const raw = await readFile(path, "utf8");
      expect(raw).toContain("profile_id=super_agent");
      expect(raw).toContain("org_id=org_123");
      expect(raw).not.toContain("evil");
      expect(raw).not.toContain("another");
      expect(raw).not.toContain("injected");
      expect(raw).not.toContain("payload");
    });
  });
});
