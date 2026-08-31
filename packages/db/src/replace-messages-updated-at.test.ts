import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
import { createSqliteDatabase } from "./adapters/sqlite";
import type { DatabaseAdapter } from "./types";

const ORG_ID = "org_test";
const PROFILE_ID = "profile_test";
const SESSION_ID = "session_test";

async function seedSession(adapter: DatabaseAdapter): Promise<void> {
  const now = "2020-01-01T00:00:00.000Z";
  await adapter.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Test",
    slug: "test",
    updatedAt: now,
  });
  await adapter.upsertProfile({
    createdAt: now,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: "provider-1::profile-model",
    name: "Test",
    orgId: ORG_ID,
    systemPrompt: "Test",
    updatedAt: now,
  });
  await adapter.upsertSession({
    agentQuestionnaire: null,
    agentTodos: [],
    channel: "web",
    createdAt: now,
    id: SESSION_ID,
    modelOverride: null,
    orgId: ORG_ID,
    profileId: PROFILE_ID,
    title: null,
    userId: null,
  });
}

describe("replaceMessagesForSession updatedAt", () => {
  for (const kind of ["sqlite", "in-memory"] as const) {
    test(`${kind}: advances past stale message timestamps`, async () => {
      const database =
        kind === "sqlite" ? await createSqliteDatabase(":memory:") : null;
      const adapter = database?.adapter ?? createInMemoryDatabaseAdapter();
      try {
        await seedSession(adapter);
        const stale = "2020-06-01T00:00:00.000Z";
        const beforeReplace = new Date().toISOString();

        await adapter.replaceMessagesForSession(SESSION_ID, [
          {
            createdAt: stale,
            id: "msg_1",
            payload: { content: "hello", role: "user" },
            seq: 0,
            sessionId: SESSION_ID,
          },
        ]);

        const summaries = await adapter.listSessionSummaries(PROFILE_ID, "web");
        expect(summaries).toHaveLength(1);
        expect(summaries[0]!.updatedAt > stale).toBe(true);
        expect(summaries[0]!.updatedAt >= beforeReplace).toBe(true);
      } finally {
        database?.close();
      }
    });
  }

  test("sqlite append and replace batches are atomic", async () => {
    const database = await createSqliteDatabase(":memory:");
    try {
      await seedSession(database.adapter);
      const createdAt = "2020-06-01T00:00:00.000Z";
      await database.adapter.appendMessagesForSession(SESSION_ID, [
        {
          createdAt,
          id: "msg_keep",
          payload: { content: "keep", role: "user" },
          seq: 0,
          sessionId: SESSION_ID,
        },
      ]);

      await expect(
        database.adapter.appendMessagesForSession(SESSION_ID, [
          {
            createdAt,
            id: "msg_new",
            payload: { content: "new", role: "assistant" },
            seq: 1,
            sessionId: SESSION_ID,
          },
          {
            createdAt,
            id: "msg_keep",
            payload: { content: "duplicate", role: "user" },
            seq: 2,
            sessionId: SESSION_ID,
          },
        ])
      ).rejects.toThrow();
      expect(
        (await database.adapter.listMessagesForSession(SESSION_ID)).map(
          (message) => message.id
        )
      ).toEqual(["msg_keep"]);

      await expect(
        database.adapter.replaceMessagesForSession(SESSION_ID, [
          {
            createdAt,
            id: "replacement",
            payload: { content: "new", role: "assistant" },
            seq: 0,
            sessionId: SESSION_ID,
          },
          {
            createdAt,
            id: "replacement",
            payload: { content: "duplicate", role: "user" },
            seq: 1,
            sessionId: SESSION_ID,
          },
        ])
      ).rejects.toThrow();
      expect(
        (await database.adapter.listMessagesForSession(SESSION_ID)).map(
          (message) => message.id
        )
      ).toEqual(["msg_keep"]);
    } finally {
      database.close();
    }
  });
});
