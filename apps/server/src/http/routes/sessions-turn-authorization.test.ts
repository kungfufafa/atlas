import { afterEach, expect, spyOn, test } from "bun:test";
import { type AgentChatSession, createAgentHarness } from "@atlas/agent";
import {
  type AgentChannel,
  createWorkspaceWorkerAuthToken,
  type GenerateChatInput,
  type OrgRole,
  type ProviderClient,
  type ToolContext,
} from "@atlas/core";
import { createSqliteDatabase } from "@atlas/db";
import { AgentService } from "../../services/agent-service";
import { AuthService } from "../../services/auth-service";
import { wrapPersistedSession } from "../../services/session-persistence";
import { sessionTurnRegistry } from "../../services/session-turn-registry";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import { loginUserSession } from "../test-session-helpers";

type SendStreamOptions = NonNullable<Parameters<AgentChatSession["send"]>[1]>;

setupTestConfigDir("atlas-http-turn-authorization-");
const ORG = "turn-org";
const PROFILE = "turn-profile";
const OWNER = "turn-owner";
const NOW = "2026-09-07T00:00:00.000Z";
const PASSWORD = "test-password";
const databases: Awaited<ReturnType<typeof createSqliteDatabase>>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});

type FixtureInternals = {
  invalidateProfileSessions(profileId: string): void;
  buildChatSession(
    channel: AgentChannel,
    orgId: string,
    profileId: string,
    sessionId?: string,
    model?: string | null,
    userId?: string | null,
    role?: OrgRole | null
  ): Promise<AgentChatSession>;
  createToolExecutionGuard(
    orgId: string,
    profileId: string,
    version: number,
    principal: { userId: string; orgRole: OrgRole; isPlatformAdmin: boolean }
  ): () => Promise<void>;
};

