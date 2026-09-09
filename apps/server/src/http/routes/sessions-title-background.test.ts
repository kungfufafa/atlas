import { expect, spyOn, test } from "bun:test";
import { type AgentChatSession, createAgentHarness } from "@atlas/agent";
import type {
  GenerateTextInput,
  GenerateTextResult,
  ProviderClient,
  UserConfig,
} from "@atlas/core";
import { createSqliteDatabase } from "@atlas/db";
import { AgentService } from "../../services/agent-service";
import { AuthService } from "../../services/auth-service";
import { wrapPersistedSession } from "../../services/session-persistence";
import { SessionTitleService } from "../../services/session-title-service";
import { sessionTurnRegistry } from "../../services/session-turn-registry";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import { loginUserSession } from "../test-session-helpers";

setupTestConfigDir("atlas-http-title-background-");
const NOW = "2026-09-07T00:00:00.000Z";
const ORG = "title-http-org";
const PROFILE = "title-http-profile";
const OWNER = "title-http-owner";
const PASSWORD = "fixture-password";
const CONFIG: UserConfig = {
  defaultProviderId: "title",
  providers: [
    {
      apiKey: "fixture-only-key",
      id: "title",
      type: "openai_compatible",
      label: "Fixture",
      createdAt: NOW,
      customModels: [{ id: "title-model" }],
    },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const stream of [false, true]) {
  test(`HTTP ${stream ? "stream" : "send"} completes while actual background title cancellation awaits cleanup`, async () => {
    const sql = await createSqliteDatabase(":memory:");
    const db = sql.adapter;
    const authService = new AuthService();
    const finish = deferred<GenerateTextResult>();
    const entered = deferred<GenerateTextInput>();
    const started = deferred<Promise<void>>();
    let job: Promise<void> | undefined;
    try {
      await db.upsertOrganization({
        id: ORG,
        name: ORG,
        slug: ORG,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await db.createUser({
        id: OWNER,
        email: `${OWNER}@example.invalid`,
        passwordHash: await authService.hashPassword(PASSWORD),
        isPlatformAdmin: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await db.upsertOrgMember({
        orgId: ORG,
        userId: OWNER,
        role: "member",
        createdAt: NOW,
      });
      await db.upsertProfile({
        id: PROFILE,
        name: PROFILE,
        model: "title::title-model",
        isSuper: false,
        orgId: ORG,
        systemPrompt: "",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const id = crypto.randomUUID();
      await db.upsertSession({
        id,
        profileId: PROFILE,
        orgId: ORG,
        userId: OWNER,
        channel: "web",
        title: null,
        modelOverride: null,
        agentTodos: [],
        agentQuestionnaire: null,
        createdAt: NOW,
      });
      const titleProvider: ProviderClient = {
        name: "openai_compatible",
        generateText(input) {
          entered.resolve(input);
          return finish.promise;
        },
        async generateChat() {
          throw new Error("Unexpected title chat fixture call");
        },
        async streamChat() {
          throw new Error("Unexpected title stream fixture call");
        },
      };
      const title = new SessionTitleService(
        db,
        () => CONFIG,
        () => titleProvider,
        { generationTimeoutMs: 25 }
      );
      const generateTitle = title.generateSessionTitle.bind(title);
      spyOn(title, "generateSessionTitle").mockImplementation((sessionId) => {
        job = generateTitle(sessionId);
        started.resolve(job);
        return job;
      });
      const agent = new AgentService(null, null, db);
      Object.defineProperty(agent, "sessionTitleService", { value: title });
      const mainProvider: ProviderClient = {
        name: "openai_compatible",
        async generateText() {
          throw new Error("Unexpected main text fixture call");
        },
        async generateChat() {
          return {
            content: "The main response is ready.",
            assistantMessage: {
              role: "assistant",
              content: "The main response is ready.",
            },
            toolCalls: [],
          };
        },
        async streamChat(input, handlers) {
          const result = await this.generateChat(input);
          handlers.onChunk(result.content);
          return result;
        },
      };
      const internals = agent as unknown as {
        buildChatSession(...args: unknown[]): Promise<AgentChatSession>;
      };
      spyOn(internals, "buildChatSession").mockImplementation(async () =>
        wrapPersistedSession(
          id,
          createAgentHarness({ provider: mainProvider }).createChatSession(),
          db
        )
      );
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
      const response = await app.fetch(
        new Request(`http://localhost:4310/v1/sessions/${id}/messages`, {
          method: "POST",
          headers: login.headers({
            "Content-Type": "application/json",
            "X-CSRF-Token": login.csrfToken,
          }),
          body: JSON.stringify({
            message: "Plan an accessible workshop",
            stream,
          }),
        })
      );
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("The main response is ready.");
      if (stream) {
        expect(body).toContain('"type":"done"');
      }
      expect(sessionTurnRegistry.isActive(id)).toBe(false);
      const input = await entered.promise;
      expect(input.signal).toBeInstanceOf(AbortSignal);
      if (!input.signal) {
        throw new Error("Missing title signal");
      }
      const signal = input.signal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      expect((await db.getSession(id))?.title).toBeNull();
      // Main HTTP work is already done even though the title provider has not cleaned up.
      finish.resolve({ content: "Late title must not replace fallback" });
      await started.promise;
      expect((await db.getSession(id))?.title).toBe(
        "Plan an accessible workshop"
      );
      expect(
        (await db.listMessagesForSession(id)).filter(
          (row) =>
            typeof row.payload === "object" &&
            row.payload !== null &&
            "role" in row.payload &&
            row.payload.role === "assistant"
        )
      ).toHaveLength(1);
    } finally {
      finish.resolve({ content: "Fixture cleanup" });
      await job;
      sql.close();
    }
  });
}
