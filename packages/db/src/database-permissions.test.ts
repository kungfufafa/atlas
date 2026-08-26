import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSqliteDatabase } from "./adapters/sqlite";

// Windows has no POSIX mode bits, so the assertions below cannot mean anything
// there. Everything else under ~/.atlas is 0600/0700; the database holds
// plaintext MCP credentials and every transcript, so it follows the same rule.
const posix = process.platform !== "win32";

function modeOf(path: string): number {
  // biome-ignore lint/suspicious/noBitwiseOperators: masking the permission bits out of st_mode is what the operator is for.
  return statSync(path).mode & 0o777;
}

describe("database permissions", () => {
  test.skipIf(!posix)("a fresh database is private", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-db-perms-"));
    const databasePath = join(root, "data", "sqlite", "atlas.sqlite");

    const db = await createSqliteDatabase(`file:${databasePath}`);
    db.close();

    expect(modeOf(databasePath)).toBe(0o600);
    expect(modeOf(dirname(databasePath))).toBe(0o700);
    rmSync(root, { force: true, recursive: true });
  });

  test.skipIf(!posix)(
    "startup tightens a world-readable database",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-db-perms-"));
      const previousConfigDir = process.env.ATLAS_CONFIG_DIR;
      process.env.ATLAS_CONFIG_DIR = root;
      const databasePath = join(root, "data", "sqlite", "atlas.sqlite");
      mkdirSync(dirname(databasePath), { recursive: true });
      chmodSync(dirname(databasePath), 0o755);
      writeFileSync(databasePath, "");
      chmodSync(databasePath, 0o644);

      try {
        const db = await createSqliteDatabase(`file:${databasePath}`);
        db.close();

        expect(modeOf(databasePath)).toBe(0o600);
        expect(modeOf(dirname(databasePath))).toBe(0o700);
      } finally {
        if (previousConfigDir === undefined) {
          delete process.env.ATLAS_CONFIG_DIR;
        } else {
          process.env.ATLAS_CONFIG_DIR = previousConfigDir;
        }
        rmSync(root, { force: true, recursive: true });
      }
    }
  );

  test.skipIf(!posix)(
    "does not change an existing custom database parent directory",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "atlas-db-perms-"));
      const databasePath = join(root, "atlas.sqlite");
      chmodSync(root, 0o755);

      const db = await createSqliteDatabase(`file:${databasePath}`);
      db.close();

      expect(modeOf(databasePath)).toBe(0o600);
      expect(modeOf(root)).toBe(0o755);
      rmSync(root, { force: true, recursive: true });
    }
  );
});
