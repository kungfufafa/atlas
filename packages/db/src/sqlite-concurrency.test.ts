import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureSqliteConnection,
  createSqliteDatabase,
  SQLITE_BUSY_TIMEOUT_MS,
} from "./adapters/sqlite";

describe("sqlite concurrency pragmas", () => {
  let rootDir = "";

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { force: true, recursive: true });
      rootDir = "";
    }
  });

  test("on-disk databases use WAL and a busy timeout", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "atlas-db-wal-"));
    const databasePath = join(rootDir, "atlas.sqlite");
    const database = await createSqliteDatabase(`file:${databasePath}`);

    const probe = new Database(databasePath);
    try {
      const journal = probe.query("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      expect(journal.journal_mode.toLowerCase()).toBe("wal");

      configureSqliteConnection(probe, databasePath);
      const busy = probe.query("PRAGMA busy_timeout").get() as {
        timeout: number;
      };
      expect(busy.timeout).toBe(SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      probe.close();
      database.close();
    }
  });

  test("two connections can write the same on-disk file", async () => {
    rootDir = mkdtempSync(join(tmpdir(), "atlas-db-busy-"));
    const databasePath = join(rootDir, "atlas.sqlite");
    const first = await createSqliteDatabase(`file:${databasePath}`);
    const second = await createSqliteDatabase(`file:${databasePath}`);
    const now = new Date().toISOString();

    try {
      await first.adapter.createUser({
        createdAt: now,
        email: "one@example.com",
        id: "user-1",
        name: "One",
        passwordHash: "hash",
        updatedAt: now,
      });
      await second.adapter.createUser({
        createdAt: now,
        email: "two@example.com",
        id: "user-2",
        name: "Two",
        passwordHash: "hash",
        updatedAt: now,
      });

      expect(await first.adapter.countHumanUsers()).toBe(2);
      expect(await second.adapter.countHumanUsers()).toBe(2);
    } finally {
      first.close();
      second.close();
    }
  });
});