async function fixture(native = false, channel: "web" | "discord" = "web") {
  const sql = await createSqliteDatabase(":memory:");
  databases.push(sql);
  const db = sql.adapter;
  const authService = new AuthService();
  await db.upsertOrganization({
    createdAt: NOW,
    id: ORG,
    name: ORG,
    slug: ORG,
    updatedAt: NOW,
  });
  for (const userId of [OWNER, "other-owner"]) {
    await db.createUser({
      createdAt: NOW,
      email: `${userId}@example.invalid`,
      id: userId,
      passwordHash: await authService.hashPassword(PASSWORD),
      isPlatformAdmin: false,
      updatedAt: NOW,
    });
    await db.upsertOrgMember({
      createdAt: NOW,
      orgId: ORG,
      role: "member",
      userId,
    });
  }
  await db.upsertProfile({
    createdAt: NOW,
    id: PROFILE,
    isSuper: false,
    model: null,
    name: PROFILE,
    orgId: ORG,
    systemPrompt: "",
    updatedAt: NOW,
  });
  const id = crypto.randomUUID();
  const setSession = async (userId = OWNER, nextChannel = channel as string) =>
    db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: nextChannel,
      createdAt: NOW,
      id,
      modelOverride: null,
      orgId: ORG,
      profileId: PROFILE,
      title: null,
      userId,
    });
  await setSession();
  const agent = new AgentService(null, null, db);
  const internals = agent as unknown as FixtureInternals;
  let builds = 0;
  let effects = 0;
  let existingGuards = 0;
  let requests = 0;
  let beforeDispatch = async (): Promise<void> => {};
  let beforeOperation = async (): Promise<void> => {};
  let failExisting = false;
  const contexts: ToolContext[] = [];
  const turnOptions: (SendStreamOptions | undefined)[] = [];
  const generate = async (input: GenerateChatInput) => {
    requests += 1;
    const hasCall = native || requests % 2 === 1;
    const call = { arguments: {}, id: `call-${requests}`, name: "effect" };
    if (hasCall) {
      await beforeDispatch();
    }
    if (native) {
      await input.executeToolCall!(call);
    }
    const toolCalls = !native && hasCall ? [call] : [];
    return {
      assistantMessage: {
        content: "Fixture response",
        role: "assistant" as const,
        toolCalls,
      },
      content: "Fixture response",
      toolCalls,
    };
  };
  const provider: ProviderClient = {
    name: "openai_compatible",
    generateChat: generate,
    async generateText() {
      throw new Error("No text provider is admitted in this fixture");
    },
    async streamChat(input, handlers) {
      const reply = await generate(input);
      handlers.onChunk(reply.content);
      return reply;
    },
  };
  spyOn(internals, "buildChatSession").mockImplementation(
    async (_channel, orgId, profileId, sessionId, _model, userId, role) => {
      builds += 1;
      const existing = internals.createToolExecutionGuard(orgId, profileId, 0, {
        userId: userId!,
        orgRole: role!,
        isPlatformAdmin: false,
      });
      const inner = createAgentHarness({
        provider,
        tools: [
          {
            name: "effect",
            description: "Local fixture effect",
            parameters: { type: "object", properties: {} },
            async run(_args, context) {
              effects += 1;
              contexts.push(context);
              return { effects };
            },
          },
        ],
      }).createChatSession({
        toolContext: {
          orgId,
          profileId,
          sessionId,
          userId: userId!,
          async beforeToolCall() {
            existingGuards += 1;
            await existing();
            if (failExisting) {
              throw new Error("Fixture existing guard denies");
            }
          },
        },
      });
      const persisted = wrapPersistedSession(id, inner, db, {
        async runTurn(_turnId, operation) {
          await beforeOperation();
          return operation();
        },
      });
      const send = persisted.send.bind(persisted);
      const sendStream = persisted.sendStream.bind(persisted);
      persisted.send = (input, options) => {
        turnOptions.push(options);
        return send(input, options);
      };
      persisted.sendStream = (input, handlers, options) => {
        turnOptions.push(options);
        return sendStream(input, handlers, options);
      };
      return persisted;
    }
  );
  spyOn(agent, "scheduleSessionTitleGeneration").mockImplementation(() => {});
  spyOn(agent, "schedulePostTurnSkillReview").mockImplementation(() => {});
  const { app } = createMinimalHonoApp({
    agent,
    authService,
    databaseAdapter: db,
  });
  const login = await loginUserSession(
    app,
    `${OWNER}@example.invalid`,
    PASSWORD,
    ORG
  );
  const humanHeaders = login.headers({
    "Content-Type": "application/json",
    "X-CSRF-Token": login.csrfToken,
  });
  const workerHeaders = async (
    workerChannel: "discord" | "telegram" = "discord"
  ) => ({
    Authorization: `Bearer ${await createWorkspaceWorkerAuthToken({ orgId: ORG, channel: workerChannel })}`,
    "Content-Type": "application/json",
    "X-Org-Id": ORG,
  });
  const request = async (
    stream: boolean,
    headers = humanHeaders,
    signal?: AbortSignal,
    extraBody?: Record<string, unknown>
  ) =>
    app.fetch(
      new Request(`http://localhost:4310/v1/sessions/${id}/messages`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          message: "Run local fixture",
          stream,
          ...extraBody,
        }),
      })
    );
  return {
    agent,
    db,
    id,
    request,
    workerHeaders,
    setSession,
    contexts,
    turnOptions,
    counts: () => ({ builds, effects, existingGuards }),
    mutateBeforeDispatch(fn: () => Promise<void>) {
      beforeDispatch = fn;
    },
    deferOperation(fn: () => Promise<void>) {
      beforeOperation = fn;
    },
    invalidateProfile() {
      internals.invalidateProfileSessions(PROFILE);
    },
    denyExisting() {
      failExisting = true;
    },
  };
}

