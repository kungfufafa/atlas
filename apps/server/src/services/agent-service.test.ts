import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureBundledSkillFiles } from "@atlas/core";
import { LOCAL_CLIENT_USER_ID } from "@atlas/core/local-auth";
import type { StoredProfileRecord } from "@atlas/db";
import {
  createInMemoryDatabaseAdapter,
  createSqliteDatabase,
  WORKSPACE_SETTINGS_ID,
} from "@atlas/db";
import { AgentService } from "./agent-service";
import { sessionTurnRegistry } from "./session-turn-registry";
import { SkillsService } from "./skills-service";

const ORG_ID = "org_test";

function createDefaultProfile(): StoredProfileRecord {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    id: "profile_default",
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Default",
    orgId: ORG_ID,
    systemPrompt: "You are helpful.",
    updatedAt: now,
  };
}

describe("AgentService long-lived channel runtime", () => {
  let tempConfigDir = "";
  const previousConfigDir = process.env.ATLAS_CONFIG_DIR;

  afterEach(async () => {
    if (previousConfigDir === undefined) {
      delete process.env.ATLAS_CONFIG_DIR;
    } else {
      process.env.ATLAS_CONFIG_DIR = previousConfigDir;
    }

    if (tempConfigDir) {
      await rm(tempConfigDir, { force: true, recursive: true });
      tempConfigDir = "";
    }
  });

  test("rebuilds a WhatsApp session after its knowledge base changes", async () => {
    tempConfigDir = await mkdtemp(path.join(tmpdir(), "atlas-channel-kb-"));
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const db = createInMemoryDatabaseAdapter();
    await db.upsertProfile(createDefaultProfile());
    const now = new Date().toISOString();
    await db.createUser({
      createdAt: now,
      email: "ada@example.com",
      id: "user_1",
      name: "Ada",
      passwordHash: "x",
      updatedAt: now,
    });
    const service = new AgentService(null, null, db);
    const sessionId = await service.createSession(
      ORG_ID,
      "whatsapp",
      "profile_default",
      "user_1",
      { orgRole: "member" }
    );
    const beforeUpload = await service.resolveSession(ORG_ID, sessionId);

    await service.uploadKnowledgeBaseDocument(ORG_ID, "profile_default", {
      data: Buffer.from("WhatsApp must see this fact", "utf8").toString(
        "base64"
      ),
      filename: "channel-facts.txt",
      mediaType: "text/plain",
    });

    const afterUpload = await service.resolveSession(ORG_ID, sessionId);

    expect(beforeUpload).not.toBeNull();
    expect(afterUpload).not.toBeNull();
    expect(afterUpload).not.toBe(beforeUpload);
    expect((await db.getSession(sessionId))?.channel).toBe("whatsapp");
  });
});

