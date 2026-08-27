import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AtlasApiError } from "@atlas/core";
import { zipSync } from "fflate";
import {
  ATLAS_EXPORT_MANIFEST,
  createAtlasDataExport,
  decodeArchiveRequestData,
  previewAtlasDataImport,
  restoreAtlasDataImport,
} from "./data-portability";

let rootDir = "";

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "atlas-data-portability-test-"));
});

afterEach(async () => {
  if (rootDir) {
    await rm(rootDir, { force: true, recursive: true });
    rootDir = "";
  }
});

describe("Atlas data portability", () => {
  test("exports config root content with a manifest", async () => {
    await writeFile(join(rootDir, "config.ini"), "provider=openai");
    await writeFile(join(rootDir, "atlas.db"), "sqlite");
    await writeFile(join(rootDir, "tools.js"), "module.exports = {}");

    const result = await createAtlasDataExport({
      now: new Date("2026-07-01T10:00:00.000Z"),
      rootDir,
    });
    const preview = await previewAtlasDataImport(result.data, { rootDir });

    expect(result.filename).toBe("atlas-export-2026-07-01T10-00-00-000Z.zip");
    expect(result.manifest.kind).toBe("atlas-export");
    expect(result.manifest.topLevelPaths).toEqual([
      "atlas.db",
      "config.ini",
      "tools.js",
    ]);
    expect(preview.manifest.createdAt).toBe("2026-07-01T10:00:00.000Z");
    expect(preview.archiveFileCount).toBe(3);
    expect(preview.topLevelPaths).toEqual([
      "atlas.db",
      "config.ini",
      "tools.js",
    ]);
  });

  test("reports external database paths without copying them", async () => {
    const outsideDb = join(
      await mkdtemp(join(tmpdir(), "atlas-external-db-")),
      "atlas.db"
    );
    await writeFile(join(rootDir, "config.ini"), "ok");

    try {
      const result = await createAtlasDataExport({
        databasePath: outsideDb,
        rootDir,
      });
      expect(result.manifest.skipped).toEqual([
        {
          path: outsideDb,
          reason: "Database path is outside the Atlas root.",
        },
      ]);
    } finally {
      await rm(join(outsideDb, ".."), { force: true, recursive: true });
    }
  });

  test("excludes subscription credential directories from exports", async () => {
    await mkdir(join(rootDir, ".codex"), { recursive: true });
    await mkdir(join(rootDir, ".claude"), { recursive: true });
    await mkdir(join(rootDir, "subscription-auth", "chatgpt"), {
      recursive: true,
    });
    await writeFile(join(rootDir, ".codex", "auth.json"), "codex-secret");
    await writeFile(
      join(rootDir, ".claude", ".credentials.json"),
      "claude-secret"
    );
    await writeFile(
      join(rootDir, "subscription-auth", "chatgpt", "auth.json"),
      "atlas-codex-secret"
    );
    await writeFile(join(rootDir, "config.ini"), "safe");

    const result = await createAtlasDataExport({ rootDir });
    const preview = await previewAtlasDataImport(result.data, { rootDir });

    expect(result.manifest.skipped).toEqual([
      {
        path: ".claude",
        reason:
          "Subscription authentication credentials are excluded from exports.",
      },
      {
        path: ".codex",
        reason:
          "Subscription authentication credentials are excluded from exports.",
      },
      {
        path: "subscription-auth",
        reason:
          "Subscription authentication credentials are excluded from exports.",
      },
    ]);
    expect(result.manifest.topLevelPaths).toEqual(["config.ini"]);
    expect(preview.topLevelPaths).toEqual(["config.ini"]);
    expect(preview.archiveFileCount).toBe(1);
  });

  test("preview does not mutate existing data and restore replaces it after confirmation", async () => {
    await writeFile(join(rootDir, "config.ini"), "original");
    const exportResult = await createAtlasDataExport({ rootDir });

    await writeFile(join(rootDir, "config.ini"), "changed");
    await writeFile(join(rootDir, "extra.txt"), "remove me");

    const preview = await previewAtlasDataImport(exportResult.data, {
      rootDir,
    });
    expect(preview.willReplaceRoot).toBe(true);
    expect(await readFile(join(rootDir, "config.ini"), "utf8")).toBe("changed");

    const restore = await restoreAtlasDataImport(exportResult.data, {
      confirm: true,
      rootDir,
    });

    expect(restore.restoredFileCount).toBe(1);
    expect(await readFile(join(rootDir, "config.ini"), "utf8")).toBe(
      "original"
    );
    await expect(
      readFile(join(rootDir, "extra.txt"), "utf8")
    ).rejects.toThrow();
    await expect(
      readFile(join(rootDir, ATLAS_EXPORT_MANIFEST), "utf8")
    ).rejects.toThrow();
  });

  test("restore keeps the root directory inode so volume mounts stay put", async () => {
    await writeFile(join(rootDir, "config.ini"), "original");
    const exportResult = await createAtlasDataExport({ rootDir });
    await writeFile(join(rootDir, "config.ini"), "changed");
    const before = await lstat(rootDir);

    await restoreAtlasDataImport(exportResult.data, {
      confirm: true,
      rootDir,
    });

    const after = await lstat(rootDir);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(join(rootDir, "config.ini"), "utf8")).toBe(
      "original"
    );

    const leftovers = (await readdir(rootDir)).filter(
      (name) =>
        name.startsWith(".atlas-backup-") || name.startsWith(".atlas-restore-")
    );
    expect(leftovers).toEqual([]);
  });

  test("restore preserves existing subscription credential directories", async () => {
    await mkdir(join(rootDir, ".codex"), { recursive: true });
    await mkdir(join(rootDir, ".claude"), { recursive: true });
    await mkdir(join(rootDir, "subscription-auth", "chatgpt"), {
      recursive: true,
    });
    await writeFile(join(rootDir, ".codex", "auth.json"), "codex-before");
    await writeFile(
      join(rootDir, ".claude", ".credentials.json"),
      "claude-before"
    );
    await writeFile(
      join(rootDir, "subscription-auth", "chatgpt", "auth.json"),
      "atlas-codex-before"
    );
    await writeFile(join(rootDir, "config.ini"), "exported");
    const exportResult = await createAtlasDataExport({ rootDir });

    await writeFile(join(rootDir, ".codex", "auth.json"), "codex-live");
    await writeFile(
      join(rootDir, ".claude", ".credentials.json"),
      "claude-live"
    );
    await writeFile(
      join(rootDir, "subscription-auth", "chatgpt", "auth.json"),
      "atlas-codex-live"
    );
    await writeFile(join(rootDir, "config.ini"), "changed");

    await restoreAtlasDataImport(exportResult.data, {
      confirm: true,
      rootDir,
    });

    expect(await readFile(join(rootDir, ".codex", "auth.json"), "utf8")).toBe(
      "codex-live"
    );
    expect(
      await readFile(join(rootDir, ".claude", ".credentials.json"), "utf8")
    ).toBe("claude-live");
    expect(
      await readFile(
        join(rootDir, "subscription-auth", "chatgpt", "auth.json"),
        "utf8"
      )
    ).toBe("atlas-codex-live");
    expect(await readFile(join(rootDir, "config.ini"), "utf8")).toBe(
      "exported"
    );
  });

  test("protects a configured Claude credential home inside the Atlas root", async () => {
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const credentialDirectory = join(rootDir, "custom-claude-auth");
    process.env.CLAUDE_CONFIG_DIR = credentialDirectory;
    try {
      await mkdir(credentialDirectory, { recursive: true });
      await writeFile(
        join(credentialDirectory, ".credentials.json"),
        "secret-before"
      );
      await writeFile(join(rootDir, "config.ini"), "exported");

      const exportResult = await createAtlasDataExport({ rootDir });
      expect(exportResult.manifest.skipped).toContainEqual({
        path: "custom-claude-auth",
        reason:
          "Subscription authentication credentials are excluded from exports.",
      });

      await writeFile(
        join(credentialDirectory, ".credentials.json"),
        "secret-live"
      );
      await writeFile(join(rootDir, "config.ini"), "changed");
      await restoreAtlasDataImport(exportResult.data, {
        confirm: true,
        rootDir,
      });

      expect(
        await readFile(join(credentialDirectory, ".credentials.json"), "utf8")
      ).toBe("secret-live");
      await expect(
        previewAtlasDataImport(
          buildZipWithEntry(
            "custom-claude-auth/.credentials.json",
            "malicious"
          ),
          { rootDir }
        )
      ).rejects.toThrow(
        "Archive entry uses a protected subscription credential path"
      );
    } finally {
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
    }
  });

  test("protects canonical credential paths when the Atlas root is a symlink", async () => {
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const aliasParent = await mkdtemp(join(tmpdir(), "atlas-root-alias-test-"));
    const rootAlias = join(aliasParent, "atlas-data");
    const credentialDirectory = join(rootDir, "custom-claude-auth");
    process.env.CLAUDE_CONFIG_DIR = credentialDirectory;

    try {
      await symlink(rootDir, rootAlias, "dir");
      await mkdir(credentialDirectory, { recursive: true });
      await writeFile(
        join(credentialDirectory, ".credentials.json"),
        "secret-before"
      );
      await writeFile(join(rootDir, "config.ini"), "exported");

      const exportResult = await createAtlasDataExport({ rootDir: rootAlias });
      expect(exportResult.manifest.skipped).toContainEqual({
        path: "custom-claude-auth",
        reason:
          "Subscription authentication credentials are excluded from exports.",
      });

      await writeFile(
        join(credentialDirectory, ".credentials.json"),
        "secret-live"
      );
      await restoreAtlasDataImport(exportResult.data, {
        confirm: true,
        rootDir: rootAlias,
      });
      expect(
        await readFile(join(credentialDirectory, ".credentials.json"), "utf8")
      ).toBe("secret-live");
      await expect(
        previewAtlasDataImport(
          buildZipWithEntry(
            "custom-claude-auth/.credentials.json",
            "malicious"
          ),
          { rootDir: rootAlias }
        )
      ).rejects.toThrow(
        "Archive entry uses a protected subscription credential path"
      );
    } finally {
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
      await rm(aliasParent, { force: true, recursive: true });
    }
  });

  test("preserves a credential directory symlinked to a configured external home", async () => {
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const credentialDirectory = await mkdtemp(
      join(tmpdir(), "atlas-claude-home-test-")
    );
    const credentialAlias = join(rootDir, "custom-claude-auth");
    process.env.CLAUDE_CONFIG_DIR = credentialDirectory;

    try {
      await writeFile(
        join(credentialDirectory, ".credentials.json"),
        "secret-live"
      );
      await symlink(credentialDirectory, credentialAlias, "dir");
      await writeFile(join(rootDir, "config.ini"), "exported");

      const exportResult = await createAtlasDataExport({ rootDir });
      expect(exportResult.manifest.skipped).toContainEqual({
        path: "custom-claude-auth",
        reason:
          "Subscription authentication credentials are excluded from exports.",
      });

      await writeFile(join(rootDir, "config.ini"), "changed");
      await restoreAtlasDataImport(exportResult.data, {
        confirm: true,
        rootDir,
      });
      expect((await lstat(credentialAlias)).isSymbolicLink()).toBe(true);
      expect(
        await readFile(join(credentialAlias, ".credentials.json"), "utf8")
      ).toBe("secret-live");
    } finally {
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
      await rm(credentialDirectory, { force: true, recursive: true });
    }
  });

  test("restore requires explicit confirmation", async () => {
    await writeFile(join(rootDir, "config.ini"), "original");
    const exportResult = await createAtlasDataExport({ rootDir });

    await expect(
      restoreAtlasDataImport(exportResult.data, { confirm: false, rootDir })
    ).rejects.toThrow("Restore confirmation is required.");
  });

  test("rejects malformed archives and unsafe entry paths", async () => {
    await expect(
      previewAtlasDataImport(Buffer.from("not a zip"), { rootDir })
    ).rejects.toThrow("Invalid ZIP archive.");

    const unsafe = buildUnsafeZip();
    await expect(previewAtlasDataImport(unsafe, { rootDir })).rejects.toThrow(
      "Archive entry escapes restore root"
    );

    const reserved = buildZipWithEntry(".atlas-backup-evil/secret.txt", "{}");
    await expect(previewAtlasDataImport(reserved, { rootDir })).rejects.toThrow(
      "Archive entry uses a reserved restore path"
    );

    for (const credentialPath of [
      ".codex/auth.json",
      ".claude/.credentials.json",
      "subscription-auth/chatgpt/auth.json",
    ]) {
      const credentials = buildZipWithEntry(credentialPath, "secret");
      await expect(
        previewAtlasDataImport(credentials, { rootDir })
      ).rejects.toThrow(
        "Archive entry uses a protected subscription credential path"
      );
      await expect(
        restoreAtlasDataImport(credentials, { confirm: true, rootDir })
      ).rejects.toThrow(
        "Archive entry uses a protected subscription credential path"
      );
    }

    expect(() => decodeArchiveRequestData("not-base64!")).toThrow(
      "Import archive data is invalid or too large."
    );

    const oversizedEntry = buildZipWithEntry(
      "oversized.bin",
      "small",
      128 * 1024 * 1024 + 1
    );
    await expect(
      previewAtlasDataImport(oversizedEntry, { rootDir })
    ).rejects.toThrow("Import archive entry exceeds the 128 MiB limit");
  });

  test("counts ZIP directory records toward the archive entry limit", async () => {
    const zipEntries: Record<string, Uint8Array> = {
      [ATLAS_EXPORT_MANIFEST]: Buffer.from(
        JSON.stringify({ kind: "atlas-export", version: 1 })
      ),
    };
    for (let index = 0; index < 10_000; index += 1) {
      zipEntries[`directories/${index}/`] = new Uint8Array();
    }

    try {
      await previewAtlasDataImport(Buffer.from(zipSync(zipEntries)), {
        rootDir,
      });
      throw new Error("Expected the oversized archive to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(AtlasApiError);
      expect((error as AtlasApiError).status).toBe(413);
      expect((error as Error).message).toContain("10000-entry limit");
    }
  });

  test("serializes restores and reload callbacks by canonical root", async () => {
    const sourceA = await mkdtemp(join(tmpdir(), "atlas-restore-a-test-"));
    const sourceB = await mkdtemp(join(tmpdir(), "atlas-restore-b-test-"));
    const aliasParent = await mkdtemp(join(tmpdir(), "atlas-restore-alias-"));
    const rootAlias = join(aliasParent, "root");
    await symlink(rootDir, rootAlias, "dir");

    try {
      await writeFile(join(sourceA, "marker.txt"), "a");
      await writeFile(join(sourceA, "only-a.txt"), "a");
      await writeFile(join(sourceB, "marker.txt"), "b");
      await writeFile(join(sourceB, "only-b.txt"), "b");
      const archiveA = (await createAtlasDataExport({ rootDir: sourceA })).data;
      const archiveB = (await createAtlasDataExport({ rootDir: sourceB })).data;

      let releaseFirstCallback = () => undefined;
      const firstCallbackGate = new Promise<void>((resolveGate) => {
        releaseFirstCallback = resolveGate;
      });
      let markFirstCallbackStarted = () => undefined;
      const firstCallbackStarted = new Promise<void>((resolveStarted) => {
        markFirstCallbackStarted = resolveStarted;
      });
      const events: string[] = [];

      const firstRestore = restoreAtlasDataImport(archiveA, {
        afterRestore: async () => {
          events.push("first-start");
          markFirstCallbackStarted();
          await firstCallbackGate;
          events.push("first-end");
        },
        confirm: true,
        rootDir: rootAlias,
      });
      await firstCallbackStarted;

      let secondSettled = false;
      const secondRestore = restoreAtlasDataImport(archiveB, {
        afterRestore: async () => {
          events.push("second-callback");
        },
        confirm: true,
        rootDir,
      }).finally(() => {
        secondSettled = true;
      });
      await Bun.sleep(20);

      expect(secondSettled).toBe(false);
      expect(await readFile(join(rootDir, "marker.txt"), "utf8")).toBe("a");
      releaseFirstCallback();
      await Promise.all([firstRestore, secondRestore]);

      expect(events).toEqual(["first-start", "first-end", "second-callback"]);
      expect(await readFile(join(rootDir, "marker.txt"), "utf8")).toBe("b");
      await expect(
        readFile(join(rootDir, "only-a.txt"), "utf8")
      ).rejects.toThrow();
      expect(await readFile(join(rootDir, "only-b.txt"), "utf8")).toBe("b");
    } finally {
      await rm(sourceA, { force: true, recursive: true });
      await rm(sourceB, { force: true, recursive: true });
      await rm(dirname(rootAlias), { force: true, recursive: true });
    }
  });

  test("partial backup failure does not delete unbacked siblings", async () => {
    await writeFile(join(rootDir, "keep.ini"), "keep-me");
    await writeFile(join(rootDir, "move.ini"), "move-me");
    const exportResult = await createAtlasDataExport({ rootDir });

    const fsPromises = await import("node:fs/promises");
    const originalRename = fsPromises.rename;
    const { spyOn } = await import("bun:test");
    const renameMock = spyOn(fsPromises, "rename").mockImplementation(
      async (from, to) => {
        const toPath = String(to);
        if (toPath.includes(".atlas-backup-") && toPath.endsWith("move.ini")) {
          throw Object.assign(new Error("simulated backup failure"), {
            code: "EIO",
          });
        }
        return originalRename(from, to);
      }
    );

    try {
      await expect(
        restoreAtlasDataImport(exportResult.data, { confirm: true, rootDir })
      ).rejects.toThrow("simulated backup failure");

      await expect(readFile(join(rootDir, "keep.ini"), "utf8")).resolves.toBe(
        "keep-me"
      );
      await expect(readFile(join(rootDir, "move.ini"), "utf8")).resolves.toBe(
        "move-me"
      );
    } finally {
      renameMock.mockRestore();
    }
  });
});

function buildZipWithEntry(
  name: string,
  content: string,
  originalSize = Buffer.byteLength(content)
): Buffer {
  const safe = Buffer.from(content, "utf8");
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04_03_4b_50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x08_00, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt32LE(safe.length, 18);
  localHeader.writeUInt32LE(originalSize, 22);
  localHeader.writeUInt16LE(Buffer.byteLength(name), 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x08_00, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt32LE(safe.length, 20);
  centralHeader.writeUInt32LE(originalSize, 24);
  centralHeader.writeUInt16LE(Buffer.byteLength(name), 28);

  const centralOffset =
    localHeader.length + Buffer.byteLength(name) + safe.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralHeader.length + Buffer.byteLength(name), 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([
    localHeader,
    Buffer.from(name),
    safe,
    centralHeader,
    Buffer.from(name),
    end,
  ]);
}

function buildUnsafeZip(): Buffer {
  return buildZipWithEntry("../escape.txt", "{}");
}
