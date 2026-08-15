import { beforeAll, describe, expect, test } from "bun:test";
import { createSqliteDatabase, type SqliteDatabase } from "@atlas/db";
import { createConversationTools } from "./conversation-tools";

let database: SqliteDatabase;
let searchChatsTool: any;
let getConversationTool: any;

beforeAll(async () => {
  database = await createSqliteDatabase(":memory:");
  const now = new Date().toISOString();

  await database.adapter.upsertOrganization({
    createdAt: now,
    id: "org-alpha",
    name: "Org Alpha",
    slug: "org-alpha",
    updatedAt: now,
  });
  await database.adapter.upsertOrganization({
    createdAt: now,
    id: "org-beta",
    name: "Org Beta",
    slug: "org-beta",
    updatedAt: now,
  });

  await database.adapter.createUser({
    createdAt: now,
    email: "user1@test.com",
    id: "user-1",
    name: "User 1",
    passwordHash: "hash",
    role: "admin",
    updatedAt: now,
  });

  await database.adapter.upsertProfile({
    createdAt: now,
    id: "prof-1",
    isSuper: false,
    model: null,
    name: "Test Profile",
    orgId: "org-alpha",
    systemPrompt: "You are a helpful assistant.",
    updatedAt: now,
  });

  const tools = createConversationTools(database.adapter);
  searchChatsTool = tools.find((t) => t.name === "search_chats");
  getConversationTool = tools.find((t) => t.name === "get_conversation");
});

describe("Conversation Retrieval Tools", () => {
  test("searches past chats and retrieves conversation transcript", async () => {
    const orgId = "org-alpha";
    const sessionId = "session_titan_123";
    const now = new Date().toISOString();

    // 1. Seed session and messages
    await database.adapter.upsertSession({
      channel: "web",
      createdAt: now,
      id: sessionId,
      orgId,
      profileId: "prof-1",
      title: "Project Titan Planning",
      updatedAt: now,
      userId: "user-1",
    });

    await database.adapter.updateSessionTitle(
      sessionId,
      "Project Titan Planning"
    );

    await database.adapter.appendMessagesForSession(sessionId, [
      {
        createdAt: now,
        id: "msg-1",
        payload: { content: "When are we launching Titan?", role: "user" },
        seq: 1,
      },
      {
        createdAt: now,
        id: "msg-2",
        payload: {
          content: "We decided project Titan launch date is November 15.",
          role: "assistant",
        },
        seq: 2,
      },
    ]);

    // 2. Search chats for 'November 15'
    const searchRes = await searchChatsTool.run(
      { query: "November 15" },
      { orgId, userId: "user-1" }
    );

    expect(searchRes.count).toBeGreaterThan(0);
    expect(searchRes.results[0].sessionId).toBe(sessionId);
    expect(searchRes.results[0].matchedSnippet).toContain("November 15");

    // 3. Get conversation transcript
    const convRes = await getConversationTool.run(
      { sessionId },
      { orgId, userId: "user-1" }
    );

    expect(convRes.sessionId).toBe(sessionId);
    expect(convRes.title).toBe("Project Titan Planning");
    expect(convRes.messages.length).toBe(2);
    expect(convRes.messages[1].text).toContain("November 15");
  });

  test("enforces tenant isolation preventing Org B from searching Org A chats", async () => {
    const searchOrgB = await searchChatsTool.run(
      { query: "Titan" },
      { orgId: "org-beta", userId: "user-2" }
    );

    expect(searchOrgB.count).toBe(0);

    await expect(
      getConversationTool.run(
        { sessionId: "session_titan_123" },
        { orgId: "org-beta", userId: "user-2" }
      )
    ).rejects.toThrow(/not found or access is denied/);
  });
});
