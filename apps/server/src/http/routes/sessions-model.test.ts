import { describe, expect, test } from "bun:test";
import type { OrgRole } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AgentService } from "../../services/agent-service";
import { AuthService } from "../../services/auth-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import { loginUserSession } from "../test-session-helpers";

setupTestConfigDir("atlas-session-model-route-");

const ORG_ID = "org_sessions";
const OTHER_ORG_ID = "org_other_sessions";
const PASSWORD = "password123";
const PROFILE_ID = "profile_sessions";

async function seedUser(
  db: ReturnType<typeof createInMemoryDatabaseAdapter>,
  authService: AuthService,
  input: { email: string; id: string; orgId: string; role: OrgRole }
) {
  const now = new Date().toISOString();
  await db.createUser({
    createdAt: now,
    email: input.email,
    id: input.id,
    passwordHash: await authService.hashPassword(PASSWORD),
    updatedAt: now,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: input.orgId,
    role: input.role,
    userId: input.id,
  });
}

async function createScenario() {
  const db = createInMemoryDatabaseAdapter();
  const authService = new AuthService();
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Sessions",
    slug: "sessions",
    updatedAt: now,
  });
  await db.upsertOrganization({
    createdAt: now,
    id: OTHER_ORG_ID,
    name: "Other Sessions",
    slug: "other-sessions",
    updatedAt: now,
  });
  await Promise.all([
    seedUser(db, authService, {
      email: "owner@example.com",
      id: "user_owner",
      orgId: ORG_ID,
      role: "member",
    }),
    seedUser(db, authService, {
      email: "member@example.com",
      id: "user_member",
      orgId: ORG_ID,
      role: "member",
    }),
    seedUser(db, authService, {
      email: "admin@example.com",
      id: "user_admin",
      orgId: ORG_ID,
      role: "admin",
    }),
    seedUser(db, authService, {
      email: "viewer@example.com",
      id: "user_viewer",
      orgId: ORG_ID,
      role: "viewer",
    }),
    seedUser(db, authService, {
      email: "outsider@example.com",
      id: "user_outsider",
      orgId: OTHER_ORG_ID,
      role: "member",
    }),
  ]);
  await db.upsertProfile({
    createdAt: now,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: "provider-1::profile-default",
    name: "Shared",
    orgId: ORG_ID,
    systemPrompt: "Test",
    updatedAt: now,
  });
  await db.upsertOrgAiConfig({
    config: {
      defaultProviderId: "provider-1",
      providers: [
        {
          apiKey: "",
          baseUrl: "https://models.example/v1",
          createdAt: now,
          customModels: [
            { default: true, id: "profile-default" },
            { id: "session-alt" },
          ],
          id: "provider-1",
          label: "Models",
          type: "openai_compatible",
        },
      ],
    },
    orgId: ORG_ID,
    updatedAt: now,
  });
  const agent = new AgentService(null, null, db);
  const { app } = createMinimalHonoApp({
    agent,
    authService,
    databaseAdapter: db,
  });

  return { app, db };
}

async function patchModel(
  app: Awaited<ReturnType<typeof createScenario>>["app"],
  session: Awaited<ReturnType<typeof loginUserSession>>,
  sessionId: string,
  model: string | null
) {
  return app.fetch(
    new Request(`http://localhost:4310/v1/sessions/${sessionId}`, {
      body: JSON.stringify({ model }),
      headers: session.headers({ "X-CSRF-Token": session.csrfToken }),
      method: "PATCH",
    })
  );
}

async function readModelAccess(
  app: Awaited<ReturnType<typeof createScenario>>["app"],
  session: Awaited<ReturnType<typeof loginUserSession>>,
  sessionId: string
): Promise<{ canUpdateModel?: boolean; status: number }> {
  const response = await app.fetch(
    new Request(`http://localhost:4310/v1/sessions/${sessionId}/messages`, {
      headers: session.headers(),
    })
  );
  if (!response.ok) {
    return { status: response.status };
  }
  const body = (await response.json()) as { canUpdateModel: boolean };
  return { canUpdateModel: body.canUpdateModel, status: response.status };
}

