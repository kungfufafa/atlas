import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
import { createSqliteDatabase, type SqliteDatabase } from "./adapters/sqlite";
import type {
  DatabaseAdapter,
  StoredSessionHistoryArchiveRecord,
} from "./types";

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

    test("retrieves compacted evidence without adding archives to active model history", async () => {
      const active = await adapter.listMessagesForSession(OWN_SESSION);
      const archive: StoredSessionHistoryArchiveRecord = {
        createdAt: "2026-09-06T00:00:00.000Z",
        id: "archive-owned",
        messages: [
          { content: "Inspect deployment", role: "user" },
          {
            content: "deploy-evidence release 42 succeeded",
            name: "deploy",
            role: "tool",
            toolCallId: "deploy-42",
          },
        ],
        sessionId: OWN_SESSION,
      };
      await adapter.replaceMessagesForSession(OWN_SESSION, active, [archive]);
      await adapter.replaceMessagesForSession(OWN_SESSION, active, [archive]);
      expect(await adapter.listMessagesForSession(OWN_SESSION)).toEqual(active);
      const matches = await adapter.searchConversationMessages(
        ORG_A,
        "deploy-evidence",
        { userId: USER_A }
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.archiveId).toBe(archive.id);
      const retrieved = await adapter.getConversationHistory(
        ORG_A,
        OWN_SESSION,
        { archiveId: archive.id, limit: 1, offset: 1, userId: USER_A }
      );
      expect(retrieved?.messages[0]?.text).toBe(
        "deploy-evidence release 42 succeeded"
      );
      expect(retrieved?.totalMessages).toBe(2);
      expect(retrieved?.archiveId).toBe(archive.id);
      expect(
        (await adapter.getConversationHistory(ORG_A, OWN_SESSION))
          ?.totalMessages
      ).toBe(1);
    });

    test("archive retrieval and search enforce tenant, owner, and Super Agent boundaries", async () => {
      for (const sessionId of [
        OWN_SESSION,
        OTHER_USER_SESSION,
        SUPER_SESSION,
        OTHER_ORG_SESSION,
      ]) {
        await adapter.replaceMessagesForSession(
          sessionId,
          await adapter.listMessagesForSession(sessionId),
          [
            {
              createdAt: "2026-09-06T00:00:00.000Z",
              id: `archive-scope-${sessionId}`,
              messages: [
                { content: `archived-scope-marker ${sessionId}`, role: "user" },
              ],
              sessionId,
            },
          ]
        );
      }
      const matches = await adapter.searchConversationMessages(
        ORG_A,
        "archived-scope-marker",
        { excludeSuperAgent: true, userId: USER_A }
      );
      expect(matches.map((match) => match.sessionId)).toEqual([OWN_SESSION]);
      for (const sessionId of [
        OTHER_USER_SESSION,
        SUPER_SESSION,
        OTHER_ORG_SESSION,
      ]) {
        expect(
          await adapter.getConversationHistory(ORG_A, sessionId, {
            archiveId: `archive-scope-${sessionId}`,
            excludeSuperAgent: true,
            userId: USER_A,
          })
        ).toBeNull();
      }
      expect(
        await adapter.getConversationHistory(ORG_A, OWN_SESSION, {
          archiveId: `archive-scope-${OTHER_USER_SESSION}`,
          userId: USER_A,
        })
      ).toBeNull();
    });

    test("archive replacement is atomic and rejects changes to an immutable snapshot", async () => {
      const active = await adapter.listMessagesForSession(OWN_SESSION);
      const archive: StoredSessionHistoryArchiveRecord = {
        createdAt: "2026-09-06T00:00:00.000Z",
        id: "archive-atomic",
        messages: [{ content: "atomic-archive-original", role: "user" }],
        sessionId: OWN_SESSION,
      };
      await expect(
        adapter.replaceMessagesForSession(
          OWN_SESSION,
          [],
          [
            archive,
            {
              ...archive,
              id: "archive-wrong-session",
              sessionId: OTHER_ORG_SESSION,
            },
          ]
        )
      ).rejects.toThrow();
      expect(await adapter.listMessagesForSession(OWN_SESSION)).toEqual(active);
      expect(
        await adapter.getConversationHistory(ORG_A, OWN_SESSION, {
          archiveId: archive.id,
        })
      ).toBeNull();
      await adapter.replaceMessagesForSession(OWN_SESSION, active, [archive]);
      await expect(
        adapter.replaceMessagesForSession(
          OWN_SESSION,
          [],
          [{ ...archive, messages: [] }]
        )
      ).rejects.toThrow();
      expect(await adapter.listMessagesForSession(OWN_SESSION)).toEqual(active);
      expect(
        (
          await adapter.getConversationHistory(ORG_A, OWN_SESSION, {
            archiveId: archive.id,
          })
        )?.totalMessages
      ).toBe(1);
    });

    test.each(["clear", "delete"])(
      "%s removes archived history as well as active messages",
      async (operation) => {
        const sessionId = `archive-cleanup-${operation}`;
        await adapter.upsertSession({
          agentQuestionnaire: null,
          agentTodos: [],
          channel: "web",
          createdAt: "2026-09-06T00:00:00.000Z",
          id: sessionId,
          modelOverride: null,
          orgId: ORG_A,
          profileId: PROFILE_A,
          title: null,
          userId: USER_A,
        });
        const archiveId = `archive-${sessionId}`;
        await adapter.replaceMessagesForSession(
          sessionId,
          [],
          [
            {
              createdAt: "2026-09-06T00:00:00.000Z",
              id: archiveId,
              messages: [
                { content: `cleanup-marker-${operation}`, role: "user" },
              ],
              sessionId,
            },
          ]
        );
        if (operation === "clear") {
          await adapter.deleteMessagesForSession(sessionId);
        } else {
          await adapter.deleteSession(sessionId);
        }
        expect(
          await adapter.searchConversationMessages(
            ORG_A,
            `cleanup-marker-${operation}`
          )
        ).toEqual([]);
        expect(
          await adapter.getConversationHistory(ORG_A, sessionId, { archiveId })
        ).toBeNull();
      }
    );
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