describe("AgentService branching", () => {
  test("branches a new session from the selected message index", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertProfile(createDefaultProfile());
    const service = new AgentService(null, null, db);

    const sourceSessionId = await service.createSession(
      ORG_ID,
      "web",
      "profile_default"
    );
    await db.replaceMessagesForSession(sourceSessionId, [
      {
        createdAt: "2026-06-14T10:00:00.000Z",
        id: "msg_1",
        payload: { content: "Hello", role: "user" },
        seq: 0,
        sessionId: sourceSessionId,
      },
      {
        createdAt: "2026-06-14T10:00:01.000Z",
        id: "msg_2",
        payload: { content: "Hi there", role: "assistant" },
        seq: 1,
        sessionId: sourceSessionId,
      },
      {
        createdAt: "2026-06-14T10:00:02.000Z",
        id: "msg_3",
        payload: { content: "Second turn", role: "user" },
        seq: 2,
        sessionId: sourceSessionId,
      },
    ]);
    await db.updateSessionTitle(sourceSessionId, "Original chat");
    await db.updateSessionTodos(sourceSessionId, [
      {
        content: "Keep this out of the branch",
        id: "todo_1",
        status: "pending",
      },
    ]);
    await db.updateSessionQuestionnaire(sourceSessionId, {
      id: "q_1",
      questions: [
        {
          allowCustomAnswer: true,
          choices: [],
          id: "timeline",
          prompt: "When?",
        },
      ],
      title: "Need input",
    });

    const result = await service.branchSession(ORG_ID, sourceSessionId, 1);

    expect(result).not.toBeNull();
    const branchSessionId = result!.sessionId;

    const branchMessages = await service.getSessionMessages(
      ORG_ID,
      branchSessionId
    );
    expect(branchMessages?.messages).toEqual([
      { content: "Hello", role: "user" },
      { content: "Hi there", role: "assistant" },
    ]);
    expect(branchMessages?.messageMeta).toHaveLength(2);

    const branchTodos = await service.getSessionTodos(ORG_ID, branchSessionId);
    expect(branchTodos).toEqual([]);
    expect(
      await service.getSessionQuestionnaire(ORG_ID, branchSessionId)
    ).toBeNull();

    const branchRecord = await db.getSession(branchSessionId);
    expect(branchRecord?.profileId).toBe("profile_default");
    expect(branchRecord?.channel).toBe("web");
    expect(branchRecord?.title).toBe("Original chat (Branch)");

    const sourceMessages = await service.getSessionMessages(
      ORG_ID,
      sourceSessionId
    );
    expect(sourceMessages?.messages).toHaveLength(3);
  });

  test("rejects an out-of-range branch index", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertProfile(createDefaultProfile());
    const service = new AgentService(null, null, db);

    const sourceSessionId = await service.createSession(
      ORG_ID,
      "web",
      "profile_default"
    );
    await db.replaceMessagesForSession(sourceSessionId, [
      {
        createdAt: "2026-06-14T10:00:00.000Z",
        id: "msg_1",
        payload: { content: "Hello", role: "user" },
        seq: 0,
        sessionId: sourceSessionId,
      },
    ]);

    await expect(
      service.branchSession(ORG_ID, sourceSessionId, 3)
    ).rejects.toThrow("messageIndex is out of bounds.");
  });

  test("does not expose a session through another workspace", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertProfile(createDefaultProfile());
    await db.upsertProfile({
      ...createDefaultProfile(),
      id: "profile_other",
      orgId: "org_other",
    });
    const service = new AgentService(null, null, db);
    const sessionId = await service.createSession(
      ORG_ID,
      "web",
      "profile_default"
    );

    expect(await service.getSessionMessages("org_other", sessionId)).toBeNull();
    expect(await service.clearSession("org_other", sessionId)).toBe(false);
    expect(await service.purgeSession("org_other", sessionId)).toBe(false);
    expect(await service.resolveSession("org_other", sessionId)).toBeNull();
    expect(await service.resolveSession(ORG_ID, sessionId)).not.toBeNull();
  });

  test("falls back to org default when the requested profile is missing", async () => {
    const database = await createSqliteDatabase(":memory:");
    const db = database.adapter;
    const now = new Date().toISOString();

    try {
      await db.upsertOrganization({
        createdAt: now,
        id: ORG_ID,
        name: "Test Org",
        slug: "test-org",
        updatedAt: now,
      });

      await db.upsertProfile({
        createdAt: now,
        id: "profile_custom",
        isDefault: true,
        isSuper: false,
        model: null,
        name: "Custom",
        orgId: ORG_ID,
        systemPrompt: "You are helpful.",
        updatedAt: now,
      });

      const service = new AgentService(null, null, db);
      const sessionId = await service.createSession(
        ORG_ID,
        "web",
        "missing_profile"
      );
      const session = await db.getSession(sessionId);

      expect(session?.profileId).toBe("profile_custom");
    } finally {
      database.close();
    }
  });

  test("refuses compact while a turn is in progress", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertProfile(createDefaultProfile());
    const service = new AgentService(null, null, db);
    const sessionId = await service.createSession(
      ORG_ID,
      "web",
      "profile_default"
    );
    sessionTurnRegistry.beginTurn(sessionId);
    try {
      await expect(
        service.compactSession(ORG_ID, sessionId, { force: true })
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      sessionTurnRegistry.endTurn(sessionId, { reply: "ok", type: "done" });
    }
  });

  test("rejects Super Agent session turns after the caller is demoted", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: ORG_ID,
      name: "Test Org",
      slug: "test-org",
      updatedAt: now,
    });
    await db.createUser({
      createdAt: now,
      email: "admin@example.com",
      id: "user_admin",
      name: "Admin",
      passwordHash: "x",
      updatedAt: now,
    });
    await db.createUser({
      createdAt: now,
      email: "member@example.com",
      id: "user_member",
      name: "Member",
      passwordHash: "x",
      updatedAt: now,
    });
    await db.upsertOrgMember({
      createdAt: now,
      orgId: ORG_ID,
      role: "admin",
      userId: "user_admin",
    });
    await db.upsertOrgMember({
      createdAt: now,
      orgId: ORG_ID,
      role: "member",
      userId: "user_member",
    });
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
    await db.upsertProfile(createDefaultProfile());
    const service = new AgentService(null, null, db);
    const sessionId = await service.createSession(
      ORG_ID,
      "web",
      "profile_super",
      "user_admin",
      { isPlatformAdmin: false, orgRole: "admin" }
    );

    await expect(
      service.resolveSession(ORG_ID, sessionId, {
        userId: "user_member",
      })
    ).resolves.toBeNull();

    const cached = await service.resolveSession(ORG_ID, sessionId, {
      userId: "user_admin",
    });
    expect(cached).not.toBeNull();

    await db.upsertOrgMember({
      createdAt: now,
      orgId: ORG_ID,
      role: "member",
      userId: "user_admin",
    });
    await expect(
      service.resolveSession(ORG_ID, sessionId, {
        userId: "user_admin",
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  test("maps channel workers to the mapped principal before super-agent profile checks", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: ORG_ID,
      name: "Test Org",
      slug: "test-org",
      updatedAt: now,
    });
    await db.createUser({
      createdAt: now,
      email: "member@example.com",
      id: "user_member",
      name: "Member",
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
      userId: "user_member",
    });
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: "628111111111@s.whatsapp.net",
      createdAt: now,
      orgId: ORG_ID,
      userId: "user_member",
    });
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
    await db.upsertProfile(createDefaultProfile());
    const service = new AgentService(null, null, db);

    await expect(
      service.createSession(
        ORG_ID,
        "whatsapp",
        "profile_super",
        LOCAL_CLIENT_USER_ID,
        {
          externalPrincipal: {
            channelUserId: "628111111111@s.whatsapp.net",
          },
          isPlatformAdmin: false,
          orgRole: "admin",
        }
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  test("proves a WhatsApp LID alias before persisting the channel principal", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: ORG_ID,
      name: "Test Org",
      slug: "test-org",
      updatedAt: now,
    });
    await db.createUser({
      createdAt: now,
      email: "member@example.com",
      id: "user_member",
      name: "Member",
      passwordHash: "x",
      updatedAt: now,
    });
    await db.createUser({
      createdAt: now,
      email: "local-client@atlas.internal",
      id: LOCAL_CLIENT_USER_ID,
      name: "Local client",
      passwordHash: "x",
      updatedAt: now,
    });
    await db.upsertOrgMember({
      createdAt: now,
      orgId: ORG_ID,
      role: "member",
      userId: "user_member",
    });
    await db.upsertOrgMember({
      createdAt: now,
      orgId: ORG_ID,
      role: "admin",
      userId: LOCAL_CLIENT_USER_ID,
    });
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: "628111111111@s.whatsapp.net",
      createdAt: now,
      orgId: ORG_ID,
      userId: "user_member",
    });
    await db.upsertProfile(createDefaultProfile());
    const service = new AgentService(null, null, db);
    const sessionId = await service.createSession(
      ORG_ID,
      "whatsapp",
      "profile_default",
      LOCAL_CLIENT_USER_ID,
      {
        externalPrincipal: {
          channelUserAliases: ["628111111111@s.whatsapp.net"],
          channelUserId: "154352568283178@lid",
        },
        orgRole: "admin",
      }
    );

    const canonicalSession = await service.resolveSession(ORG_ID, sessionId);
    const workerSession = await service.resolveSession(ORG_ID, sessionId, {
      orgRole: "admin",
      userId: LOCAL_CLIENT_USER_ID,
      workspaceWorkerChannel: "whatsapp",
    });

    expect((await db.getSession(sessionId))?.userId).toBe("user_member");
    expect(
      await db.getChannelOrgMapping(ORG_ID, "whatsapp", "154352568283178@lid")
    ).toMatchObject({ userId: "user_member" });
    expect(workerSession).toBe(canonicalSession);
  });

  test("does not resolve another member's live session", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: ORG_ID,
      name: "Test Org",
      slug: "test-org",
      updatedAt: now,
    });
    for (const userId of ["user_a", "user_b"]) {
      await db.createUser({
        createdAt: now,
        email: `${userId}@example.com`,
        id: userId,
        passwordHash: "x",
        updatedAt: now,
      });
      await db.upsertOrgMember({
        createdAt: now,
        orgId: ORG_ID,
        role: "member",
        userId,
      });
    }
    await db.upsertProfile(createDefaultProfile());
    const service = new AgentService(null, null, db);
    const sessionId = await service.createSession(
      ORG_ID,
      "web",
      "profile_default",
      "user_a",
      { orgRole: "member" }
    );

    const asUserA = await service.resolveSession(ORG_ID, sessionId, {
      userId: "user_a",
    });
    const asUserB = await service.resolveSession(ORG_ID, sessionId, {
      userId: "user_b",
    });

    expect(asUserA).not.toBeNull();
    expect(asUserB).toBeNull();
  });
});