for (const native of [false, true]) {
  for (const stream of [false, true]) {
    test(`${native ? "native" : "API"} HTTP ${stream ? "stream" : "send"} reuses session but receives a fresh authenticated guard`, async () => {
      const f = await fixture(native, "discord");
      const worker = await f.workerHeaders();
      for (const headers of [undefined, worker]) {
        const response = await f.request(stream, headers);
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(f.counts()).toEqual({ builds: 1, effects: 2, existingGuards: 2 });
      expect(f.turnOptions).toHaveLength(2);
      expect(typeof f.turnOptions[0]?.toolExecutionGuard).toBe("function");
      expect(f.turnOptions[1]?.toolExecutionGuard).not.toBe(
        f.turnOptions[0]?.toolExecutionGuard
      );
      expect(
        f.turnOptions.every(
          (options) => options?.toolExecutionLifecycle === undefined
        )
      ).toBe(true);
      expect(f.contexts.map((context) => context.userId)).toEqual([
        OWNER,
        OWNER,
      ]);
      await f.setSession(OWNER, "web");
      await expect(
        f.turnOptions[1]!.toolExecutionGuard!(f.contexts[1]!)
      ).rejects.toThrow();
      await f.turnOptions[0]!.toolExecutionGuard!(f.contexts[0]!);
      expect(sessionTurnRegistry.isActive(f.id)).toBe(false);
      expect(
        (await f.db.listMessagesForSession(f.id)).some(
          (message) => (message.payload as { role?: string }).role === "tool"
        )
      ).toBe(true);
    });
  }
}

for (const change of [
  "owner",
  "membership",
  "channel",
  "version",
  "existing-guard",
] as const) {
  for (const stream of [false, true]) {
    test(`HTTP ${stream ? "stream" : "send"} denies an effect after ${change} changes while provider is running`, async () => {
      const f = await fixture(true, "discord");
      f.mutateBeforeDispatch(async () => {
        if (change === "owner") {
          await f.setSession("other-owner");
        }
        if (change === "membership") {
          await f.db.deleteOrgMember(ORG, OWNER);
        }
        if (change === "channel") {
          await f.setSession(OWNER, "web");
        }
        if (change === "version") {
          f.invalidateProfile();
        }
        if (change === "existing-guard") {
          f.denyExisting();
        }
      });
      const response = await f.request(stream, await f.workerHeaders());
      await response.text();
      expect(f.counts().builds).toBe(1);
      expect(f.counts().effects).toBe(0);
      expect(f.counts().existingGuards).toBeGreaterThan(0);
      expect(sessionTurnRegistry.isActive(f.id)).toBe(false);
    });
  }
}

test("wrong worker channel is denied before resolving a session", async () => {
  const f = await fixture(false, "discord");
  const response = await f.request(false, await f.workerHeaders("telegram"));
  expect(response.status).toBe(404);
  expect(f.counts().builds).toBe(0);
  expect(sessionTurnRegistry.isActive(f.id)).toBe(false);
});

test("principal failure after reservation releases turn without resolving tools", async () => {
  const f = await fixture();
  const begin = f.agent.beginSessionTurn.bind(f.agent);
  spyOn(f.agent, "beginSessionTurn").mockImplementation(async (...args) => {
    const result = await begin(...args);
    await f.db.upsertOrganization({
      ...(await f.db.getOrganizationById(ORG))!,
      archivedAt: NOW,
    });
    return result;
  });
  const response = await f.request(false);
  expect(response.status).toBe(404);
  expect(f.counts().builds).toBe(0);
  expect(sessionTurnRegistry.isActive(f.id)).toBe(false);
});

for (const stream of [false, true]) {
  test(`HTTP ${stream ? "stream" : "send"} cancellation crosses deferred persisted wrapper`, async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.deferOperation(async () => {
      entered.resolve();
      await release.promise;
    });
    const controller = new AbortController();
    const pending = f.request(stream, undefined, controller.signal);
    await entered.promise;
    controller.abort();
    release.resolve();
    const response = await pending;
    await response.text();
    expect(f.counts().effects).toBe(0);
    expect(f.turnOptions[0]?.signal?.aborted).toBe(true);
    expect(sessionTurnRegistry.isActive(f.id)).toBe(false);
  });
}

test("request JSON cannot supply trusted authorization options", async () => {
  const f = await fixture();
  const response = await f.request(false, undefined, undefined, {
    toolExecutionGuard: "forged",
    actor: { userId: "other-owner" },
  });
  expect(response.status).toBe(400);
  expect(f.counts().builds).toBe(0);
  expect(sessionTurnRegistry.isActive(f.id)).toBe(false);
});

for (const stream of [false, true]) {
  test(`human web HTTP ${stream ? "stream" : "send"} checks current owner while a persisted operation waits`, async () => {
    const f = await fixture(true);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.deferOperation(async () => {
      entered.resolve();
      await release.promise;
    });
    const pending = f.request(stream);
    await entered.promise;
    await f.setSession("other-owner");
    release.resolve();
    await (await pending).text();
    expect(f.counts().effects).toBe(0);
    expect(sessionTurnRegistry.isActive(f.id)).toBe(false);
  });
}
