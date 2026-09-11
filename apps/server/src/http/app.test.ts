import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceWorkerAuthToken,
  loadLocalAuthToken,
  saveWhatsAppConfig,
  verifyLocalAuthToken,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AuthService } from "../services/auth-service";
import { IdentityService } from "../services/identity-service";
import { OrgService } from "../services/org-service";
import { sessionTurnRegistry } from "../services/session-turn-registry";
import { setupTestConfigDir } from "../test-config-dir";
import { createHonoApp } from "./app";
import {
  buildSetupAuthBody,
  createPlatformAdminUser,
  LOCAL_CLIENT_EMAIL,
  seedLocalClientUser,
  seedOrgForUser,
  TEST_ORG_ID,
  withOrgId,
} from "./test-org-helpers";
import {
  cookieHeaderFromSetCookies,
  cookieValue,
  extractSetCookies,
  loginUserSession,
  setupFreshInstallSession,
} from "./test-session-helpers";

setupTestConfigDir("atlas-http-app-test-");

async function withNodeEnv<T>(env: string, run: () => Promise<T>): Promise<T> {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = env;
  try {
    return await run();
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
}

function expectCookiesSecure(setCookies: string[], expected: boolean): void {
  expect(setCookies.length).toBeGreaterThan(0);
  expect(
    setCookies.every((cookie) =>
      expected
        ? /;\s*Secure(?:;|$)/i.test(cookie)
        : !/;\s*Secure(?:;|$)/i.test(cookie)
    )
  ).toBe(true);
}

function createServerOptions() {
  const databaseAdapter = createInMemoryDatabaseAdapter();
  const authService = new AuthService();
  return {
    agent: {
      assignMcpServer: async (_profileId: string, _body: unknown) => ({
        id: "default",
      }),
      assignSkill: async (_profileId: string, _body: unknown) => ({
        id: "default",
      }),
      assignTool: async (_profileId: string, _body: unknown) => ({
        id: "default",
      }),
      beginSessionTurn: async (orgId: string, sessionId: string) =>
        sessionTurnRegistry.beginTurn(sessionId, orgId).started,
      branchSession: async (_sessionId: string, messageIndex: number) => ({
        sessionId: `branched-${messageIndex}`,
      }),
      canAccessSession: async () => true,
      clearSession: async (_sessionId: string) => true,
      compactSession: async (_sessionId: string, body: { force: boolean }) => ({
        action: body.force ? "summarized" : "none",
        messagesAfter: 1,
        messagesBefore: 2,
      }),
      configureProvider: async (_body: unknown) => ({ ok: true }),
      createProfile: async (_body: unknown) => ({ id: "profile_1" }),
      createProvider: async (_body: unknown) => ({ providerId: "provider_1" }),
      createSession: async (
        _orgId: string,
        _channel: string,
        _profileId?: string
      ) => "session_1",
      createSkill: async (_body: unknown) => ({ id: "skill_1" }),
      createTool: async (_body: unknown) => ({ id: "tool_1" }),
      deleteKnowledgeBaseDocument: async (
        _profileId: string,
        _documentId: string
      ) => ({ ok: true }),
      deleteProfile: async (_profileId: string) => {},
      deleteProfileAvatar: async (_profileId: string) => {},
      deleteProvider: async (_providerId: string) => ({ ok: true }),
      deleteSkill: async (_skillId: string) => {},
      deleteTool: async (_toolId: string) => {},
      draftAutomation: async (_prompt: string, _channel: string) => ({
        id: "automation_draft",
      }),
      draftTaskPrompt: async (_title: string, _description?: string) =>
        "prompt-1",
      generateImage: async (_body: unknown) => ({
        data: "AA==",
        mediaType: "image/png",
        model: "gpt-image-2",
        size: "1024x1024",
        sizeBytes: 1,
      }),
      getImageGenerationSettings: async () => ({
        imageGeneration: { model: null },
      }),
      getModels: async (
        _orgId: string,
        { source }: { source: "catalog" | "remote" }
      ) => ({
        models: [{ id: `model-${source}` }],
      }),
      getProfile: async (_profileId: string) => ({ id: "default" }),
      getProfileAvatar: async (_orgId: string, _profileId: string) => ({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
      }),
      getProfileAvatarByProfileId: async (_profileId: string) => ({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
      }),
      getProfileSoulStack: async (_profileId: string) => ({
        stack: ["SOUL.md"],
      }),
      getProfileSoulStatus: async (
        _profileId: string,
        includeContents: boolean
      ) => ({ content: includeContents ? "soul" : null, hasSoul: true }),
      getSessionMessages: async (_sessionId: string) => ({
        channel: "web",
        messageMeta: [
          { createdAt: new Date().toISOString(), id: "m1", seq: 0 },
        ],
        messages: [{ content: "hi", role: "assistant" }],
      }),
      getSessionTodos: async (_sessionId: string) => [],
      getSkill: async (_skillId: string) => ({ id: "skill_1" }),
      getTaskChatMessages: async (_taskId: string) => ({
        messages: [{ content: "task", role: "assistant" }],
        sessionId: "session_1",
      }),
      getTelegramSettings: async () => ({ enabled: false }),
      getThinkingSettings: async () => ({
        thinking: { effort: "medium", enabled: true },
      }),
      getTool: async (_toolId: string) => ({ id: "tool_1" }),
      getToolSource: async (_toolId: string) => ({ source: "builtin" }),
      getTranscriptionSettings: async () => ({
        transcription: { model: null },
      }),
      getUserContext: async (
        _orgId: string,
        _userId: string,
        includeContent: boolean
      ) => ({
        active: includeContent,
        ...(includeContent ? { content: "ctx" } : {}),
      }),
      getUserTimezone: async () => "Asia/Jakarta",
      getVisionSettings: async () => ({ vision: { model: null } }),
      getWhatsAppSettings: async () => ({ enabled: false }),
      identityService: new IdentityService(databaseAdapter),
      initProfileSoul: async (_profileId: string) => ({ ok: true }),
      initUserContext: async (_orgId: string, _userId: string) => ({
        created: true,
      }),
      listKnowledgeBase: async (_profileId: string) => ({
        documents: [],
        sources: [],
      }),
      listProfileArtifacts: async () => ({ artifacts: [] }),
      listProfiles: async () => ({ profiles: [{ id: "default" }] }),
      listProfileTools: async (_profileId: string) => ({
        tools: [{ id: "tool_1" }],
      }),
      listProviders: async () => ({ providers: [] }),
      listSessions: async (
        _orgId: string,
        profileId: string,
        channel: string
      ) => ({
        sessions: [{ id: `${profileId}-${channel}` }],
      }),
      listSkills: async () => ({ skills: [{ id: "skill_1" }] }),
      listTools: async () => ({ tools: [{ id: "tool_1" }] }),
      // Route smoke fixture only; real turn ACLs are covered by the persisted
      // messages integration tests using AgentService and SQLite.
      prepareAuthenticatedSessionTurnOptions: async () =>
        Object.freeze({ toolExecutionGuard: async () => {} }),
      providerConfigured: true,
      purgeSession: async (_sessionId: string) => true,
      regenerateTelegramHandshake: async () => ({ enabled: false }),
      regenerateWhatsAppPairingCode: async () => ({ enabled: false }),
      resolveSession: async (_sessionId: string) => ({
        getContextUsage: () => null,
        send: async (input: { message: string }) => `reply:${input.message}`,
      }),
      runAutomation: async (_automationId: string) => ({ skipped: false }),
      runTask: async (_taskId: string) => ({ skipped: false }),
      schedulePostTurnSkillReview: (_sessionId: string) => {},
      scheduleSessionTitleGeneration: (_sessionId: string) => {},
      setImageGenerationSettings: async (_body: unknown) => ({
        imageGeneration: { model: null },
      }),
      setTelegramSettings: async (_body: unknown) => ({ enabled: false }),
      setThinkingSettings: async (_body: unknown) => ({
        thinking: { effort: "medium", enabled: true },
      }),
      setTranscriptionSettings: async (_body: unknown) => ({
        transcription: { model: null },
      }),
      setUserTimezone: async (timezone: string) => timezone,
      setVisionSettings: async (_body: unknown) => ({
        vision: { model: null },
      }),
      setWhatsAppSettings: async (_body: unknown) => ({ enabled: false }),
      syncSkills: async () => ({ synced: 1 }),
      transcribeAudio: async (_body: unknown) => ({ text: "hello" }),
      unassignMcpServer: async (_profileId: string, _serverId: string) => ({
        id: "default",
      }),
      unassignSkill: async (_profileId: string, _skillId: string) => ({
        id: "default",
      }),
      unassignTool: async (_profileId: string, _toolId: string) => ({
        id: "default",
      }),
      updateProfile: async (_profileId: string, _body: unknown) => ({
        id: "default",
      }),
      updateProvider: async (_providerId: string, _body: unknown) => ({
        providerId: "provider_1",
      }),
      uploadKnowledgeBaseDocument: async (
        _profileId: string,
        _doc: unknown
      ) => ({ id: "kb_1" }),
      uploadProfileAvatar: async (_profileId: string, _body: unknown) => ({
        id: "default",
      }),
      writeProfileSoulFile: async (
        _profileId: string,
        _fileKey: string,
        _body: unknown
      ) => {},
      writeUserContext: async (
        _orgId: string,
        _userId: string,
        _body: unknown
      ) => {},
    } as any,
    authService,
    automationService: {
      create: async (_orgId: string, _body: unknown, _profileId?: string) => ({
        id: "automation_1",
      }),
      delete: async (_automationId: string, _orgId: string) => true,
      get: async (_automationId: string, _orgId?: string) => ({
        id: "automation_1",
      }),
      listForOrg: async (_orgId: string, _userId?: string) => ({
        automations: [{ id: "automation_1" }],
        unread: { byAutomationId: {}, totalUnread: 0 },
      }),
      listRuns: async (
        _automationId: string,
        _orgId?: string,
        limit?: number
      ) =>
        limit ? [{ id: "automation_run_1" }] : [{ id: "automation_run_1" }],
      update: async (
        _automationId: string,
        _orgId: string,
        _body: unknown
      ) => ({
        id: "automation_1",
      }),
    } as any,
    databaseAdapter,
    mcpService: {
      connectServer: async (_serverId: string) => ({ id: "mcp_1" }),
      createServer: async (_body: unknown) => ({ id: "mcp_1" }),
      deleteServer: async (_serverId: string) => {},
      getServer: async (_serverId: string) => ({ id: "mcp_1" }),
      listServers: async () => ({ servers: [{ id: "mcp_1" }] }),
      syncServer: async (_serverId: string) => ({ id: "mcp_1" }),
      testServer: async (
        _transport: unknown,
        _config: unknown,
        _serverId: unknown
      ) => ({ ok: true }),
      updateServer: async (_serverId: string, _body: unknown) => ({
        id: "mcp_1",
      }),
    } as any,
    orgService: new OrgService(databaseAdapter, authService),
    systemStatus: {
      getStatus: async () => ({ ok: true }),
    } as any,
    taskService: {
      create: async (_orgId: string, _body: unknown, _profileId?: string) => ({
        id: "task_1",
        status: "pending",
      }),
      delete: async (_taskId: string, _orgId: string) => true,
      get: async (_taskId: string, _orgId?: string) => ({
        id: "task_1",
        status: "pending",
      }),
      listForOrg: async (_orgId: string) => [
        { id: "task_1", status: "pending" },
      ],
      listRuns: async (_taskId: string, _orgId?: string, limit?: number) =>
        limit ? [{ id: "task_run_1" }] : [{ id: "task_run_1" }],
      update: async (
        _taskId: string,
        _orgId: string,
        body: any,
        _opts?: unknown
      ) => ({
        id: "task_1",
        status: body.status ?? "pending",
      }),
    } as any,
    webDistDir: null,
    workerManager: {
      clearWorkerLogs: async () => {},
      getWorkerLogs: async (_name: string, lines: number) => ({
        lines: [`last:${lines}`],
        worker: "whatsapp",
      }),
      isValidWorker: () => true,
      restartWorker: async () => {},
      startWorker: async () => {},
      stopWorker: async () => {},
    } as any,
  };
}

describe("createHonoApp", () => {
  test("accepts opaque bearer auth for internal clients", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "atlas-bearer-auth-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    try {
      const options = createServerOptions();
      const token = await loadLocalAuthToken();
      const payload = await verifyLocalAuthToken(token!);
      expect(payload).not.toBeNull();
      await seedLocalClientUser(options.databaseAdapter);
      await seedOrgForUser(options.databaseAdapter, payload!.email);
      const app = createHonoApp(options);

      const profilesResponse = await app.fetch(
        new Request("http://localhost:4310/v1/profiles", {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Org-Id": TEST_ORG_ID,
          },
        })
      );

      expect(profilesResponse.status).toBe(200);
      await expect(profilesResponse.json()).resolves.toEqual({
        profiles: [{ id: "default" }],
      });

      const whatsappResponse = await app.fetch(
        new Request("http://localhost:4310/v1/settings/whatsapp", {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Org-Id": TEST_ORG_ID,
          },
        })
      );

      expect(whatsappResponse.status).toBe(200);
      await expect(whatsappResponse.json()).resolves.toEqual({
        enabled: false,
      });
    } finally {
      delete process.env.ATLAS_CONFIG_DIR;
      await rm(configDir, { force: true, recursive: true });
    }
  });

  test("workspace worker token uses its claimed org with member role", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "atlas-worker-auth-http-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    try {
      const options = createServerOptions();
      const now = new Date().toISOString();
      await options.databaseAdapter.upsertOrganization({
        createdAt: now,
        id: TEST_ORG_ID,
        name: "Test Org",
        slug: "test-org",
        updatedAt: now,
      });
      await options.databaseAdapter.upsertProfile({
        createdAt: now,
        id: "default",
        isDefault: true,
        isSuper: false,
        model: null,
        name: "Default",
        orgId: TEST_ORG_ID,
        systemPrompt: "",
        updatedAt: now,
      });
      await saveWhatsAppConfig(
        { accessMode: "open", profileId: "default" },
        TEST_ORG_ID
      );
      let observedAccess: { excludeSuperAgent?: boolean; orgRole?: string } =
        {};
      options.agent.createSession = async (
        _orgId: string,
        _channel: string,
        _profileId: string | undefined,
        _userId: string,
        access: { excludeSuperAgent?: boolean; orgRole?: string }
      ) => {
        observedAccess = access;
        return "session_1";
      };
      const token = await createWorkspaceWorkerAuthToken({
        channel: "whatsapp",
        orgId: TEST_ORG_ID,
      });
      const app = createHonoApp(options);
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };

      const profiles = await app.fetch(
        new Request("http://localhost:4310/v1/profiles", { headers })
      );
      expect(profiles.status).toBe(200);

      const models = await app.fetch(
        new Request("http://localhost:4310/v1/models", { headers })
      );
      expect(models.status).toBe(200);

      const session = await app.fetch(
        new Request("http://localhost:4310/v1/sessions", {
          body: JSON.stringify({
            channel: "whatsapp",
            externalPrincipal: {
              channelUserId: "6281111111111@s.whatsapp.net",
            },
            profileId: "default",
          }),
          headers,
          method: "POST",
        })
      );
      expect(session.status).toBe(201);
      expect(observedAccess).toMatchObject({
        excludeSuperAgent: true,
        orgRole: "member",
      });

      const adminRoute = await app.fetch(
        new Request("http://localhost:4310/v1/settings/whatsapp", { headers })
      );
      expect(adminRoute.status).toBe(403);
    } finally {
      delete process.env.ATLAS_CONFIG_DIR;
      await rm(configDir, { force: true, recursive: true });
    }
  });

  test("workspace worker token rejects cross-org and cross-channel requests", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "atlas-worker-auth-http-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    try {
      const options = createServerOptions();
      const now = new Date().toISOString();
      await options.databaseAdapter.upsertOrganization({
        createdAt: now,
        id: TEST_ORG_ID,
        name: "Test Org",
        slug: "test-org",
        updatedAt: now,
      });
      await options.databaseAdapter.upsertOrganization({
        createdAt: now,
        id: "org_beta",
        name: "Beta Org",
        slug: "beta-org",
        updatedAt: now,
      });
      await options.databaseAdapter.upsertProfile({
        createdAt: now,
        id: "default",
        isSuper: false,
        model: null,
        name: "Default",
        orgId: TEST_ORG_ID,
        systemPrompt: "",
        updatedAt: now,
      });
      await options.databaseAdapter.upsertProfile({
        createdAt: now,
        id: "super",
        isSuper: true,
        model: null,
        name: "Super Agent",
        orgId: TEST_ORG_ID,
        systemPrompt: "",
        updatedAt: now,
      });
      for (const [id, role] of [
        ["worker_artifact_member", "member"],
        ["worker_artifact_viewer", "viewer"],
      ] as const) {
        await options.databaseAdapter.createUser({
          createdAt: now,
          email: `${id}@example.com`,
          id,
          passwordHash: "unused",
          updatedAt: now,
        });
        await options.databaseAdapter.upsertOrgMember({
          createdAt: now,
          orgId: TEST_ORG_ID,
          role,
          userId: id,
        });
      }
      await options.databaseAdapter.createUser({
        createdAt: now,
        email: "worker_artifact_removed@example.com",
        id: "worker_artifact_removed",
        passwordHash: "unused",
        updatedAt: now,
      });
      await options.databaseAdapter.upsertSession({
        agentQuestionnaire: null,
        agentTodos: [],
        channel: "whatsapp",
        createdAt: now,
        id: "session_whatsapp",
        modelOverride: null,
        orgId: TEST_ORG_ID,
        profileId: "default",
        title: null,
        userId: "worker_artifact_member",
      });
      await options.databaseAdapter.appendMessagesForSession(
        "session_whatsapp",
        [
          {
            createdAt: now,
            id: "message_artifact_call",
            payload: {
              content: "",
              role: "assistant",
              toolCalls: [
                {
                  arguments: {
                    content: "allowed",
                    path: "artifacts/allowed.md",
                  },
                  id: "tool_allowed",
                  name: "write_file",
                },
              ],
            },
            seq: 0,
            sessionId: "session_whatsapp",
          },
          {
            createdAt: now,
            id: "message_artifact_result",
            payload: {
              content: JSON.stringify({
                bytesWritten: 7,
                path: "/tmp/profile/artifacts/allowed.md",
              }),
              name: "write_file",
              role: "tool",
              toolCallId: "tool_allowed",
            },
            seq: 1,
            sessionId: "session_whatsapp",
          },
        ]
      );
      options.agent.listProfileArtifacts = async () => ({
        artifacts: [
          {
            filename: "allowed.md",
            mimeType: "text/markdown",
            path: "allowed.md",
            sizeBytes: 7,
            updatedAt: now,
          },
          {
            filename: "other-session.md",
            mimeType: "text/markdown",
            path: "other-session.md",
            sizeBytes: 12,
            updatedAt: now,
          },
        ],
        directory: "/private/profile/artifacts",
        folders: [],
        profileId: "default",
        total: 2,
      });
      await options.databaseAdapter.upsertSession({
        agentQuestionnaire: null,
        agentTodos: [],
        channel: "whatsapp",
        createdAt: now,
        id: "session_super",
        modelOverride: null,
        orgId: TEST_ORG_ID,
        profileId: "super",
        title: null,
        userId: "worker_artifact_member",
      });
      await options.databaseAdapter.upsertSession({
        agentQuestionnaire: null,
        agentTodos: [],
        channel: "telegram",
        createdAt: now,
        id: "session_telegram",
        modelOverride: null,
        orgId: TEST_ORG_ID,
        profileId: "default",
        title: null,
        userId: "worker_artifact_member",
      });
      for (const [id, userId] of [
        ["session_legacy", null],
        ["session_removed", "worker_artifact_removed"],
        ["session_viewer", "worker_artifact_viewer"],
      ] as const) {
        await options.databaseAdapter.upsertSession({
          agentQuestionnaire: null,
          agentTodos: [],
          channel: "whatsapp",
          createdAt: now,
          id,
          modelOverride: null,
          orgId: TEST_ORG_ID,
          profileId: "default",
          title: null,
          userId,
        });
      }
      const token = await createWorkspaceWorkerAuthToken({
        channel: "whatsapp",
        orgId: TEST_ORG_ID,
      });
      const app = createHonoApp(options);

      const crossOrg = await app.fetch(
        new Request("http://localhost:4310/v1/profiles", {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Org-Id": "org_beta",
          },
        })
      );
      expect(crossOrg.status).toBe(403);

      const unscopedSessionList = await app.fetch(
        new Request("http://localhost:4310/v1/sessions", {
          headers: { Authorization: `Bearer ${token}` },
        })
      );
      expect(unscopedSessionList.status).toBe(403);

      const scopedSessionList = await app.fetch(
        new Request(
          "http://localhost:4310/v1/sessions?channel=whatsapp&profileId=default",
          { headers: { Authorization: `Bearer ${token}` } }
        )
      );
      expect(scopedSessionList.status).toBe(403);

      const artifactHeaders = { Authorization: `Bearer ${token}` };
      const matchingArtifact = await app.fetch(
        new Request(
          "http://localhost:4310/v1/profiles/default/artifacts?sessionId=session_whatsapp",
          { headers: artifactHeaders }
        )
      );
      expect(matchingArtifact.status).toBe(200);
      expect(await matchingArtifact.json()).toMatchObject({
        artifacts: [{ path: "allowed.md" }],
        directory: "",
        total: 1,
      });

      const crossSessionArtifactContent = await app.fetch(
        new Request(
          "http://localhost:4310/v1/profiles/default/artifacts/content?path=other-session.md&sessionId=session_whatsapp",
          { headers: artifactHeaders }
        )
      );
      expect(crossSessionArtifactContent.status).toBe(404);

      const crossSessionArtifactShare = await app.fetch(
        new Request(
          "http://localhost:4310/v1/profiles/default/artifacts/shares?sessionId=session_whatsapp",
          {
            body: JSON.stringify({ path: "other-session.md" }),
            headers: {
              ...artifactHeaders,
              "Content-Type": "application/json",
            },
            method: "POST",
          }
        )
      );
      expect(crossSessionArtifactShare.status).toBe(404);

      const viewerArtifactRead = await app.fetch(
        new Request(
          "http://localhost:4310/v1/profiles/default/artifacts?sessionId=session_viewer",
          { headers: artifactHeaders }
        )
      );
      expect(viewerArtifactRead.status).toBe(200);
      const viewerArtifactShare = await app.fetch(
        new Request(
          "http://localhost:4310/v1/profiles/default/artifacts/shares?sessionId=session_viewer",
          {
            body: JSON.stringify({ path: "allowed.md" }),
            headers: {
              ...artifactHeaders,
              "Content-Type": "application/json",
            },
            method: "POST",
          }
        )
      );
      expect(viewerArtifactShare.status).toBe(404);

      for (const path of [
        "/v1/profiles/default/artifacts",
        "/v1/profiles/default/artifacts?sessionId=session_telegram",
        "/v1/profiles/other/artifacts?sessionId=session_whatsapp",
        "/v1/profiles/super/artifacts?sessionId=session_super",
        "/v1/profiles/default/artifacts?sessionId=session_legacy",
        "/v1/profiles/default/artifacts?sessionId=session_removed",
        "/v1/sessions/session_super/messages",
      ]) {
        const response = await app.fetch(
          new Request(`http://localhost:4310${path}`, {
            headers: artifactHeaders,
          })
        );
        expect(response.status).toBe(404);
      }

      const crossChannel = await app.fetch(
        new Request("http://localhost:4310/v1/sessions", {
          body: JSON.stringify({ channel: "telegram", profileId: "default" }),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        })
      );
      expect(crossChannel.status).toBe(403);
    } finally {
      delete process.env.ATLAS_CONFIG_DIR;
      await rm(configDir, { force: true, recursive: true });
    }
  });

  test("workspace worker token cannot access auth or platform routes", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "atlas-worker-auth-http-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    try {
      const options = createServerOptions();
      const token = await createWorkspaceWorkerAuthToken({
        channel: "whatsapp",
        orgId: TEST_ORG_ID,
      });
      const app = createHonoApp(options);
      const headers = { Authorization: `Bearer ${token}` };

      const authRoute = await app.fetch(
        new Request("http://localhost:4310/v1/auth/orgs", { headers })
      );
      expect(authRoute.status).toBe(403);

      const platformRoute = await app.fetch(
        new Request("http://localhost:4310/v1/platform/orgs", { headers })
      );
      expect(platformRoute.status).toBe(403);

      const health = await app.fetch(
        new Request("http://localhost:4310/health", { headers })
      );
      expect(health.status).toBe(200);

      for (const path of [
        "/v1/automations",
        "/v1/settings/whatsapp",
        "/v1/tasks",
        "/v1/tools",
        "/v1/usage?groupBy=model",
        "/v1/workers",
      ]) {
        const response = await app.fetch(
          new Request(`http://localhost:4310${path}`, { headers })
        );
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
          error: "Workspace worker credential cannot access this route",
        });
      }

      const automationDraft = await app.fetch(
        new Request("http://localhost:4310/v1/automations/draft", {
          body: JSON.stringify({ channel: "whatsapp", prompt: "draft" }),
          headers: { ...headers, "Content-Type": "application/json" },
          method: "POST",
        })
      );
      expect(automationDraft.status).toBe(403);

      const sessionMutation = await app.fetch(
        new Request("http://localhost:4310/v1/sessions/session_1", {
          body: JSON.stringify({ model: "example" }),
          headers: { ...headers, "Content-Type": "application/json" },
          method: "PATCH",
        })
      );
      expect(sessionMutation.status).toBe(403);

      const artifactMutation = await app.fetch(
        new Request(
          "http://localhost:4310/v1/profiles/default/artifacts?path=report.md",
          {
            headers,
            method: "DELETE",
          }
        )
      );
      expect(artifactMutation.status).toBe(403);

      const individualProfile = await app.fetch(
        new Request("http://localhost:4310/v1/profiles/default", { headers })
      );
      expect(individualProfile.status).toBe(403);
    } finally {
      delete process.env.ATLAS_CONFIG_DIR;
      await rm(configDir, { force: true, recursive: true });
    }
  });

  test("auto-provisions local client user on first bearer auth", async () => {
    const configDir = await mkdtemp(
      join(tmpdir(), "atlas-bearer-auth-autoprovision-")
    );
    process.env.ATLAS_CONFIG_DIR = configDir;

    try {
      const options = createServerOptions();
      const token = await loadLocalAuthToken();
      const now = new Date().toISOString();
      await options.databaseAdapter.upsertOrganization({
        createdAt: now,
        id: TEST_ORG_ID,
        name: "Test Org",
        slug: "test-org",
        updatedAt: now,
      });
      const app = createHonoApp(options);

      expect(
        await options.databaseAdapter.getUserByEmail(LOCAL_CLIENT_EMAIL)
      ).toBeNull();

      const response = await app.fetch(
        new Request("http://localhost:4310/v1/profiles", {
          headers: { Authorization: `Bearer ${token}` },
        })
      );

      expect(response.status).toBe(200);
      expect(
        await options.databaseAdapter.getUserByEmail(LOCAL_CLIENT_EMAIL)
      ).not.toBeNull();
    } finally {
      delete process.env.ATLAS_CONFIG_DIR;
      await rm(configDir, { force: true, recursive: true });
    }
  });

  test("resolves org context for bearer auth without X-Org-Id", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "atlas-bearer-auth-org-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    try {
      const options = createServerOptions();
      const token = await loadLocalAuthToken();
      await seedLocalClientUser(options.databaseAdapter);
      await seedOrgForUser(options.databaseAdapter, LOCAL_CLIENT_EMAIL);
      const app = createHonoApp(options);

      const profilesResponse = await app.fetch(
        new Request("http://localhost:4310/v1/profiles", {
          headers: { Authorization: `Bearer ${token}` },
        })
      );

      expect(profilesResponse.status).toBe(200);
    } finally {
      delete process.env.ATLAS_CONFIG_DIR;
      await rm(configDir, { force: true, recursive: true });
    }
  });

  test("requires X-Org-Id when the local token belongs to more than one org", async () => {
    const configDir = await mkdtemp(
      join(tmpdir(), "atlas-bearer-auth-multi-org-")
    );
    process.env.ATLAS_CONFIG_DIR = configDir;

    try {
      const options = createServerOptions();
      const token = await loadLocalAuthToken();
      await seedLocalClientUser(options.databaseAdapter);
      await seedOrgForUser(options.databaseAdapter, LOCAL_CLIENT_EMAIL);
      const now = new Date().toISOString();
      await options.databaseAdapter.upsertOrganization({
        createdAt: now,
        id: "org_beta",
        name: "Beta Org",
        slug: "beta-org",
        updatedAt: now,
      });
      await options.databaseAdapter.upsertOrgMember({
        createdAt: now,
        orgId: "org_beta",
        role: "admin",
        userId: "user_local_client",
      });
      const app = createHonoApp(options);

      const profilesResponse = await app.fetch(
        new Request("http://localhost:4310/v1/profiles", {
          headers: { Authorization: `Bearer ${token}` },
        })
      );

      expect(profilesResponse.status).toBe(400);
      await expect(profilesResponse.json()).resolves.toEqual({
        error: "Organization context required",
      });
    } finally {
      delete process.env.ATLAS_CONFIG_DIR;
      await rm(configDir, { force: true, recursive: true });
    }
  });

  test("rejects invalid bearer auth with 401 instead of 500", async () => {
    const options = createServerOptions();
    const app = createHonoApp(options);
    const response = await app.fetch(
      new Request("http://localhost:4310/v1/profiles", {
        headers: { Authorization: "Bearer invalid_token" },
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required",
    });
  });

  test("rotates the local auth token from a browser session", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "atlas-rotate-auth-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    try {
      const options = createServerOptions();
      const app = createHonoApp(options);
      const setupResponse = await app.fetch(
        new Request("http://localhost:4310/v1/auth/setup", {
          body: JSON.stringify(
            buildSetupAuthBody("admin@example.com", {
              admin: { password: "secret123" },
            })
          ),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      );
      const setupCookies = extractSetCookies(setupResponse);
      const orgId = await seedOrgForUser(
        options.databaseAdapter,
        "admin@example.com"
      );

      const rotateResponse = await app.fetch(
        new Request("http://localhost:4310/v1/auth/local-token/rotate", {
          headers: withOrgId(
            {
              Cookie: cookieHeaderFromSetCookies(setupCookies),
              "X-CSRF-Token": cookieValue(setupCookies, "atlas_csrf"),
            },
            orgId
          ),
          method: "POST",
        })
      );

      expect(rotateResponse.status).toBe(200);
      const rotatePayload = (await rotateResponse.json()) as { token: string };
      expect(rotatePayload.token).toStartWith("tc_local_");

      const oldToken = await loadLocalAuthToken();
      expect(oldToken).toBe(rotatePayload.token);
    } finally {
      delete process.env.ATLAS_CONFIG_DIR;
      await rm(configDir, { force: true, recursive: true });
    }
  });

  test("rejects local auth token rotation from bearer auth", async () => {
    const configDir = await mkdtemp(
      join(tmpdir(), "atlas-rotate-auth-bearer-")
    );
    process.env.ATLAS_CONFIG_DIR = configDir;

    try {
      const token = await loadLocalAuthToken();
      const options = createServerOptions();
      await seedLocalClientUser(options.databaseAdapter);
      const app = createHonoApp(options);
      const response = await app.fetch(
        new Request("http://localhost:4310/v1/auth/local-token/rotate", {
          headers: { Authorization: `Bearer ${token}` },
          method: "POST",
        })
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Sign in through the dashboard to rotate the local auth token.",
      });
    } finally {
      delete process.env.ATLAS_CONFIG_DIR;
      await rm(configDir, { force: true, recursive: true });
    }
  });

  for (const role of ["admin", "member", "viewer"] as const) {
    test(`rejects local auth token rotation from a workspace ${role} who is not Superadmin`, async () => {
      const configDir = await mkdtemp(
        join(tmpdir(), `atlas-rotate-auth-${role}-`)
      );
      process.env.ATLAS_CONFIG_DIR = configDir;

      try {
        const options = createServerOptions();
        const app = createHonoApp(options);
        const setup = await setupFreshInstallSession(
          app,
          options.databaseAdapter
        );
        const orgId = setup.orgId!;
        const email = `${role}@example.com`;
        const now = new Date().toISOString();
        await options.databaseAdapter.createUser({
          createdAt: now,
          email,
          id: `user_${role}`,
          isPlatformAdmin: false,
          passwordHash: await options.authService.hashPassword("password123"),
          updatedAt: now,
        });
        await options.databaseAdapter.upsertOrgMember({
          createdAt: now,
          orgId,
          role,
          userId: `user_${role}`,
        });
        const session = await loginUserSession(
          app,
          email,
          "password123",
          orgId
        );

        const response = await app.fetch(
          new Request("http://localhost:4310/v1/auth/local-token/rotate", {
            headers: session.headers(
              { "X-CSRF-Token": session.csrfToken },
              orgId
            ),
            method: "POST",
          })
        );

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
          error: "Superadmin access required",
        });
      } finally {
        delete process.env.ATLAS_CONFIG_DIR;
        await rm(configDir, { force: true, recursive: true });
      }
    });
  }

  test("serves health through the Hono fetch boundary", async () => {
    const options = createServerOptions();
    const app = createHonoApp(options);
    const response = await app.fetch(
      new Request("http://localhost:4310/health")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      // /health stays local — never probes Composio reachability
      composioAvailable: false,
      ok: true,
      providerConfigured: true,
      userConfigured: false,
    });
  });

  test("reports userConfigured when only the local CLI client exists", async () => {
    const options = createServerOptions();
    await seedLocalClientUser(options.databaseAdapter);
    const app = createHonoApp(options);

    const response = await app.fetch(
      new Request("http://localhost:4310/health")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      userConfigured: false,
    });
  });

  test("allows setup when only the local CLI client exists", async () => {
    const options = createServerOptions();
    await seedLocalClientUser(options.databaseAdapter);
    const app = createHonoApp(options);

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup", {
        body: JSON.stringify(buildSetupAuthBody()),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );

    expect(response.status).toBe(201);
  });

  test("serializes concurrent first-run setup so only one admin is created", async () => {
    const options = createServerOptions();
    const app = createHonoApp(options);

    const [first, second] = await Promise.all([
      app.fetch(
        new Request("http://localhost:4310/v1/auth/setup", {
          body: JSON.stringify(
            buildSetupAuthBody("alpha@example.com", {
              organization: { name: "Alpha", slug: "alpha" },
            })
          ),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      ),
      app.fetch(
        new Request("http://localhost:4310/v1/auth/setup", {
          body: JSON.stringify(
            buildSetupAuthBody("beta@example.com", {
              organization: { name: "Beta", slug: "beta" },
            })
          ),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      ),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(await options.databaseAdapter.countHumanUsers()).toBe(1);
  });

  const secureCookieCases = [
    {
      expectSecure: false,
      headers: { "Content-Type": "application/json" },
      name: "setup over HTTP does not set Secure cookies even in production (#112)",
      nodeEnv: "production",
      url: "http://localhost:4310/v1/auth/setup",
      verifySession: true,
    },
    {
      expectSecure: true,
      headers: { "Content-Type": "application/json" },
      name: "setup over HTTPS sets Secure cookies in production",
      nodeEnv: "production",
      url: "https://atlas.example/v1/auth/setup",
    },
    {
      expectSecure: true,
      headers: { "Content-Type": "application/json" },
      name: "setup over HTTPS sets Secure cookies even when NODE_ENV is not production",
      nodeEnv: "development",
      url: "https://atlas.example/v1/auth/setup",
    },
    {
      expectSecure: true,
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
      },
      name: "setup behind HTTPS proxy sets Secure cookies via X-Forwarded-Proto",
      nodeEnv: "production",
      url: "http://localhost:4310/v1/auth/setup",
    },
    {
      expectSecure: true,
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "http",
      },
      name: "https request URL keeps Secure cookies even if X-Forwarded-Proto is http",
      nodeEnv: "production",
      url: "https://atlas.example/v1/auth/setup",
    },
  ] as const;

  for (const tc of secureCookieCases) {
    test(tc.name, async () => {
      await withNodeEnv(tc.nodeEnv, async () => {
        const options = createServerOptions();
        const app = createHonoApp(options);
        const setupResponse = await app.fetch(
          new Request(tc.url, {
            body: JSON.stringify(
              buildSetupAuthBody("admin@example.com", {
                admin: { password: "secret123" },
              })
            ),
            headers: { ...tc.headers },
            method: "POST",
          })
        );

        expect(setupResponse.status).toBe(201);
        const setCookies = extractSetCookies(setupResponse);
        expectCookiesSecure(setCookies, tc.expectSecure);

        if ("verifySession" in tc && tc.verifySession) {
          const meResponse = await app.fetch(
            new Request("http://localhost:4310/v1/auth/me", {
              headers: { Cookie: cookieHeaderFromSetCookies(setCookies) },
            })
          );
          expect(meResponse.status).toBe(200);
        }
      });
    });
  }

  test("logout clears both Secure and non-Secure session cookies", async () => {
    const options = createServerOptions();
    const app = createHonoApp(options);
    const setupResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup", {
        body: JSON.stringify(
          buildSetupAuthBody("admin@example.com", {
            admin: { password: "secret123" },
          })
        ),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );
    expect(setupResponse.status).toBe(201);
    const session = {
      cookieHeader: cookieHeaderFromSetCookies(
        extractSetCookies(setupResponse)
      ),
      csrfToken: cookieValue(extractSetCookies(setupResponse), "atlas_csrf"),
    };

    const logoutResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/logout", {
        headers: {
          Cookie: session.cookieHeader,
          "X-CSRF-Token": session.csrfToken,
        },
        method: "POST",
      })
    );

    expect(logoutResponse.status).toBe(200);
    const clearCookies = extractSetCookies(logoutResponse);
    const sessionClears = clearCookies.filter((cookie) =>
      cookie.startsWith("atlas_session=")
    );
    const csrfClears = clearCookies.filter((cookie) =>
      cookie.startsWith("atlas_csrf=")
    );
    expect(
      sessionClears.some((cookie) => /;\s*Secure(?:;|$)/i.test(cookie))
    ).toBe(true);
    expect(
      sessionClears.some((cookie) => !/;\s*Secure(?:;|$)/i.test(cookie))
    ).toBe(true);
    expect(csrfClears.some((cookie) => /;\s*Secure(?:;|$)/i.test(cookie))).toBe(
      true
    );
    expect(
      csrfClears.some((cookie) => !/;\s*Secure(?:;|$)/i.test(cookie))
    ).toBe(true);
  });

  test("serves task chat capability probe without auth", async () => {
    const options = createServerOptions();
    const app = createHonoApp(options);
    const response = await app.fetch(
      new Request(
        "http://localhost:4310/v1/tasks/__capability_probe__/messages"
      )
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Task not found.",
    });
  });

  test("preserves auth-protected behavior through the Hono shell", async () => {
    const options = createServerOptions();
    const app = createHonoApp(options);
    const response = await app.fetch(
      new Request("http://localhost:4310/v1/sessions")
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required",
    });
  });

  test("preserves browser session auth through the Hono middleware", async () => {
    const options = createServerOptions();
    const app = createHonoApp(options);
    const setupResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup", {
        body: JSON.stringify(buildSetupAuthBody()),
        method: "POST",
      })
    );

    expect(setupResponse.status).toBe(201);
    const setCookies = extractSetCookies(setupResponse);
    const meResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/me", {
        headers: { Cookie: cookieHeaderFromSetCookies(setCookies) },
      })
    );

    expect(meResponse.status).toBe(200);
    const meBody = (await meResponse.json()) as {
      email: string;
      activeOrgId?: string;
      isPlatformAdmin?: boolean;
    };
    expect(meBody.email).toBe("admin@example.com");
    expect(meBody.activeOrgId).toStartWith("org_");
    expect(meBody.isPlatformAdmin).toBe(true);
  });

  test("login matches email case-insensitively", async () => {
    const options = createServerOptions();
    const app = createHonoApp(options);
    const setupResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup", {
        body: JSON.stringify(buildSetupAuthBody("admin@example.com")),
        method: "POST",
      })
    );
    expect(setupResponse.status).toBe(201);

    const loginResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/login", {
        body: JSON.stringify({
          email: "Admin@Example.com",
          password: "password123",
        }),
        method: "POST",
      })
    );
    expect(loginResponse.status).toBe(200);
  });

  test("login trims passwords consistently with setup", async () => {
    const options = createServerOptions();
    const app = createHonoApp(options);
    const setupResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup", {
        body: JSON.stringify(
          buildSetupAuthBody("padded@example.com", {
            admin: { password: "  password123  " },
          })
        ),
        method: "POST",
      })
    );
    expect(setupResponse.status).toBe(201);

    const loginResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/login", {
        body: JSON.stringify({
          email: "padded@example.com",
          password: "  password123  ",
        }),
        method: "POST",
      })
    );
    expect(loginResponse.status).toBe(200);
  });

  test("internal channel guest principals can never log in", async () => {
    const options = createServerOptions();
    const app = createHonoApp(options);
    await setupFreshInstallSession(app, options.databaseAdapter);
    const now = new Date().toISOString();
    await options.databaseAdapter.createUser({
      createdAt: now,
      email: "guest@channel-guest.atlas.invalid",
      id: "user_channel_guest_0123456789abcdef",
      isPlatformAdmin: false,
      passwordHash: await options.authService.hashPassword("known-password"),
      updatedAt: now,
    });

    const loginResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/login", {
        body: JSON.stringify({
          email: "guest@channel-guest.atlas.invalid",
          password: "known-password",
        }),
        method: "POST",
      })
    );

    expect(loginResponse.status).toBe(401);
    await expect(loginResponse.json()).resolves.toEqual({
      error: "Invalid credentials",
    });
  });

  test("change-password revokes other browser sessions", async () => {
    const options = createServerOptions();
    const app = createHonoApp(options);
    const sessionA = await setupFreshInstallSession(
      app,
      options.databaseAdapter
    );
    const sessionB = await loginUserSession(
      app,
      "admin@example.com",
      "password123",
      sessionA.orgId
    );

    const changeResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/change-password", {
        body: JSON.stringify({
          currentPassword: "password123",
          newPassword: "new-password-123",
        }),
        headers: sessionA.headers({
          "X-CSRF-Token": sessionA.csrfToken,
        }),
        method: "POST",
      })
    );
    expect(changeResponse.status).toBe(200);

    const meA = await app.fetch(
      new Request("http://localhost:4310/v1/auth/me", {
        headers: { Cookie: sessionA.cookieHeader },
      })
    );
    expect(meA.status).toBe(200);

    const meB = await app.fetch(
      new Request("http://localhost:4310/v1/auth/me", {
        headers: { Cookie: sessionB.cookieHeader },
      })
    );
    expect(meB.status).toBe(401);
  });

  test("preserves CSRF rejection through the Hono middleware", async () => {
    const options = createServerOptions();
    const app = createHonoApp(options);
    const setupResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup", {
        body: JSON.stringify(buildSetupAuthBody()),
        method: "POST",
      })
    );

    const setCookies = extractSetCookies(setupResponse);
    const denied = await app.fetch(
      new Request("http://localhost:4310/v1/workers/whatsapp/start", {
        headers: { Cookie: cookieHeaderFromSetCookies(setCookies) },
        method: "POST",
      })
    );

    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      error: "CSRF validation failed.",
    });
  });

  test("requires platform admin to control automation worker and allows workspace admin for channel workers", async () => {
    const options = createServerOptions();
    const calls: string[] = [];
    options.workerManager.startWorker = async (name: string) => {
      calls.push(`start:${name}`);
    };
    options.workerManager.startWorkspaceWorker = async (
      name: string,
      orgId: string
    ) => {
      calls.push(`start:${name}:${orgId}`);
    };
    options.workerManager.stopWorker = async (name: string) => {
      calls.push(`stop:${name}`);
    };
    options.workerManager.stopWorkspaceWorker = async (
      name: string,
      orgId: string
    ) => {
      calls.push(`stop:${name}:${orgId}`);
    };
    const app = createHonoApp(options);
    const platformSession = await setupFreshInstallSession(
      app,
      options.databaseAdapter
    );
    const now = new Date().toISOString();

    await options.databaseAdapter.createUser({
      createdAt: now,
      email: "org-admin-worker@example.com",
      id: "user_org_admin_worker",
      passwordHash: await options.authService.hashPassword("password123"),
      updatedAt: now,
    });
    await options.databaseAdapter.upsertOrgMember({
      createdAt: now,
      orgId: platformSession.orgId!,
      role: "admin",
      userId: "user_org_admin_worker",
    });

    const orgAdminSession = await loginUserSession(
      app,
      "org-admin-worker@example.com",
      "password123",
      platformSession.orgId
    );
    const denied = await app.fetch(
      new Request("http://localhost:4310/v1/workers/automation/start", {
        headers: orgAdminSession.headers({
          "X-CSRF-Token": orgAdminSession.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(denied.status).toBe(403);
    expect(calls).toEqual([]);

    const allowed = await app.fetch(
      new Request("http://localhost:4310/v1/workers/whatsapp/start", {
        headers: orgAdminSession.headers({
          "X-CSRF-Token": orgAdminSession.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(allowed.status).toBe(200);
    expect(calls).toEqual([`start:whatsapp:${platformSession.orgId}`]);
  });

  test("creates and lists sessions through Hono routes", async () => {
    const options = createServerOptions();
    const app = createHonoApp(options);
    const session = await setupFreshInstallSession(
      app,
      options.databaseAdapter
    );

    const createResponse = await app.fetch(
      new Request("http://localhost:4310/v1/sessions", {
        body: JSON.stringify({ channel: "web", profileId: "default" }),
        headers: session.headers({
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toEqual({
      sessionId: "session_1",
    });

    const listResponse = await app.fetch(
      new Request(
        "http://localhost:4310/v1/sessions?profileId=default&channel=web",
        {
          headers: session.headers(),
        }
      )
    );

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      sessions: [{ id: "default-web" }],
    });

    const missingChannel = await app.fetch(
      new Request("http://localhost:4310/v1/sessions?profileId=default", {
        headers: session.headers(),
      })
    );
    expect(missingChannel.status).toBe(400);
  });

  test("browser users cannot impersonate external channel principals", async () => {
    const options = createServerOptions();
    let createCalls = 0;
    options.agent.createSession = async () => {
      createCalls += 1;
      return "session_external";
    };
    const app = createHonoApp(options);
    const session = await setupFreshInstallSession(
      app,
      options.databaseAdapter
    );
    const headers = session.headers({
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrfToken,
    });

    const createResponse = await app.fetch(
      new Request("http://localhost:4310/v1/sessions", {
        body: JSON.stringify({
          channel: "whatsapp",
          externalPrincipal: {
            channelUserId: "628111111111@s.whatsapp.net",
          },
          profileId: "default",
        }),
        headers,
        method: "POST",
      })
    );
    expect(createResponse.status).toBe(403);
    expect(createCalls).toBe(0);

    const bindResponse = await app.fetch(
      new Request("http://localhost:4310/v1/channel-principals", {
        body: JSON.stringify({
          channel: "whatsapp",
          channelUserId: "628111111111@s.whatsapp.net",
        }),
        headers,
        method: "POST",
      })
    );
    expect(bindResponse.status).toBe(403);
  });

  const smokeRoutes = [
    {
      expected: { lines: ["last:50"], worker: "whatsapp" },
      name: "serves worker logs through Hono routes",
      path: "/v1/workers/whatsapp/logs?lines=50",
    },
    {
      expected: { models: [{ id: "model-remote" }] },
      name: "serves model catalog through Hono routes",
      path: "/v1/models?source=remote",
    },
    {
      expected: { active: true, content: "ctx" },
      name: "serves user context through Hono routes",
      path: "/v1/user/context?content=true",
    },
    {
      csrf: true,
      expected: { reply: "reply:hello" },
      method: "POST" as const,
      name: "sends non-streaming session messages through Hono routes",
      path: "/v1/sessions/session_1/messages",
      requestBody: { message: "hello" },
    },
    {
      expected: { profiles: [{ id: "default" }] },
      name: "serves profiles through Hono routes",
      path: "/v1/profiles",
    },
    {
      expected: { servers: [{ id: "mcp_1" }] },
      name: "serves mcp servers through Hono routes",
      path: "/v1/mcp/servers",
    },
    {
      expected: { skills: [{ id: "skill_1" }] },
      name: "serves skills through Hono routes",
      path: "/v1/skills",
    },
    {
      expected: { tools: [{ id: "tool_1" }] },
      name: "serves tools through Hono routes",
      path: "/v1/tools",
    },
    {
      expected: {
        automations: [{ id: "automation_1" }],
        unread: { byAutomationId: {}, totalUnread: 0 },
      },
      name: "serves automations through Hono routes",
      path: "/v1/automations",
    },
    {
      csrf: true,
      expected: { run: { id: "automation_run_1" } },
      method: "POST" as const,
      name: "runs automations through Hono routes",
      path: "/v1/automations/automation_1/run",
    },
    {
      expected: { tasks: [{ id: "task_1", status: "pending" }] },
      name: "serves tasks through Hono routes",
      path: "/v1/tasks",
    },
    {
      csrf: true,
      expected: { run: { id: "task_run_1" } },
      method: "POST" as const,
      name: "runs tasks through Hono routes",
      path: "/v1/tasks/task_1/run",
    },
  ] as const;

  for (const tc of smokeRoutes) {
    test(tc.name, async () => {
      const options = createServerOptions();
      const app = createHonoApp(options);
      const session = await setupFreshInstallSession(
        app,
        options.databaseAdapter
      );

      const method = "method" in tc ? tc.method : "GET";
      const headers =
        "csrf" in tc && tc.csrf
          ? session.headers({ "X-CSRF-Token": session.csrfToken })
          : session.headers();
      const init: RequestInit = { headers, method };
      if ("requestBody" in tc) {
        init.body = JSON.stringify(tc.requestBody);
      }

      const response = await app.fetch(
        new Request(`http://localhost:4310${tc.path}`, init)
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(tc.expected);
    });
  }

  describe("org context middleware", () => {
    test("setup stores active org on the session", async () => {
      const options = createServerOptions();
      const app = createHonoApp(options);
      const setupResponse = await app.fetch(
        new Request("http://localhost:4310/v1/auth/setup", {
          body: JSON.stringify(buildSetupAuthBody()),
          method: "POST",
        })
      );

      expect(setupResponse.status).toBe(201);
      const setupBody = (await setupResponse.json()) as {
        activeOrgId: string;
        orgId: string;
      };
      expect(setupBody.activeOrgId).toStartWith("org_");
      expect(setupBody.orgId).toBe(setupBody.activeOrgId);

      const response = await app.fetch(
        new Request("http://localhost:4310/v1/profiles", {
          headers: {
            Cookie: cookieHeaderFromSetCookies(
              extractSetCookies(setupResponse)
            ),
          },
        })
      );

      expect(response.status).toBe(200);
    });

    test("returns 400 when org context is missing on protected routes", async () => {
      const options = createServerOptions();
      const app = createHonoApp(options);
      const now = new Date().toISOString();
      await options.databaseAdapter.createUser({
        createdAt: now,
        email: "noorg@example.com",
        id: "user_no_org",
        passwordHash: await options.authService.hashPassword("password123"),
        updatedAt: now,
      });

      const loginResponse = await app.fetch(
        new Request("http://localhost:4310/v1/auth/login", {
          body: JSON.stringify({
            email: "noorg@example.com",
            password: "password123",
          }),
          method: "POST",
        })
      );

      const response = await app.fetch(
        new Request("http://localhost:4310/v1/profiles", {
          headers: {
            Cookie: cookieHeaderFromSetCookies(
              extractSetCookies(loginResponse)
            ),
          },
        })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Organization context required",
      });
    });

    test("returns 404 when org membership is missing", async () => {
      const options = createServerOptions();
      const app = createHonoApp(options);
      const session = await setupFreshInstallSession(
        app,
        options.databaseAdapter
      );

      const response = await app.fetch(
        new Request("http://localhost:4310/v1/profiles", {
          headers: withOrgId(session.headers(), "org_other"),
        })
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Not found" });
    });

    test("allows authenticated requests with valid org context", async () => {
      const options = createServerOptions();
      const app = createHonoApp(options);
      const session = await setupFreshInstallSession(
        app,
        options.databaseAdapter
      );

      const response = await app.fetch(
        new Request("http://localhost:4310/v1/profiles", {
          headers: session.headers(),
        })
      );

      expect(response.status).toBe(200);
    });

    test("skips org context for auth routes", async () => {
      const options = createServerOptions();
      const app = createHonoApp(options);
      const setupResponse = await app.fetch(
        new Request("http://localhost:4310/v1/auth/setup", {
          body: JSON.stringify(buildSetupAuthBody()),
          method: "POST",
        })
      );

      const response = await app.fetch(
        new Request("http://localhost:4310/v1/auth/me", {
          headers: {
            Cookie: cookieHeaderFromSetCookies(
              extractSetCookies(setupResponse)
            ),
          },
        })
      );

      expect(response.status).toBe(200);
    });

    test("returns 403 when viewers mutate protected routes", async () => {
      const options = createServerOptions();
      const app = createHonoApp(options);
      const session = await setupFreshInstallSession(
        app,
        options.databaseAdapter,
        "viewer@example.com",
        "viewer"
      );

      const response = await app.fetch(
        new Request("http://localhost:4310/v1/workers/automation/start", {
          headers: session.headers({
            "X-CSRF-Token": session.csrfToken,
          }),
          method: "POST",
        })
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Viewer access is read-only",
      });
    });

    test("returns 403 when viewers send session messages", async () => {
      const options = createServerOptions();
      const app = createHonoApp(options);
      const session = await setupFreshInstallSession(
        app,
        options.databaseAdapter,
        "viewer@example.com",
        "viewer"
      );

      const response = await app.fetch(
        new Request("http://localhost:4310/v1/sessions/session_1/messages", {
          body: JSON.stringify({ message: "hello" }),
          headers: session.headers({
            "X-CSRF-Token": session.csrfToken,
          }),
          method: "POST",
        })
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Viewer access is read-only",
      });
    });
  });

  describe("platform admin routes", () => {
    test("allows Workspace Admin full in-workspace profile and skill management", async () => {
      const options = createServerOptions();
      const app = createHonoApp(options);
      await createPlatformAdminUser(
        options.databaseAdapter,
        options.authService
      );

      const platformLogin = await app.fetch(
        new Request("http://localhost:4310/v1/auth/login", {
          body: JSON.stringify({
            email: "platform@example.com",
            password: "password123",
          }),
          method: "POST",
        })
      );
      expect(platformLogin.status).toBe(200);
      const platformCookies = extractSetCookies(platformLogin);

      const createOrgResponse = await app.fetch(
        new Request("http://localhost:4310/v1/platform/orgs", {
          body: JSON.stringify({
            admin: {
              email: "admin@acme.com",
              name: "Acme Admin",
              phone: "+628123456789",
            },
            name: "Acme",
            slug: "acme-platform-admin",
          }),
          headers: withOrgId(
            {
              Cookie: cookieHeaderFromSetCookies(platformCookies),
              "X-CSRF-Token": cookieValue(platformCookies, "atlas_csrf"),
            },
            ""
          ),
          method: "POST",
        })
      );
      expect(createOrgResponse.status).toBe(201);
      const created = (await createOrgResponse.json()) as {
        organization: { id: string };
        adminMember: { temporaryPassword: string };
      };

      const orgAdminLogin = await app.fetch(
        new Request("http://localhost:4310/v1/auth/login", {
          body: JSON.stringify({
            email: "admin@acme.com",
            password: created.adminMember.temporaryPassword,
          }),
          method: "POST",
        })
      );
      expect(orgAdminLogin.status).toBe(200);
      const orgAdminCookies = extractSetCookies(orgAdminLogin);
      const orgHeaders = {
        Cookie: cookieHeaderFromSetCookies(orgAdminCookies),
        "X-Org-Id": created.organization.id,
      };

      const listResponse = await app.fetch(
        new Request("http://localhost:4310/v1/profiles", {
          headers: orgHeaders,
        })
      );
      expect(listResponse.status).toBe(200);

      const createProfileResponse = await app.fetch(
        new Request("http://localhost:4310/v1/profiles", {
          body: JSON.stringify({
            name: "Workspace profile",
            systemPrompt: "ok",
          }),
          headers: {
            ...orgHeaders,
            "Content-Type": "application/json",
            "X-CSRF-Token": cookieValue(orgAdminCookies, "atlas_csrf"),
          },
          method: "POST",
        })
      );
      expect(createProfileResponse.status).toBe(201);

      const soulResponse = await app.fetch(
        new Request("http://localhost:4310/v1/profiles/default/soul", {
          headers: orgHeaders,
        })
      );
      expect(soulResponse.status).toBe(200);

      const skillsResponse = await app.fetch(
        new Request("http://localhost:4310/v1/skills", { headers: orgHeaders })
      );
      expect(skillsResponse.status).toBe(200);

      const mcpResponse = await app.fetch(
        new Request("http://localhost:4310/v1/mcp/servers", {
          headers: orgHeaders,
        })
      );
      expect(mcpResponse.status).toBe(200);
    });
  });
});