describe("AgentService workspace provider isolation", () => {
  test("returns only providers stored for the requested workspace", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertOrgAiConfig({
      config: {
        defaultProviderId: "provider_a",
        providers: [
          {
            apiKey: "secret-a",
            baseUrl: "https://a.example/v1",
            createdAt: "2026-08-14T00:00:00.000Z",
            id: "provider_a",
            label: "Workspace A",
            type: "openai_compatible",
          },
        ],
      },
      orgId: ORG_ID,
      updatedAt: "2026-08-14T00:00:00.000Z",
    });
    await db.upsertOrgAiConfig({
      config: {
        defaultProviderId: "provider_b",
        providers: [
          {
            apiKey: "secret-b",
            baseUrl: "https://b.example/v1",
            createdAt: "2026-08-14T00:00:00.000Z",
            id: "provider_b",
            label: "Workspace B",
            type: "openai_compatible",
          },
        ],
      },
      orgId: "org_other",
      updatedAt: "2026-08-14T00:00:00.000Z",
    });
    const service = new AgentService(null, null, db);

    expect((await service.listProviders(ORG_ID)).providers).toMatchObject([
      { id: "provider_a", label: "Workspace A" },
    ]);
    expect((await service.listProviders("org_other")).providers).toMatchObject([
      { id: "provider_b", label: "Workspace B" },
    ]);
  });
});

