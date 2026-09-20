import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MEMORY_ARCHIVE_TEMPLATE } from "./memory-archive";
import {
  loadMemoryArchiveFacts,
  loadProfileMemoryArchiveFacts,
  parseMemoryArchiveFacts,
} from "./memory-archive-index";

const PROFILE = { orgId: "org_archive_index", profileId: "profile_archive" };
const originalConfigDir = process.env.ATLAS_CONFIG_DIR;

function archiveMarkdown(badge: string): string {
  return `${MEMORY_ARCHIVE_TEMPLATE}
<!-- archived: 2026-08-15T00:00:00.000Z -->

## 2026-08-15

- The badge code is ${badge}.
`;
}

describe("memory archive indexer", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { force: true, recursive: true });
      tempDir = "";
    }
    if (originalConfigDir === undefined) {
      delete process.env.ATLAS_CONFIG_DIR;
    } else {
      process.env.ATLAS_CONFIG_DIR = originalConfigDir;
    }
  });

  test("parseMemoryArchiveFacts prefixes ids and keeps dated bullets", () => {
    const facts = parseMemoryArchiveFacts(
      archiveMarkdown("QUARTZ-WALRUS-19"),
      "2026-08.md"
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]?.content).toBe("The badge code is QUARTZ-WALRUS-19.");
    expect(facts[0]?.id).toContain("archive:2026-08.md:");
    expect(facts[0]?.source).toBe("archive");
    expect(facts[0]?.updatedAt).toBe("2026-08-15T00:00:00.000Z");
  });

  test("loadMemoryArchiveFacts reads YYYY-MM.md and ignores other files", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "atlas-archive-index-"));
    await writeFile(
      path.join(tempDir, "2026-08.md"),
      archiveMarkdown("QUARTZ-WALRUS-19"),
      "utf8"
    );
    await writeFile(
      path.join(tempDir, "notes.txt"),
      "- The badge code is SHOULD-NOT-INDEX.\n",
      "utf8"
    );
    await writeFile(
      path.join(tempDir, "2026-13.md"),
      archiveMarkdown("INVALID-MONTH"),
      "utf8"
    );
    const facts = await loadMemoryArchiveFacts(tempDir);
    expect(facts.map((fact) => fact.content)).toEqual([
      "The badge code is QUARTZ-WALRUS-19.",
    ]);
  });

  test("loadProfileMemoryArchiveFacts uses the profile memory-archive directory", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "atlas-archive-profile-"));
    process.env.ATLAS_CONFIG_DIR = tempDir;
    const archiveDir = path.join(
      tempDir,
      "orgs",
      PROFILE.orgId,
      "profiles",
      PROFILE.profileId,
      "memory-archive"
    );
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      path.join(archiveDir, "2026-08.md"),
      archiveMarkdown("QUARTZ-WALRUS-19"),
      "utf8"
    );
    const facts = await loadProfileMemoryArchiveFacts(
      PROFILE.orgId,
      PROFILE.profileId
    );
    expect(facts.map((fact) => fact.content)).toEqual([
      "The badge code is QUARTZ-WALRUS-19.",
    ]);
  });

  test("loadProfileMemoryArchiveFacts falls back to legacy data/memory-archive", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "atlas-archive-legacy-"));
    process.env.ATLAS_CONFIG_DIR = tempDir;
    const legacyDir = path.join(
      tempDir,
      "orgs",
      PROFILE.orgId,
      "profiles",
      PROFILE.profileId,
      "data",
      "memory-archive"
    );
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "2026-08.md"),
      archiveMarkdown("LEGACY-BADGE-2"),
      "utf8"
    );
    const facts = await loadProfileMemoryArchiveFacts(
      PROFILE.orgId,
      PROFILE.profileId
    );
    expect(facts.some((fact) => fact.content.includes("LEGACY-BADGE-2"))).toBe(
      true
    );
  });
});
