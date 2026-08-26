import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
import { createSqliteDatabase, type SqliteDatabase } from "./adapters/sqlite";
import type { DatabaseAdapter } from "./types";

const ORG_A = "conversation-org-a";
const ORG_B = "conversation-org-b";
const USER_A = "conversation-user-a";
const USER_B = "conversation-user-b";
const PROFILE_A = "conversation-profile-a";
const SUPER_PROFILE_A = "conversation-super-profile-a";
const PROFILE_B = "conversation-profile-b";
const OWN_SESSION = "conversation-own-session";
const OTHER_USER_SESSION = "conversation-other-user-session";
const SUPER_SESSION = "conversation-super-session";
const OTHER_ORG_SESSION = "conversation-other-org-session";

async function seedConversations(db: DatabaseAdapter): Promise<void> {
  const now = "2026-08-26T00:00:00.000Z";
  for (const orgId of [ORG_A, ORG_B]) {
    await db.upsertOrganization({
      createdAt: now,
      id: orgId,
      name: orgId,
      slug: orgId,
      updatedAt: now,
    });
  }
  for (const userId of [USER_A, USER_B]) {
    await db.createUser({
      createdAt: now,
      email: `${userId}@example.com`,
      id: userId,
      name: userId,
      passwordHash: "hash",
      role: "user",
      updatedAt: now,
    });
  }
  for (const profile of [
    { id: PROFILE_A, isSuper: false, orgId: ORG_A },
    { id: SUPER_PROFILE_A, isSuper: true, orgId: ORG_A },
    { id: PROFILE_B, isSuper: false, orgId: ORG_B },
  ]) {
    await db.upsertProfile({
      createdAt: now,
      id: profile.id,
      isSuper: profile.isSuper,
      model: null,
      name: profile.id,
      orgId: profile.orgId,
      systemPrompt: "",
      updatedAt: now,
    });
  }

  const sessions = [
    {
      id: OWN_SESSION,
      orgId: ORG_A,
      profileId: PROFILE_A,
      text: "shared-marker owned",
      userId: USER_A,
    },
    {
      id: OTHER_USER_SESSION,
      orgId: ORG_A,
      profileId: PROFILE_A,
      text: "shared-marker other user",
      userId: USER_B,
    },
    {
      id: SUPER_SESSION,
      orgId: ORG_A,
      profileId: SUPER_PROFILE_A,
      text: "shared-marker super",
      userId: USER_A,
    },
    {
      id: OTHER_ORG_SESSION,
      orgId: ORG_B,
      profileId: PROFILE_B,
      text: "shared-marker other org",
      userId: USER_A,
    },
  ];

  for (const session of sessions) {
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "web",
      createdAt: now,
      id: session.id,
      modelOverride: null,
      orgId: session.orgId,
      profileId: session.profileId,
      title: null,
      userId: session.userId,
    });
    await db.appendMessagesForSession(session.id, [
      {
        createdAt: now,
        id: `${session.id}-message`,
        payload: { content: session.text, role: "user" },
        seq: 1,
        sessionId: session.id,
      },
    ]);
  }
}

function conversationAdapterContract(
  name: string,
  createAdapter: () => Promise<{
    adapter: DatabaseAdapter;
    close(): void;
  }>
): void {
  describe(name, () => {
    let adapter: DatabaseAdapter;
    let close: () => void;

    beforeAll(async () => {
      const database = await createAdapter();
      adapter = database.adapter;
      close = database.close;
      await seedConversations(adapter);
    });

    afterAll(() => {
      close();
    });

    test("direct history applies optional caller ownership without narrowing trusted org reads", async () => {
      expect(
        await adapter.getConversationHistory(ORG_A, OWN_SESSION, {
          userId: USER_A,
        })
      ).not.toBeNull();
      expect(
        await adapter.getConversationHistory(ORG_A, OTHER_USER_SESSION, {
          userId: USER_A,
        })
      ).toBeNull();
      expect(
        await adapter.getConversationHistory(ORG_B, OWN_SESSION, {
          userId: USER_A,
        })
      ).toBeNull();

      expect(
        await adapter.getConversationHistory(ORG_A, OTHER_USER_SESSION)
      ).not.toBeNull();
    });

    test("search and direct history share user and Super Agent filters", async () => {
      expect(
        await adapter.getConversationHistory(ORG_A, SUPER_SESSION, {
          excludeSuperAgent: true,
          userId: USER_A,
        })
      ).toBeNull();

      const restricted = await adapter.searchConversationMessages(
        ORG_A,
        "shared-marker",
        { excludeSuperAgent: true, userId: USER_A }
      );
      expect(restricted.map((result) => result.sessionId)).toEqual([
        OWN_SESSION,
      ]);

      const superAllowed = await adapter.searchConversationMessages(
        ORG_A,
        "shared-marker",
        { userId: USER_A }
      );
      expect(new Set(superAllowed.map((result) => result.sessionId))).toEqual(
        new Set([OWN_SESSION, SUPER_SESSION])
      );
    });
  });
}

conversationAdapterContract(
  "SQLite conversation history authorization",
  async () => {
    const database: SqliteDatabase = await createSqliteDatabase(":memory:");
    return database;
  }
);

conversationAdapterContract(
  "in-memory conversation history authorization",
  async () => ({
    adapter: createInMemoryDatabaseAdapter(),
    close() {},
  })
);
