import { afterEach, describe, expect, mock, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";
import { sessionTurnRegistry } from "./session-turn-registry";

setupTestConfigDir("atlas-session-model-service-");

const originalFetch = globalThis.fetch;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalCompatibleApiKey = process.env.OPENAI_COMPATIBLE_API_KEY;
const originalXaiApiKey = process.env.XAI_API_KEY;
const ORG_ID = "org_session_models";
const PROFILE_ID = "profile_shared";

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }
  if (originalCompatibleApiKey === undefined) {
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
  } else {
    process.env.OPENAI_COMPATIBLE_API_KEY = originalCompatibleApiKey;
  }
  if (originalXaiApiKey === undefined) {
    delete process.env.XAI_API_KEY;
  } else {
    process.env.XAI_API_KEY = originalXaiApiKey;
  }
});

async function createScenario() {
  const db = createInMemoryDatabaseAdapter();
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Session Models",
    slug: "session-models",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "owner@example.com",
    id: "user_owner",
    passwordHash: "unused",
    updatedAt: now,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role: "member",
    userId: "user_owner",
  });
  await db.upsertProfile({
    createdAt: now,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: "provider-1::profile-default",
    name: "Shared",
    orgId: ORG_ID,
    systemPrompt: "Be concise.",
    updatedAt: now,
  });
  await db.upsertOrgAiConfig({
    config: {
      defaultProviderId: "provider-1",
      providers: [
        {
          apiKey: "",
          baseUrl: "https://8.8.8.8/v1",
          createdAt: now,
          customModels: [
            { default: true, id: "profile-default" },
            { id: "session-alt" },
          ],
          id: "provider-1",
          label: "Models",
          type: "openai_compatible",
        },
        {
          apiKey: "openrouter-key",
          createdAt: now,
          customModels: [{ default: true, id: "approved/economy" }],
          id: "openrouter-1",
          label: "OpenRouter",
          type: "openrouter",
        },
      ],
    },
    orgId: ORG_ID,
    updatedAt: now,
  });

  return { db, service: new AgentService(null, null, db) };
}