describe("AgentService thinking provider options", () => {
  test("omits global effort when the selected provider has no advertised levels", () => {
    const db = createInMemoryDatabaseAdapter();
    const service = new AgentService(
      {
        defaultProviderId: "compat-1",
        providers: [
          {
            apiKey: "",
            baseUrl: "https://api.example.com/v1",
            createdAt: new Date().toISOString(),
            customModels: [
              { default: true, id: "qwen3.6-35b", supportsThinking: true },
            ],
            id: "compat-1",
            label: "NetraRuntime",
            type: "openai_compatible",
          },
        ],
        thinkingEffort: "high",
        thinkingEnabled: true,
      },
      null,
      db
    );

    const options = (
      service as unknown as {
        resolveChatProviderOptions: (
          providerInstance: {
            type: "openai_compatible";
            id: string;
            label: string;
            apiKey: string;
            baseUrl: string;
            createdAt: string;
          },
          thinkingSettings: {
            enabled: boolean;
            effort: "low" | "medium" | "high";
          }
        ) => { thinking?: { enabled: boolean; effort: string } } | undefined;
      }
    ).resolveChatProviderOptions(
      {
        apiKey: "",
        baseUrl: "https://api.example.com/v1",
        createdAt: new Date().toISOString(),
        id: "compat-1",
        label: "NetraRuntime",
        type: "openai_compatible",
      },
      { effort: "high", enabled: true }
    );

    expect(options?.thinking).toEqual({ enabled: true });
  });
});

