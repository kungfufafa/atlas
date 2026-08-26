import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "./adapters/sqlite";
import { migrateDatabase } from "./migrate";

describe("session model override persistence", () => {
  test("stores, updates, and resets an override", async () => {
    const database = await createSqliteDatabase(":memory:");
    const now = new Date().toISOString();

    try {
      await database.adapter.upsertOrganization({
        createdAt: now,
        id: "org_test",
        name: "Test",
        slug: "test",
        updatedAt: now,
      });
      await database.adapter.upsertProfile({
        createdAt: now,
        id: "profile_test",
        isDefault: true,
        isSuper: false,
        model: "provider-1::profile-model",
        name: "Test",
        orgId: "org_test",
        systemPrompt: "Test",
        updatedAt: now,
      });
      await database.adapter.upsertSession({
        agentQuestionnaire: null,
        agentTodos: [],
        channel: "web",
        createdAt: now,
        id: "session_test",
        modelOverride: "provider-1::draft-model",
        orgId: "org_test",
        profileId: "profile_test",
        title: null,
        userId: null,
      });

      expect(
        (await database.adapter.getSession("session_test"))?.modelOverride
      ).toBe("provider-1::draft-model");
      expect(
        await database.adapter.updateSessionModelOverride(
          "session_test",
          "provider-1::next-model"
        )
      ).toBe(true);
      expect(
        (await database.adapter.getSession("session_test"))?.modelOverride
      ).toBe("provider-1::next-model");
      expect(
        await database.adapter.updateSessionModelOverride("session_test", null)
      ).toBe(true);
      expect(
        (await database.adapter.getSession("session_test"))?.modelOverride
      ).toBeNull();
    } finally {
      database.close();
    }
  });

  test("adds model_override to a legacy sessions table", () => {
    const database = new Database(":memory:");

    try {
      database.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL,
          profile_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          org_id TEXT,
          created_at TEXT NOT NULL
        );
      `);

      migrateDatabase(database);

      const columns = database
        .prepare("PRAGMA table_info(sessions)")
        .all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "model_override")).toBe(
        true
      );
    } finally {
      database.close();
    }
  });
});
