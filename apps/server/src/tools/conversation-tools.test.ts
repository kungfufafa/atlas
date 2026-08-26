import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ToolContext, ToolDefinition } from "@atlas/core";
import { createSqliteDatabase, type SqliteDatabase } from "@atlas/db";
import { createConversationTools } from "./conversation-tools";

const ORG_ALPHA = "org-alpha";
const ORG_BETA = "org-beta";
const USER_ONE = "user-1";
const USER_TWO = "user-2";
const REGULAR_PROFILE = "prof-regular-alpha";
const SUPER_PROFILE = "prof-super-alpha";
const BETA_PROFILE = "prof-regular-beta";
const OWN_SESSION = "session-own-regular";
const OTHER_USER_SESSION = "session-other-user";
const OWN_SUPER_SESSION = "session-own-super";
const OTHER_ORG_SESSION = "session-other-org";

let database: SqliteDatabase;
let searchChatsTool: ToolDefinition;
let getConversationTool: ToolDefinition;

function toolContext(
  orgRole: ToolContext["orgRole"],
  overrides: Partial<ToolContext> = {}
): ToolContext {
  return {
    orgId: ORG_ALPHA,
    orgRole,
    userId: USER_ONE,
    ...overrides,
  };
}

function requireTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing conversation tool: ${name}`);
  }
  return tool;
}

async function addSession(options: {
  content: string;
  id: string;
  orgId: string;
  profileId: string;
  title: string;
  userId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await database.adapter.upsertSession({
    agentQuestionnaire: null,
    agentTodos: [],
    channel: "web",
    createdAt: now,
    id: options.id,
    modelOverride: null,
    orgId: options.orgId,
    profileId: options.profileId,
    title: null,
    userId: options.userId,
  });
  await database.adapter.updateSessionTitle(options.id, options.title);
  await database.adapter.appendMessagesForSession(options.id, [
    {
      createdAt: now,
      id: `${options.id}-message`,
      payload: { content: options.content, role: "user" },
      seq: 1,
      sessionId: options.id,
    },
  ]);
}

beforeAll(async () => {
  database = await createSqliteDatabase(":memory:");
  const now = new Date().toISOString();

  for (const [id, name] of [
    [ORG_ALPHA, "Org Alpha"],
    [ORG_BETA, "Org Beta"],
  ] as const) {
    await database.adapter.upsertOrganization({
      createdAt: now,
      id,
      name,
      slug: id,
      updatedAt: now,
    });
  }

  for (const [id, email] of [
    [USER_ONE, "user1@test.com"],
    [USER_TWO, "user2@test.com"],
  ] as const) {
    await database.adapter.createUser({
      createdAt: now,
      email,
      id,
      name: id,
      passwordHash: "hash",
      role: "admin",
      updatedAt: now,
    });
  }

  for (const profile of [
    { id: REGULAR_PROFILE, isSuper: false, orgId: ORG_ALPHA },
    { id: SUPER_PROFILE, isSuper: true, orgId: ORG_ALPHA },
    { id: BETA_PROFILE, isSuper: false, orgId: ORG_BETA },
  ]) {
    await database.adapter.upsertProfile({
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

  await addSession({
    content: "Atlas launch decision belongs to user one.",
    id: OWN_SESSION,
    orgId: ORG_ALPHA,
    profileId: REGULAR_PROFILE,
    title: "Owned planning",
    userId: USER_ONE,
  });
  await addSession({
    content: "Atlas private decision belongs to user two.",
    id: OTHER_USER_SESSION,
    orgId: ORG_ALPHA,
    profileId: REGULAR_PROFILE,
    title: "Other user planning",
    userId: USER_TWO,
  });
  await addSession({
    content: "Atlas super-secret decision belongs to Super Agent.",
    id: OWN_SUPER_SESSION,
    orgId: ORG_ALPHA,
    profileId: SUPER_PROFILE,
    title: "Super planning",
    userId: USER_ONE,
  });
  await addSession({
    content: "Atlas beta decision belongs to another workspace.",
    id: OTHER_ORG_SESSION,
    orgId: ORG_BETA,
    profileId: BETA_PROFILE,
    title: "Beta planning",
    userId: USER_TWO,
  });

  const tools = createConversationTools(database.adapter);
  searchChatsTool = requireTool(tools, "search_chats");
  getConversationTool = requireTool(tools, "get_conversation");
});

afterAll(() => {
  database.close();
});

describe("conversation retrieval tools", () => {
  test("searches and retrieves the caller's own regular conversation", async () => {
    const searchResult = (await searchChatsTool.run(
      { query: "launch decision" },
      toolContext("member")
    )) as { count: number; results: Array<{ sessionId: string }> };

    expect(searchResult.count).toBe(1);
    expect(searchResult.results[0]?.sessionId).toBe(OWN_SESSION);

    const conversation = (await getConversationTool.run(
      { sessionId: OWN_SESSION },
      toolContext("member")
    )) as {
      messages: Array<{ text: string }>;
      sessionId: string;
      title: string;
    };

    expect(conversation.sessionId).toBe(OWN_SESSION);
    expect(conversation.title).toBe("Owned planning");
    expect(conversation.messages[0]?.text).toContain("user one");
  });

  test("direct retrieval cannot read another user's session in the same org", async () => {
    await expect(
      getConversationTool.run(
        { sessionId: OTHER_USER_SESSION },
        toolContext("member")
      )
    ).rejects.toThrow(/not found or access is denied/);

    const searchResult = (await searchChatsTool.run(
      { query: "private decision" },
      toolContext("member")
    )) as { count: number };
    expect(searchResult.count).toBe(0);
  });

  test("org admin remains user-scoped at the tool boundary", async () => {
    await expect(
      getConversationTool.run(
        { sessionId: OTHER_USER_SESSION },
        toolContext("admin")
      )
    ).rejects.toThrow(/not found or access is denied/);
  });

  test("member cannot search or retrieve Super Agent history", async () => {
    const searchResult = (await searchChatsTool.run(
      { query: "super-secret" },
      toolContext("member")
    )) as { count: number };
    expect(searchResult.count).toBe(0);

    await expect(
      getConversationTool.run(
        { sessionId: OWN_SUPER_SESSION },
        toolContext("member")
      )
    ).rejects.toThrow(/not found or access is denied/);
  });

  test("org and platform admins can retrieve their own Super Agent history", async () => {
    const orgAdminResult = (await getConversationTool.run(
      { sessionId: OWN_SUPER_SESSION },
      toolContext("admin")
    )) as { sessionId: string };
    expect(orgAdminResult.sessionId).toBe(OWN_SUPER_SESSION);

    const platformAdminResult = (await getConversationTool.run(
      { sessionId: OWN_SUPER_SESSION },
      toolContext("member", { isPlatformAdmin: true })
    )) as { sessionId: string };
    expect(platformAdminResult.sessionId).toBe(OWN_SUPER_SESSION);
  });

  test("cannot search or retrieve conversation history across orgs", async () => {
    const searchResult = (await searchChatsTool.run(
      { query: "launch decision" },
      toolContext("member", { orgId: ORG_BETA, userId: USER_TWO })
    )) as { count: number };
    expect(searchResult.count).toBe(0);

    await expect(
      getConversationTool.run(
        { sessionId: OWN_SESSION },
        toolContext("member", { orgId: ORG_BETA, userId: USER_TWO })
      )
    ).rejects.toThrow(/not found or access is denied/);
  });
});