describe("AgentService vision settings", () => {
  test("persists vision model in the database", async () => {
    const db = createInMemoryDatabaseAdapter();
    const service = new AgentService(
      {
        defaultProviderId: "p-openai-1",
        providers: [
          {
            apiKey: "test-key",
            createdAt: new Date().toISOString(),
            id: "p-openai-1",
            label: "OpenAI",
            type: "openai",
          },
        ],
      },
      null,
      db
    );

    const saved = await service.setVisionSettings({
      model: "p-openai-1::gpt-4o-mini",
    });

    expect(saved).toEqual({ vision: { model: "p-openai-1::gpt-4o-mini" } });
    expect(await db.getWorkspaceSettings()).toMatchObject({
      transcriptionModel: null,
      visionModel: "p-openai-1::gpt-4o-mini",
    });
    expect(await service.getVisionSettings()).toEqual({
      vision: { model: "p-openai-1::gpt-4o-mini" },
    });
  });
});

describe("AgentService transcription settings", () => {
  test("persists transcription model in the database", async () => {
    const db = createInMemoryDatabaseAdapter();
    const service = new AgentService(
      {
        defaultProviderId: "p-openai-1",
        providers: [
          {
            apiKey: "test-key",
            createdAt: new Date().toISOString(),
            id: "p-openai-1",
            label: "OpenAI",
            type: "openai",
          },
        ],
      },
      null,
      db
    );

    const saved = await service.setTranscriptionSettings({
      model: "p-openai-1::whisper-1",
    });

    expect(saved).toEqual({
      transcription: { model: "p-openai-1::whisper-1" },
    });
    expect(await db.getWorkspaceSettings()).toMatchObject({
      transcriptionModel: "p-openai-1::whisper-1",
    });
    expect(await service.getTranscriptionSettings()).toEqual({
      transcription: { model: "p-openai-1::whisper-1" },
    });
  });
});

