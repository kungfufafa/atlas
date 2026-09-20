import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteDatabase,
  type DatabaseAdapter,
  type SqliteDatabase,
} from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";

setupTestConfigDir("atlas-session-chat-kind-service-");

const ORG_ID = "org_chat_kind";
const PROFILE_ID = "profile_chat_kind";
const USER_ID = "user_chat_kind";

async function seed(db: DatabaseAdapter): Promise<void> {
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Kind",
    slug: "kind",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "kind@example.test",
    id: USER_ID,
    name: "Kind",
    passwordHash: "unused",
    updatedAt: now,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role: "member",
    userId: USER_ID,
  });
  await db.upsertChannelOrgMapping({
    channel: "whatsapp",
    channelUserId: "wa-group-1",
    createdAt: now,
    orgId: ORG_ID,
    userId: USER_ID,
  });
  await db.upsertProfile({
    createdAt: now,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Kind",
    orgId: ORG_ID,
    systemPrompt: "You are helpful.",
    updatedAt: now,
  });
}

describe("AgentService chatKind persistence", () => {
  let sqlite: SqliteDatabase | undefined;
  afterEach(() => sqlite?.close());

  test("persists chatKind and reloads it after a cold rebuild", async () => {
    sqlite = await createSqliteDatabase(
      join(await mkdtemp(join(tmpdir(), "atlas-agent-chat-kind-")), "app.db")
    );
    const db = sqlite.adapter;
    await seed(db);
    const service = new AgentService(null, null, db);
    const sessionId = await service.createSession(
      ORG_ID,
      "whatsapp",
      PROFILE_ID,
      USER_ID,
      {
        externalPrincipal: {
          channelIsGroup: true,
          channelUserId: "wa-group-1",
        },
        orgRole: "member",
      }
    );
    expect((await db.getSession(sessionId))?.chatKind).toBe("group");

    service.invalidateSessionsForOrg(ORG_ID);
    const rebuilt = new AgentService(null, null, db);
    const session = await rebuilt.resolveSession(ORG_ID, sessionId, {
      orgRole: "member",
      userId: USER_ID,
    });
    expect(session).not.toBeNull();
    const stored = (
      rebuilt as unknown as {
        sessions: Map<string, { chatKind?: "group" | "private" }>;
      }
    ).sessions.get(sessionId);
    expect(stored?.chatKind).toBe("group");
  });
});