describe("AgentService session model overrides", () => {
  test("uses env credentials for stored OpenAI and compatible remote discovery", async () => {
    const { db, service } = await createScenario();
    const authorizations: string[] = [];
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        authorizations.push(
          new Headers(init?.headers).get("authorization") ?? ""
        );
        return Response.json({ data: [{ id: "remote-model" }] });
      }
    ) as unknown as typeof fetch;

    process.env.OPENAI_COMPATIBLE_API_KEY = "compatible-env-secret";
    const compatible = await service.getModels(ORG_ID, { source: "remote" });
    expect(compatible.customModels?.map((model) => model.id)).toEqual([
      "remote-model",
    ]);

    const now = new Date().toISOString();
    await db.upsertOrgAiConfig({
      config: {
        defaultProviderId: "openai-env",
        providers: [
          {
            apiKey: "",
            baseUrl: "https://1.1.1.1/v1",
            createdAt: now,
            customModels: [{ default: true, id: "gpt-5.4" }],
            id: "openai-env",
            label: "OpenAI",
            type: "openai",
          },
        ],
      },
      orgId: ORG_ID,
      updatedAt: now,
    });
    process.env.OPENAI_API_KEY = "openai-env-secret";
    const freshService = new AgentService(null, null, db);
    const config = await freshService.getUserConfigForOrg(ORG_ID);
    const openai = await freshService.discoverModelsForProvider(
      "openai-env",
      undefined,
      config
    );
    expect(openai.models.map((model) => model.id)).toEqual(["remote-model"]);
    expect(authorizations.filter(Boolean)).toEqual([
      "Bearer compatible-env-secret",
      "Bearer openai-env-secret",
    ]);
  });

  test("exposes env-backed provider models to the session picker", async () => {
    const { db, service } = await createScenario();
    const now = new Date().toISOString();
    process.env.XAI_API_KEY = "environment-secret";
    await db.upsertOrgAiConfig({
      config: {
        defaultProviderId: "provider-1",
        providers: [
          {
            apiKey: "",
            baseUrl: "https://api.x.ai/v1",
            createdAt: now,
            customModels: [
              { default: true, id: "profile-default" },
              { id: "session-alt" },
            ],
            id: "provider-1",
            label: "xAI",
            type: "xai",
          },
        ],
      },
      orgId: ORG_ID,
      updatedAt: now,
    });

    const response = await service.getModels(ORG_ID);
    expect(response.models.map((model) => model.id)).toEqual([
      "profile-default",
      "session-alt",
    ]);
    expect(response.providers[0]).toMatchObject({
      hasApiKey: true,
      modelCount: 2,
    });

    const sessionId = await service.createSession(
      ORG_ID,
      "web",
      PROFILE_ID,
      "user_owner",
      { model: "provider-1::session-alt", orgRole: "member" }
    );
    expect((await db.getSession(sessionId))?.modelOverride).toBe(
      "provider-1::session-alt"
    );
  });

  test("keeps two sessions independent with different approved models", async () => {
    const { db, service } = await createScenario();
    const requestModels: string[] = [];
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          model?: string;
        };
        requestModels.push(body.model ?? "");
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              index: 0,
              message: { content: "ok", role: "assistant" },
            },
          ],
          created: 1,
          id: "mock",
          model: body.model,
          object: "chat.completion",
        });
      }
    ) as unknown as typeof fetch;

    const firstId = await service.createSession(
      ORG_ID,
      "web",
      PROFILE_ID,
      "user_owner",
      { model: "provider-1::session-alt", orgRole: "member" }
    );
    const secondId = await service.createSession(
      ORG_ID,
      "web",
      PROFILE_ID,
      "user_owner",
      { orgRole: "member" }
    );

    expect((await db.getSession(firstId))?.modelOverride).toBe(
      "provider-1::session-alt"
    );
    expect((await db.getSession(secondId))?.modelOverride).toBeNull();
    expect((await db.getProfile(PROFILE_ID))?.model).toBe(
      "provider-1::profile-default"
    );

    const first = await service.resolveSession(ORG_ID, firstId, {
      userId: "user_owner",
    });
    const second = await service.resolveSession(ORG_ID, secondId, {
      userId: "user_owner",
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    await first!.send("first");
    await second!.send("second");
    expect(requestModels).toEqual(["session-alt", "profile-default"]);

    const branch = await service.branchSession(ORG_ID, firstId, 0);
    expect(branch).not.toBeNull();
    expect((await db.getSession(branch!.sessionId))?.modelOverride).toBe(
      "provider-1::session-alt"
    );
  });

  test("reset removes the override and invalidates the cached harness", async () => {
    const { db, service } = await createScenario();
    const sessionId = await service.createSession(
      ORG_ID,
      "web",
      PROFILE_ID,
      "user_owner",
      { model: "provider-1::session-alt", orgRole: "member" }
    );
    const before = await service.resolveSession(ORG_ID, sessionId, {
      userId: "user_owner",
    });

    sessionTurnRegistry.beginTurn(sessionId);
    await expect(
      service.updateSessionModel(ORG_ID, sessionId, null, {
        userId: "user_owner",
      })
    ).rejects.toMatchObject({ status: 409 });
    sessionTurnRegistry.cancelTurn(sessionId);

    expect(
      await service.updateSessionModel(ORG_ID, sessionId, null, {
        userId: "user_owner",
      })
    ).toBe(true);
    expect((await db.getSession(sessionId))?.modelOverride).toBeNull();

    const after = await service.resolveSession(ORG_ID, sessionId, {
      userId: "user_owner",
    });
    expect(after).not.toBe(before);
    expect((await service.getSessionMessages(ORG_ID, sessionId))?.model).toBe(
      null
    );
  });

  test("clears a revoked override and falls back to the profile model", async () => {
    const { db, service } = await createScenario();
    const requestModels: string[] = [];
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          model?: string;
        };
        requestModels.push(body.model ?? "");
        return Response.json({
          choices: [{ message: { content: "ok", role: "assistant" } }],
        });
      }
    ) as unknown as typeof fetch;

    const sessionId = await service.createSession(
      ORG_ID,
      "web",
      PROFILE_ID,
      "user_owner",
      { model: "provider-1::session-alt", orgRole: "member" }
    );
    await service.updateProvider(ORG_ID, "provider-1", {
      customModels: [{ default: true, id: "profile-default" }],
      skipValidation: true,
    });

    const session = await service.resolveSession(ORG_ID, sessionId, {
      userId: "user_owner",
    });
    expect(session).not.toBeNull();
    await session!.send("after revocation");

    expect(requestModels).toEqual(["profile-default"]);
    expect((await db.getSession(sessionId))?.modelOverride).toBeNull();
    expect(
      (await service.getSessionMessages(ORG_ID, sessionId))?.model
    ).toBeNull();
  });

  test("rejects unapproved compatible and OpenRouter models for members and admins", async () => {
    const { service } = await createScenario();

    for (const orgRole of ["member", "admin"] as const) {
      await expect(
        service.createSession(ORG_ID, "web", PROFILE_ID, "user_owner", {
          model: "provider-1::future-model",
          orgRole,
        })
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        service.createSession(ORG_ID, "web", PROFILE_ID, "user_owner", {
          model: "openrouter-1::unapproved/expensive-model",
          orgRole,
        })
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  test("reports live model-update access for owners and admins only", async () => {
    const { db, service } = await createScenario();
    const now = new Date().toISOString();
    for (const actor of [
      { id: "user_member", role: "member" as const },
      { id: "user_admin", role: "admin" as const },
      { id: "user_viewer", role: "viewer" as const },
    ]) {
      await db.createUser({
        createdAt: now,
        email: `${actor.id}@example.com`,
        id: actor.id,
        passwordHash: "unused",
        updatedAt: now,
      });
      await db.upsertOrgMember({
        createdAt: now,
        orgId: ORG_ID,
        role: actor.role,
        userId: actor.id,
      });
    }

    const sessionId = await service.createSession(
      ORG_ID,
      "web",
      PROFILE_ID,
      "user_owner",
      { orgRole: "member" }
    );

    expect(
      (
        await service.getSessionMessages(ORG_ID, sessionId, {
          userId: "user_owner",
        })
      )?.canUpdateModel
    ).toBe(true);
    expect(
      (
        await service.getSessionMessages(ORG_ID, sessionId, {
          userId: "user_member",
        })
      )?.canUpdateModel
    ).toBe(false);
    expect(
      (
        await service.getSessionMessages(ORG_ID, sessionId, {
          userId: "user_admin",
        })
      )?.canUpdateModel
    ).toBe(true);
    expect(
      (
        await service.getSessionMessages(ORG_ID, sessionId, {
          userId: "user_viewer",
        })
      )?.canUpdateModel
    ).toBe(false);
  });
});
