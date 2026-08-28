import { describe, expect, test } from "bun:test";
import type { AgentChatSession, AgentHarness } from "@atlas/agent";
import type { ToolContext } from "@atlas/core";
import { LOCAL_CLIENT_USER_ID } from "@atlas/core/local-auth";
import { createInMemoryDatabaseAdapter, type DatabaseAdapter } from "@atlas/db";
import { createMemoryTools } from "../tools/memory-tools";
import { AgentService } from "./agent-service";
import { MemoryService } from "./memory-service";

const ORG_ID = "org_channel_principal";
const PROFILE_ID = "profile_channel_principal";
const MEMBER_ID = "user_channel_member";
const ADMIN_ID = "user_channel_admin";
const CHANNEL_USER_ID = "15551234567";

async function seedWorkspace(db: DatabaseAdapter): Promise<void> {
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Channel principal",
    slug: "channel-principal",
    updatedAt: now,
  });
  await db.upsertProfile({
    createdAt: now,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Default",
    orgId: ORG_ID,
    systemPrompt: "You are helpful.",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "member@example.com",
    id: MEMBER_ID,
    name: "Member",
    passwordHash: "x",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "admin@example.com",
    id: ADMIN_ID,
    name: "Admin",
    passwordHash: "x",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "local-client@atlas.local",
    id: LOCAL_CLIENT_USER_ID,
    name: "Local client",
    passwordHash: "x",
    updatedAt: now,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role: "member",
    userId: MEMBER_ID,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role: "admin",
    userId: ADMIN_ID,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role: "admin",
    userId: LOCAL_CLIENT_USER_ID,
  });
  await db.upsertChannelOrgMapping({
    channel: "whatsapp",
    channelUserId: CHANNEL_USER_ID,
    createdAt: now,
    orgId: ORG_ID,
    userId: MEMBER_ID,
  });
}

function captureSessionToolContext(service: AgentService): {
  read: () => ToolContext | undefined;
} {
  let toolContext: ToolContext | undefined;
  const history: never[] = [];
  const session: AgentChatSession = {
    clear() {
      history.length = 0;
    },
    async compact() {
      return {
        action: "none",
        messagesAfter: history.length,
        messagesBefore: history.length,
      };
    },
    async createAutomation() {
      throw new Error("not used");
    },
    getContextUsage: () => null,
    getHistory: () => history,
    getHistoryRevision: () => 0,
    send: async () => "unused",
    sendStream: async () => "unused",
  };
  (
    service as unknown as {
      createHarnessForProfile: () => AgentHarness;
    }
  ).createHarnessForProfile = () => ({
    async createAutomationFromPrompt() {
      throw new Error("not used");
    },
    createChatSession(options) {
      toolContext = options?.toolContext;
      return session;
    },
  });
  return { read: () => toolContext };
}

function workerAccess() {
  return {
    excludeSuperAgent: true,
    externalPrincipal: { channelUserId: CHANNEL_USER_ID },
    isPlatformAdmin: false,
    orgRole: "admin" as const,
  };
}

describe("AgentService channel worker principal", () => {
  test("WhatsApp turns keep the mapped member role, not the local-client admin", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedWorkspace(db);
    const service = new AgentService(null, null, db);
    const captured = captureSessionToolContext(service);

    const sessionId = await service.createSession(
      ORG_ID,
      "whatsapp",
      PROFILE_ID,
      LOCAL_CLIENT_USER_ID,
      workerAccess()
    );

    const created = captured.read();
    expect(created?.userId).toBe(MEMBER_ID);
    expect(created?.orgRole).toBe("member");
    expect(created?.isPlatformAdmin).toBe(false);

    expect(
      await service.resolveSession(ORG_ID, sessionId, {
        isPlatformAdmin: false,
        orgRole: "admin",
        userId: LOCAL_CLIENT_USER_ID,
      })
    ).not.toBeNull();

    expect(captured.read()?.userId).toBe(MEMBER_ID);
    expect(captured.read()?.orgRole).toBe("member");

    const restarted = new AgentService(null, null, db);
    const restartedCapture = captureSessionToolContext(restarted);
    expect(
      await restarted.resolveSession(ORG_ID, sessionId, {
        isPlatformAdmin: false,
        orgRole: "admin",
        userId: LOCAL_CLIENT_USER_ID,
      })
    ).not.toBeNull();
    expect(restartedCapture.read()?.userId).toBe(MEMBER_ID);
    expect(restartedCapture.read()?.orgRole).toBe("member");
    expect(restartedCapture.read()?.isPlatformAdmin).toBe(false);
  });

  test("mapped member cannot write organization memory on a channel turn", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedWorkspace(db);
    const service = new AgentService(null, null, db);
    const captured = captureSessionToolContext(service);

    const sessionId = await service.createSession(
      ORG_ID,
      "whatsapp",
      PROFILE_ID,
      LOCAL_CLIENT_USER_ID,
      workerAccess()
    );
    await service.resolveSession(ORG_ID, sessionId, {
      isPlatformAdmin: false,
      orgRole: "admin",
      userId: LOCAL_CLIENT_USER_ID,
    });

    const write = createMemoryTools(new MemoryService(db)).find(
      (tool) => tool.name === "memory_write"
    );
    if (!write) {
      throw new Error("missing memory_write");
    }

    await expect(
      write.run(
        { content: "planted org holiday", scope: "organization" },
        captured.read() ?? {}
      )
    ).rejects.toThrow("Workspace Admin access required");
  });

  test("mapped admin still gets workspace-admin tools on a channel turn", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedWorkspace(db);
    const now = new Date().toISOString();
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: "admin-wa",
      createdAt: now,
      orgId: ORG_ID,
      userId: ADMIN_ID,
    });
    const service = new AgentService(null, null, db);
    const captured = captureSessionToolContext(service);

    await service.createSession(
      ORG_ID,
      "whatsapp",
      PROFILE_ID,
      LOCAL_CLIENT_USER_ID,
      {
        excludeSuperAgent: true,
        externalPrincipal: { channelUserId: "admin-wa" },
        isPlatformAdmin: false,
        orgRole: "admin",
      }
    );

    expect(captured.read()?.userId).toBe(ADMIN_ID);
    expect(captured.read()?.orgRole).toBe("admin");
  });

  test("channel worker cannot reopen a Super Agent session owned by a member", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedWorkspace(db);
    const now = new Date().toISOString();
    await db.upsertProfile({
      createdAt: now,
      id: "profile_super",
      isDefault: false,
      isSuper: true,
      model: null,
      name: "Super Agent",
      orgId: ORG_ID,
      systemPrompt: "You are Super Agent.",
      updatedAt: now,
    });
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "whatsapp",
      createdAt: now,
      id: "session_super_member",
      modelOverride: null,
      orgId: ORG_ID,
      profileId: "profile_super",
      title: null,
      userId: MEMBER_ID,
    });
    const service = new AgentService(null, null, db);

    await expect(
      service.resolveSession(ORG_ID, "session_super_member", {
        isPlatformAdmin: false,
        orgRole: "admin",
        userId: LOCAL_CLIENT_USER_ID,
      })
    ).rejects.toMatchObject({ status: 403 });
  });
});
