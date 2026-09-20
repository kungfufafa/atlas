import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase, type SqliteDatabase } from "./adapters/sqlite";
import { migrateDatabase } from "./migrate";

describe("session chatKind persistence", () => {
  let database: SqliteDatabase | undefined;
  afterEach(() => database?.close());

  test("stores chatKind and reloads it after reopen", async () => {
    database = await createSqliteDatabase(
      join(await mkdtemp(join(tmpdir(), "atlas-session-chat-kind-")), "app.db")
    );
    const now = new Date().toISOString();
    await database.adapter.upsertOrganization({
      createdAt: now,
      id: "org_kind",
      name: "Kind",
      slug: "kind",
      updatedAt: now,
    });
    await database.adapter.upsertProfile({
      createdAt: now,
      id: "profile_kind",
      isDefault: true,
      isSuper: false,
      model: null,
      name: "Kind",
      orgId: "org_kind",
      systemPrompt: "",
      updatedAt: now,
    });
    await database.adapter.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "whatsapp",
      chatKind: "group",
      createdAt: now,
      id: "session_kind",
      modelOverride: null,
      orgId: "org_kind",
      profileId: "profile_kind",
      title: null,
      userId: null,
    });

    expect((await database.adapter.getSession("session_kind"))?.chatKind).toBe(
      "group"
    );

    await database.reopen();
    expect((await database.adapter.getSession("session_kind"))?.chatKind).toBe(
      "group"
    );
  });

  test("adds chat_kind to a legacy sessions table", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL,
          profile_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          org_id TEXT,
          created_at TEXT NOT NULL
        );
      `);
      migrateDatabase(db);
      const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
        name: string;
      }>;
      expect(columns.some((column) => column.name === "chat_kind")).toBe(true);
    } finally {
      db.close();
    }
  });
});