describe("session model route", () => {
  test("persists a draft override, isolates sessions, reloads it, and resets", async () => {
    const { app, db } = await createScenario();
    const owner = await loginUserSession(
      app,
      "owner@example.com",
      PASSWORD,
      ORG_ID
    );
    const draftResponse = await app.fetch(
      new Request("http://localhost:4310/v1/sessions", {
        body: JSON.stringify({
          channel: "web",
          model: "provider-1::session-alt",
          profileId: PROFILE_ID,
        }),
        headers: owner.headers({ "X-CSRF-Token": owner.csrfToken }),
        method: "POST",
      })
    );
    const defaultResponse = await app.fetch(
      new Request("http://localhost:4310/v1/sessions", {
        body: JSON.stringify({ channel: "web", profileId: PROFILE_ID }),
        headers: owner.headers({ "X-CSRF-Token": owner.csrfToken }),
        method: "POST",
      })
    );
    expect(draftResponse.status).toBe(201);
    expect(defaultResponse.status).toBe(201);
    const { sessionId: draftId } = (await draftResponse.json()) as {
      sessionId: string;
    };
    const { sessionId: defaultId } = (await defaultResponse.json()) as {
      sessionId: string;
    };

    expect((await db.getSession(draftId))?.modelOverride).toBe(
      "provider-1::session-alt"
    );
    expect((await db.getSession(defaultId))?.modelOverride).toBeNull();
    const reload = await app.fetch(
      new Request(`http://localhost:4310/v1/sessions/${draftId}/messages`, {
        headers: owner.headers(),
      })
    );
    expect(reload.status).toBe(200);
    expect(
      (await reload.json()) as {
        canUpdateModel: boolean;
        model: string | null;
      }
    ).toMatchObject({
      canUpdateModel: true,
      model: "provider-1::session-alt",
    });

    expect(
      (await patchModel(app, owner, draftId, "provider-1::profile-default"))
        .status
    ).toBe(204);
    expect((await db.getSession(draftId))?.modelOverride).toBe(
      "provider-1::profile-default"
    );
    expect((await db.getSession(defaultId))?.modelOverride).toBeNull();
    expect((await patchModel(app, owner, draftId, null)).status).toBe(204);
    expect((await db.getSession(draftId))?.modelOverride).toBeNull();
    expect((await db.getProfile(PROFILE_ID))?.model).toBe(
      "provider-1::profile-default"
    );
  });

  test("allows an admin and rejects another member, a viewer, and another org", async () => {
    const { app, db } = await createScenario();
    const owner = await loginUserSession(
      app,
      "owner@example.com",
      PASSWORD,
      ORG_ID
    );
    const createResponse = await app.fetch(
      new Request("http://localhost:4310/v1/sessions", {
        body: JSON.stringify({ channel: "web", profileId: PROFILE_ID }),
        headers: owner.headers({ "X-CSRF-Token": owner.csrfToken }),
        method: "POST",
      })
    );
    const { sessionId } = (await createResponse.json()) as {
      sessionId: string;
    };
    const member = await loginUserSession(
      app,
      "member@example.com",
      PASSWORD,
      ORG_ID
    );
    const viewer = await loginUserSession(
      app,
      "viewer@example.com",
      PASSWORD,
      ORG_ID
    );
    const outsider = await loginUserSession(
      app,
      "outsider@example.com",
      PASSWORD,
      OTHER_ORG_ID
    );
    const admin = await loginUserSession(
      app,
      "admin@example.com",
      PASSWORD,
      ORG_ID
    );

    expect(await readModelAccess(app, owner, sessionId)).toEqual({
      canUpdateModel: true,
      status: 200,
    });
    expect(await readModelAccess(app, member, sessionId)).toEqual({
      canUpdateModel: false,
      status: 200,
    });
    expect(await readModelAccess(app, viewer, sessionId)).toEqual({
      canUpdateModel: false,
      status: 200,
    });
    expect(await readModelAccess(app, admin, sessionId)).toEqual({
      canUpdateModel: true,
      status: 200,
    });
    expect(await readModelAccess(app, outsider, sessionId)).toEqual({
      status: 404,
    });

    await db.replaceMessagesForSession(sessionId, [
      {
        createdAt: new Date().toISOString(),
        id: "source-message",
        payload: { content: "Source", role: "user" },
        seq: 0,
        sessionId,
      },
    ]);
    const branchResponse = await app.fetch(
      new Request(`http://localhost:4310/v1/sessions/${sessionId}/branch`, {
        body: JSON.stringify({ messageIndex: 0 }),
        headers: member.headers({ "X-CSRF-Token": member.csrfToken }),
        method: "POST",
      })
    );
    expect(branchResponse.status).toBe(201);
    const { sessionId: branchId } = (await branchResponse.json()) as {
      sessionId: string;
    };
    expect((await db.getSession(sessionId))?.userId).toBe("user_owner");
    expect((await db.getSession(branchId))?.userId).toBe("user_member");
    expect(await readModelAccess(app, member, branchId)).toEqual({
      canUpdateModel: true,
      status: 200,
    });
    expect(await readModelAccess(app, owner, branchId)).toEqual({
      canUpdateModel: false,
      status: 200,
    });

    expect(
      (await patchModel(app, member, sessionId, "provider-1::member-model"))
        .status
    ).toBe(403);
    expect(
      (await patchModel(app, viewer, sessionId, "provider-1::viewer-model"))
        .status
    ).toBe(403);
    expect(
      (await patchModel(app, outsider, sessionId, "provider-1::other-model"))
        .status
    ).toBe(404);
    expect(
      (await patchModel(app, admin, sessionId, "provider-1::admin-model"))
        .status
    ).toBe(400);
    expect(
      (await patchModel(app, admin, sessionId, "provider-1::session-alt"))
        .status
    ).toBe(204);
    expect((await db.getSession(sessionId))?.modelOverride).toBe(
      "provider-1::session-alt"
    );
  });
});