describe("AgentService coding delegation context", () => {
  const originalPath = process.env.PATH ?? "";
  const originalDisableFixPath = process.env.ATLAS_DISABLE_FIX_PATH;
  let tempBinDir = "";

  beforeEach(async () => {
    tempBinDir = await mkdtemp(
      path.join(tmpdir(), "atlas-agent-delegation-bin-")
    );
    process.env.PATH = tempBinDir;
    process.env.ATLAS_DISABLE_FIX_PATH = "1";
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (originalDisableFixPath === undefined) {
      delete process.env.ATLAS_DISABLE_FIX_PATH;
    } else {
      process.env.ATLAS_DISABLE_FIX_PATH = originalDisableFixPath;
    }
    if (tempBinDir) {
      await rm(tempBinDir, { force: true, recursive: true });
      tempBinDir = "";
    }
  });

  test("includes harness command template and backend guidance for bash delegation", async () => {
    const db = createInMemoryDatabaseAdapter();
    await installFakeOpenCode(tempBinDir);
    await db.upsertWorkspaceSettings({
      codingAgentHarnesses: [
        {
          args: [],
          command: "opencode",
          enabled: true,
          id: "coding-harness-opencode",
          kind: "opencode",
          name: "OpenCode",
        },
      ],
      id: WORKSPACE_SETTINGS_ID,
      imageModel: null,
      selectedCodingAgentHarness: null,
      transcriptionModel: null,
      updatedAt: new Date().toISOString(),
      visionModel: null,
    });

    const service = new AgentService(null, null, db);
    const context = await (
      service as unknown as {
        formatCodingDelegationContext(
          orgId: string,
          profileId: string
        ): Promise<string>;
      }
    ).formatCodingDelegationContext("org_test", "profile_test");

    expect(context).toContain("bash");
    expect(context).toContain("opencode run");
    expect(context).not.toContain("delegate_coding_task");
    expect(context).not.toContain("workspace settings");
  });

  test("lists install commands when no coding agent CLI is installed", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertWorkspaceSettings({
      codingAgentHarnesses: [],
      id: WORKSPACE_SETTINGS_ID,
      imageModel: null,
      selectedCodingAgentHarness: null,
      transcriptionModel: null,
      updatedAt: new Date().toISOString(),
      visionModel: null,
    });

    const service = new AgentService(null, null, db);
    const context = await (
      service as unknown as {
        formatCodingDelegationContext(
          orgId: string,
          profileId: string
        ): Promise<string>;
      }
    ).formatCodingDelegationContext("org_test", "profile_test");

    expect(context).toContain("No coding agent CLI is installed");
    expect(context).toContain("npm install -g");
    expect(context).toContain("Cursor Agent CLI");
    expect(context).toContain("cannot be auto-installed");
    expect(context).not.toContain("workspace settings");
    expect(context).not.toContain("delegate_coding_task");
  });

  test("asks the user when multiple coding agent CLIs are installed", async () => {
    const db = createInMemoryDatabaseAdapter();
    await installFakeOpenCode(tempBinDir);
    await Bun.write(
      path.join(tempBinDir, "claude"),
      "#!/bin/sh\necho claude\n"
    );
    await chmod(path.join(tempBinDir, "claude"), 0o755);

    await db.upsertWorkspaceSettings({
      codingAgentHarnesses: [
        {
          args: [],
          command: "opencode",
          enabled: true,
          id: "coding-harness-opencode",
          kind: "opencode",
          name: "OpenCode",
        },
        {
          args: [],
          command: "claude",
          enabled: true,
          id: "coding-harness-claude-code",
          kind: "claude_code",
          name: "Claude Code",
        },
      ],
      id: WORKSPACE_SETTINGS_ID,
      imageModel: null,
      selectedCodingAgentHarness: "coding-harness-opencode",
      transcriptionModel: null,
      updatedAt: new Date().toISOString(),
      visionModel: null,
    });

    const service = new AgentService(null, null, db);
    const context = await (
      service as unknown as {
        formatCodingDelegationContext(
          orgId: string,
          profileId: string
        ): Promise<string>;
      }
    ).formatCodingDelegationContext("org_test", "profile_test");

    expect(context).toContain("Multiple coding agent CLIs are installed");
    expect(context).toContain("Ask the user which one to use");
    expect(context).toContain("OpenCode");
    expect(context).toContain("Claude Code");
    expect(context).not.toContain("opencode run");
  });
});

describe("AgentService skill_manage injection", () => {
  let configDir = "";

  beforeEach(async () => {
    configDir = await mkdtemp(
      path.join(tmpdir(), "atlas-skill-manage-inject-")
    );
    process.env.ATLAS_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    delete process.env.ATLAS_CONFIG_DIR;
    if (configDir) {
      await rm(configDir, { force: true, recursive: true });
      configDir = "";
    }
  });

  test("injects skill_manage for web/cli only when manage-skills is assigned", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertProfile(createDefaultProfile());
    const skills = new SkillsService(db);
    await ensureBundledSkillFiles();
    await skills.syncDiscoveredSkills();
    const manage = (await skills.listSkills()).skills.find(
      (skill) => skill.name === "manage-skills"
    );
    expect(manage).toBeDefined();
    await db.assignSkillToProfile("profile_default", manage!.id);

    const service = new AgentService(null, null, db);
    service.setSkillsService(skills);

    type ResolveTools = {
      resolveProfileTools(
        profile: StoredProfileRecord,
        options?: {
          includeAutomationTools?: boolean;
          includeSkillManageTools?: boolean;
        }
      ): Promise<Array<{ name: string }>>;
    };

    const resolve = (
      service as unknown as ResolveTools
    ).resolveProfileTools.bind(service);
    const profile = createDefaultProfile();

    const webTools = await resolve(profile, { includeSkillManageTools: true });
    expect(webTools.some((tool) => tool.name === "skill_manage")).toBe(true);

    const telegramTools = await resolve(profile, {
      includeSkillManageTools: false,
    });
    expect(telegramTools.some((tool) => tool.name === "skill_manage")).toBe(
      false
    );

    const automationTools = await resolve(profile, {
      includeAutomationTools: false,
    });
    expect(automationTools.some((tool) => tool.name === "skill_manage")).toBe(
      false
    );
  });

  test("forbids skill markdown writes when manage-skills is assigned even without skill_manage", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertProfile(createDefaultProfile());
    const skills = new SkillsService(db);
    await ensureBundledSkillFiles();
    await skills.syncDiscoveredSkills();
    const manage = (await skills.listSkills()).skills.find(
      (skill) => skill.name === "manage-skills"
    );
    expect(manage).toBeDefined();
    await db.assignSkillToProfile("profile_default", manage!.id);

    const service = new AgentService(null, null, db);
    service.setSkillsService(skills);

    const forbid = await (
      service as unknown as {
        shouldForbidProfileSkillMarkdownWrites(
          profileId: string
        ): Promise<boolean>;
      }
    ).shouldForbidProfileSkillMarkdownWrites("profile_default");

    expect(forbid).toBe(true);
  });
});

describe("AgentService session listing org isolation", () => {
  test("does not list another organization's sessions for a foreign profile id", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: ORG_ID,
      name: "Acme",
      slug: "acme",
      updatedAt: now,
    });
    await db.upsertOrganization({
      createdAt: now,
      id: "org_other",
      name: "Other",
      slug: "other",
      updatedAt: now,
    });
    await db.upsertProfile(createDefaultProfile());
    await db.upsertProfile({
      createdAt: now,
      id: "sales",
      isDefault: false,
      isSuper: false,
      model: null,
      name: "Sales",
      orgId: ORG_ID,
      systemPrompt: "",
      updatedAt: now,
    });
    await db.upsertProfile({
      createdAt: now,
      id: "profile_other_default",
      isDefault: true,
      isSuper: false,
      model: null,
      name: "Default",
      orgId: "org_other",
      systemPrompt: "",
      updatedAt: now,
    });
    await db.createUser({
      createdAt: now,
      email: "ada@example.com",
      id: "user_1",
      name: "Ada",
      passwordHash: "x",
      updatedAt: now,
    });
    await db.upsertOrgMember({
      createdAt: now,
      orgId: ORG_ID,
      role: "member",
      userId: "user_1",
    });
    await db.createUser({
      createdAt: now,
      email: "peer-admin@example.com",
      id: "user_other_admin",
      name: "Peer Admin",
      passwordHash: "x",
      updatedAt: now,
    });
    await db.upsertOrgMember({
      createdAt: now,
      orgId: "org_other",
      role: "admin",
      userId: "user_other_admin",
    });

    const service = new AgentService(null, null, db);
    const sessionId = await service.createSession(
      ORG_ID,
      "web",
      "sales",
      "user_1",
      { orgRole: "member" }
    );
    await db.replaceMessagesForSession(sessionId, [
      {
        createdAt: now,
        id: "msg_secret",
        payload: { content: "Acme Q3 pipeline and pricing", role: "user" },
        seq: 0,
        sessionId,
      },
    ]);

    const ownListing = await service.listSessions(ORG_ID, "sales", "web", {
      userId: "user_1",
    });
    expect(ownListing.sessions.map((session) => session.id)).toContain(
      sessionId
    );

    await expect(
      service.listSessions("org_other", "sales", "web", {
        userId: "user_other_admin",
      })
    ).rejects.toMatchObject({
      message: "Profile not found.",
      status: 404,
    });
  });
});

async function installFakeOpenCode(binDir: string): Promise<void> {
  const scriptPath = path.join(binDir, "opencode");
  await writeFile(
    scriptPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  echo "fake opencode"',
      "  exit 0",
      "fi",
      "printf '%s' \"$*\"",
    ].join("\n")
  );
  await chmod(scriptPath, 0o755);
}
