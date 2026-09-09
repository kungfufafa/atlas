import { describe, expect, test } from "bun:test";
import { createWorkspaceWorkerAuthToken, type OrgRole } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AgentService } from "../../services/agent-service";
import { createAttachmentSaver } from "../../services/attachment-service";
import { AuthService } from "../../services/auth-service";
import { TaskService } from "../../services/task-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import { loginUserSession } from "../test-session-helpers";

setupTestConfigDir("atlas-session-model-route-");

const ORG_ID = "org_sessions";
const OTHER_ORG_ID = "org_other_sessions";
const PASSWORD = "password123";
const PROFILE_ID = "profile_sessions";
const CORRUPT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVSH2mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
  const taskService = new TaskService(db);
  const { app } = createMinimalHonoApp({
    agent,
    authService,
    databaseAdapter: db,
    taskService,
  });

  return { agent, app, db, taskService };
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

async function createWebSession(
  app: Awaited<ReturnType<typeof createScenario>>["app"],
  session: Awaited<ReturnType<typeof loginUserSession>>
): Promise<string> {
  const response = await app.fetch(
    new Request("http://localhost:4310/v1/sessions", {
      body: JSON.stringify({ channel: "web", profileId: PROFILE_ID }),
      headers: session.headers({ "X-CSRF-Token": session.csrfToken }),
      method: "POST",
    })
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { sessionId: string }).sessionId;
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
  test("rejects malformed and excessive attachments before starting a turn", async () => {
    const { app } = await createScenario();
    const owner = await loginUserSession(
      app,
      "owner@example.com",
      PASSWORD,
      ORG_ID
    );
    const sessionId = await createWebSession(app, owner);
    const requests = [
      { images: "not-an-array", message: "bad shape" },
      {
        documents: [
          {
            data: "YWJj",
            filename: "malware.bin",
            mediaType: "application/octet-stream",
          },
        ],
        message: "bad document",
      },
      {
        documents: Array.from({ length: 6 }, (_, index) => ({
          data: "YWJj",
          filename: `document-${index}.txt`,
          mediaType: "text/plain",
        })),
        message: "too many",
      },
    ];

    for (const requestBody of requests) {
      const response = await app.fetch(
        new Request(`http://localhost:4310/v1/sessions/${sessionId}/messages`, {
          body: JSON.stringify(requestBody),
          headers: owner.headers({ "X-CSRF-Token": owner.csrfToken }),
          method: "POST",
        })
      );
      expect(response.status).toBe(400);

      const status = await app.fetch(
        new Request(`http://localhost:4310/v1/sessions/${sessionId}/status`, {
          headers: owner.headers(),
        })
      );
      expect(await status.json()).toMatchObject({ active: false });
    }
  });

  test("serves only referenced session attachments and supports safe image previews", async () => {
    const { app, db } = await createScenario();
    const owner = await loginUserSession(
      app,
      "owner@example.com",
      PASSWORD,
      ORG_ID
    );
    const sourceSessionId = await createWebSession(app, owner);
    const unrelatedSessionId = await createWebSession(app, owner);
    const save = createAttachmentSaver(db, {
      channel: "web",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      sessionId: sourceSessionId,
    });
    const saved = await save({
      bytes: Buffer.from("image bytes"),
      filename: 'preview\r\n".png',
      kind: "image",
      mediaType: "image/png",
    });
    const referencedMessage = {
      content: [
        {
          attachmentId: saved.attachmentId,
          mediaType: "image/png",
          size: saved.size,
          type: "image_ref" as const,
        },
      ],
      role: "user" as const,
    };
    await db.replaceMessagesForSession(sourceSessionId, [
      {
        createdAt: new Date().toISOString(),
        id: "attachment-message",
        payload: referencedMessage,
        seq: 0,
        sessionId: sourceSessionId,
      },
    ]);

    const download = await app.fetch(
      new Request(
        `http://localhost:4310/v1/sessions/${sourceSessionId}/attachments/${saved.attachmentId}`,
        { headers: owner.headers() }
      )
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toStartWith(
      "attachment;"
    );
    expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await download.text()).toBe("image bytes");

    const preview = await app.fetch(
      new Request(
        `http://localhost:4310/v1/sessions/${sourceSessionId}/attachments/${saved.attachmentId}?inline=1`,
        { headers: owner.headers() }
      )
    );
    expect(preview.headers.get("Content-Disposition")).toStartWith("inline;");
    expect(preview.headers.get("Content-Type")).toBe("image/png");

    const unrelated = await app.fetch(
      new Request(
        `http://localhost:4310/v1/sessions/${unrelatedSessionId}/attachments/${saved.attachmentId}`,
        { headers: owner.headers() }
      )
    );
    expect(unrelated.status).toBe(404);

    const branch = await app.fetch(
      new Request(
        `http://localhost:4310/v1/sessions/${sourceSessionId}/branch`,
        {
          body: JSON.stringify({ messageIndex: 0 }),
          headers: owner.headers({ "X-CSRF-Token": owner.csrfToken }),
          method: "POST",
        }
      )
    );
    const { sessionId: branchSessionId } = (await branch.json()) as {
      sessionId: string;
    };
    const branchAttachment = await app.fetch(
      new Request(
        `http://localhost:4310/v1/sessions/${branchSessionId}/attachments/${saved.attachmentId}`,
        { headers: owner.headers() }
      )
    );
    expect(branchAttachment.status).toBe(200);
  });

  test("rejects corrupt image pixels before starting a session turn", async () => {
    const { app } = await createScenario();
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

    const response = await app.fetch(
      new Request(`http://localhost:4310/v1/sessions/${sessionId}/messages`, {
        body: JSON.stringify({
          images: [{ data: CORRUPT_PNG_BASE64, mediaType: "image/png" }],
          message: "Inspect this image",
        }),
        headers: owner.headers({ "X-CSRF-Token": owner.csrfToken }),
        method: "POST",
      })
    );

    expect(response.status).toBe(400);
  });

  test("rejects an oversized message body before starting a turn", async () => {
    const { app } = await createScenario();
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

    const response = await app.fetch(
      new Request(`http://localhost:4310/v1/sessions/${sessionId}/messages`, {
        body: "{}",
        headers: owner.headers({
          "Content-Length": "40000000",
          "X-CSRF-Token": owner.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Request body is too large.",
    });
  });

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
      status: 404,
    });
    expect(await readModelAccess(app, viewer, sessionId)).toEqual({
      status: 404,
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
        headers: admin.headers({ "X-CSRF-Token": admin.csrfToken }),
        method: "POST",
      })
    );
    expect(branchResponse.status).toBe(201);
    const { sessionId: branchId } = (await branchResponse.json()) as {
      sessionId: string;
    };
    expect((await db.getSession(sessionId))?.userId).toBe("user_owner");
    expect((await db.getSession(branchId))?.userId).toBe("user_admin");
    expect(await readModelAccess(app, member, branchId)).toEqual({
      status: 404,
    });
    expect(await readModelAccess(app, owner, branchId)).toEqual({
      status: 404,
    });
    expect(await readModelAccess(app, admin, branchId)).toEqual({
      canUpdateModel: true,
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

  test("isolates session discovery, reads, controls, and live turns by owner", async () => {
    const { app, db } = await createScenario();
    const owner = await loginUserSession(
      app,
      "owner@example.com",
      PASSWORD,
      ORG_ID
    );
    const member = await loginUserSession(
      app,
      "member@example.com",
      PASSWORD,
      ORG_ID
    );
    const admin = await loginUserSession(
      app,
      "admin@example.com",
      PASSWORD,
      ORG_ID
    );

    const createFor = async (
      session: Awaited<ReturnType<typeof loginUserSession>>
    ): Promise<string> => {
      const response = await app.fetch(
        new Request("http://localhost:4310/v1/sessions", {
          body: JSON.stringify({ channel: "web", profileId: PROFILE_ID }),
          headers: session.headers({ "X-CSRF-Token": session.csrfToken }),
          method: "POST",
        })
      );
      expect(response.status).toBe(201);
      return ((await response.json()) as { sessionId: string }).sessionId;
    };
    const ownerSessionId = await createFor(owner);
    const memberSessionId = await createFor(member);
    const now = new Date().toISOString();
    for (const sessionId of [ownerSessionId, memberSessionId]) {
      await db.replaceMessagesForSession(sessionId, [
        {
          createdAt: now,
          id: `message-${sessionId}`,
          payload: { content: `private-${sessionId}`, role: "user" },
          seq: 0,
          sessionId,
        },
      ]);
    }

    const listFor = async (
      session: Awaited<ReturnType<typeof loginUserSession>>
    ): Promise<string[]> => {
      const response = await app.fetch(
        new Request(
          `http://localhost:4310/v1/sessions?profileId=${PROFILE_ID}&channel=web`,
          { headers: session.headers() }
        )
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        sessions: Array<{ id: string }>;
      };
      return body.sessions.map((item) => item.id);
    };

    expect(await listFor(owner)).toEqual([ownerSessionId]);
    expect(await listFor(member)).toEqual([memberSessionId]);
    expect(new Set(await listFor(admin))).toEqual(
      new Set([ownerSessionId, memberSessionId])
    );

    const memberMutationHeaders = member.headers({
      "Content-Type": "application/json",
      "X-CSRF-Token": member.csrfToken,
    });
    const unauthorizedRequests = [
      new Request(
        `http://localhost:4310/v1/sessions/${ownerSessionId}/messages`,
        { headers: member.headers() }
      ),
      new Request(
        `http://localhost:4310/v1/sessions/${ownerSessionId}/status`,
        { headers: member.headers() }
      ),
      new Request(
        `http://localhost:4310/v1/sessions/${ownerSessionId}/stream`,
        { headers: member.headers() }
      ),
      new Request(
        `http://localhost:4310/v1/sessions/${ownerSessionId}/messages`,
        {
          body: JSON.stringify({ message: "run as victim" }),
          headers: memberMutationHeaders,
          method: "POST",
        }
      ),
      new Request(
        `http://localhost:4310/v1/sessions/${ownerSessionId}/compact`,
        {
          body: JSON.stringify({ force: true }),
          headers: memberMutationHeaders,
          method: "POST",
        }
      ),
      new Request(
        `http://localhost:4310/v1/sessions/${ownerSessionId}/branch`,
        {
          body: JSON.stringify({ messageIndex: 0 }),
          headers: memberMutationHeaders,
          method: "POST",
        }
      ),
      new Request(`http://localhost:4310/v1/sessions/${ownerSessionId}`, {
        headers: memberMutationHeaders,
        method: "DELETE",
      }),
    ];
    for (const request of unauthorizedRequests) {
      expect((await app.fetch(request)).status).toBe(404);
    }
    expect(await db.getSession(ownerSessionId)).not.toBeNull();

    expect(await readModelAccess(app, admin, ownerSessionId)).toEqual({
      canUpdateModel: true,
      status: 200,
    });
    for (const request of [
      new Request(
        `http://localhost:4310/v1/sessions/${ownerSessionId}/stream`,
        { headers: admin.headers() }
      ),
      new Request(
        `http://localhost:4310/v1/sessions/${ownerSessionId}/messages`,
        {
          body: JSON.stringify({ message: "impersonate owner" }),
          headers: admin.headers({
            "Content-Type": "application/json",
            "X-CSRF-Token": admin.csrfToken,
          }),
          method: "POST",
        }
      ),
    ]) {
      expect((await app.fetch(request)).status).toBe(404);
    }

    const adminDelete = await app.fetch(
      new Request(
        `http://localhost:4310/v1/sessions/${ownerSessionId}?purge=true`,
        {
          headers: admin.headers({ "X-CSRF-Token": admin.csrfToken }),
          method: "DELETE",
        }
      )
    );
    expect(adminDelete.status).toBe(204);
    expect(await db.getSession(ownerSessionId)).toBeNull();
  });

  test("binds approval decisions to the owning session and organization", async () => {
    const { agent, app, db } = await createScenario();
    const owner = await loginUserSession(
      app,
      "owner@example.com",
      PASSWORD,
      ORG_ID
    );
    const member = await loginUserSession(
      app,
      "member@example.com",
      PASSWORD,
      ORG_ID
    );
    const createForOwner = async (): Promise<string> => {
      const response = await app.fetch(
        new Request("http://localhost:4310/v1/sessions", {
          body: JSON.stringify({ channel: "web", profileId: PROFILE_ID }),
          headers: owner.headers({ "X-CSRF-Token": owner.csrfToken }),
          method: "POST",
        })
      );
      expect(response.status).toBe(201);
      return ((await response.json()) as { sessionId: string }).sessionId;
    };
    const approvedSessionId = await createForOwner();
    const otherOwnerSessionId = await createForOwner();
    const principal = {
      isPlatformAdmin: false,
      orgId: ORG_ID,
      orgRole: "member" as const,
      userId: "user_owner",
    };
    const run = await agent.executionPlane.startChatRun({
      principal,
      sessionId: approvedSessionId,
    });
    await agent.executionPlane.pauseForApproval({
      approvalId: "approval-session-owner",
      args: { target: "private" },
      checkpoint: {
        remainingToolCalls: [
          {
            arguments: { target: "private" },
            id: "approval-call",
            name: "mutate",
          },
        ],
        resumeStepIndex: 0,
      },
      principal,
      runId: run.id,
      sessionId: approvedSessionId,
      stepIndex: 0,
      toolCallId: "approval-call",
      toolName: "mutate",
    });
    const now = new Date().toISOString();
    await db.upsertActionApproval({
      actionHash: "other-org-hash",
      argsJson: "{}",
      createdAt: now,
      decidedAt: null,
      decidedByUserId: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      grantId: null,
      id: "approval-other-org",
      orgId: OTHER_ORG_ID,
      principalUserId: "user_outsider",
      runId: "run-other-org",
      sessionId: "session-other-org",
      status: "pending",
      stepId: "step-other-org",
      toolName: "mutate",
    });

    const decide = async (
      caller: Awaited<ReturnType<typeof loginUserSession>>,
      sessionId: string,
      approvalId: string,
      decision = "approved"
    ): Promise<Response> =>
      app.fetch(
        new Request(
          `http://localhost:4310/v1/sessions/${sessionId}/approvals/${approvalId}`,
          {
            body: JSON.stringify({ decision }),
            headers: caller.headers({
              "Content-Type": "application/json",
              "X-CSRF-Token": caller.csrfToken,
            }),
            method: "POST",
          }
        )
      );

    expect(
      (await decide(member, approvedSessionId, "approval-session-owner")).status
    ).toBe(404);
    expect(
      (await decide(owner, otherOwnerSessionId, "approval-session-owner"))
        .status
    ).toBe(404);
    expect(
      (await decide(owner, approvedSessionId, "approval-other-org")).status
    ).toBe(404);
    expect((await db.getActionApproval("approval-session-owner"))?.status).toBe(
      "pending"
    );

    expect(
      (await decide(owner, approvedSessionId, "approval-session-owner")).status
    ).toBe(409);
    expect((await db.getActionApproval("approval-session-owner"))?.status).toBe(
      "pending"
    );

    for (const decision of ["approved", "denied"] as const) {
      const approvalId = `approval-live-${decision}`;
      const ready = Promise.withResolvers<void>();
      const live = agent.chatToolApprovals.request(
        {
          approval: {
            createdAt: now,
            id: approvalId,
            status: "pending",
            title: "Delete artifact",
            tool: "delete_file",
            toolCallId: `call-${decision}`,
          },
          beforeDecision: () => Promise.resolve(),
          call: {
            arguments: { path: "artifacts/report.txt" },
            id: `call-${decision}`,
            name: "delete_file",
          },
          principal,
          runId: "live-route-run",
          sessionId: approvedSessionId,
        },
        ready.resolve
      );
      await ready.promise;
      expect((await decide(member, approvedSessionId, approvalId)).status).toBe(
        404
      );
      expect(
        (await decide(owner, otherOwnerSessionId, approvalId)).status
      ).toBe(404);
      expect(
        (await decide(owner, approvedSessionId, approvalId, "invalid")).status
      ).toBe(400);
      const response = await decide(
        owner,
        approvedSessionId,
        approvalId,
        decision
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        resumed: true,
        status: decision,
      });
      expect((await live).decision).toBe(decision);
      expect((await decide(owner, approvedSessionId, approvalId)).status).toBe(
        409
      );
    }
  });

  test("scopes task chat messages and run output to the task session owner", async () => {
    const { app, db, taskService } = await createScenario();
    const owner = await loginUserSession(
      app,
      "owner@example.com",
      PASSWORD,
      ORG_ID
    );
    const member = await loginUserSession(
      app,
      "member@example.com",
      PASSWORD,
      ORG_ID
    );
    const admin = await loginUserSession(
      app,
      "admin@example.com",
      PASSWORD,
      ORG_ID
    );
    const viewer = await loginUserSession(
      app,
      "viewer@example.com",
      PASSWORD,
      ORG_ID
    );
    const createResponse = await app.fetch(
      new Request("http://localhost:4310/v1/sessions", {
        body: JSON.stringify({ channel: "task", profileId: PROFILE_ID }),
        headers: owner.headers({ "X-CSRF-Token": owner.csrfToken }),
        method: "POST",
      })
    );
    expect(createResponse.status).toBe(201);
    const { sessionId } = (await createResponse.json()) as {
      sessionId: string;
    };
    const task = await taskService.create(
      ORG_ID,
      {
        profileId: PROFILE_ID,
        prompt: "Produce private output",
        title: "Private task",
      },
      PROFILE_ID,
      { isPlatformAdmin: false, orgRole: "member" },
      "user_owner"
    );
    await db.upsertTask({ ...task, sessionId });
    const run = await taskService.createRun(task.id);
    await taskService.completeRun(run.id, task.id, {
      output: "private task run output",
    });
    const now = new Date().toISOString();
    await db.replaceMessagesForSession(sessionId, [
      {
        createdAt: now,
        id: "private-task-message",
        payload: { content: "private task chat", role: "assistant" },
        seq: 0,
        sessionId,
      },
    ]);

    const readTask = async (
      caller: Awaited<ReturnType<typeof loginUserSession>>,
      resource: "messages" | "runs"
    ): Promise<Response> =>
      app.fetch(
        new Request(`http://localhost:4310/v1/tasks/${task.id}/${resource}`, {
          headers: caller.headers(),
        })
      );

    for (const caller of [member, viewer]) {
      expect((await readTask(caller, "messages")).status).toBe(404);
      expect((await readTask(caller, "runs")).status).toBe(404);
    }
    for (const caller of [owner, admin]) {
      expect((await readTask(caller, "messages")).status).toBe(200);
      expect((await readTask(caller, "runs")).status).toBe(200);
    }
  });

  test("only a session owner can attach it to a subagent run", async () => {
    const { agent, app } = await createScenario();
    const owner = await loginUserSession(
      app,
      "owner@example.com",
      PASSWORD,
      ORG_ID
    );
    const member = await loginUserSession(
      app,
      "member@example.com",
      PASSWORD,
      ORG_ID
    );
    const admin = await loginUserSession(
      app,
      "admin@example.com",
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
    expect(createResponse.status).toBe(201);
    const { sessionId } = (await createResponse.json()) as {
      sessionId: string;
    };
    const startedFor: string[] = [];
    agent.subagents.start = async (input) => {
      startedFor.push(input.principal.userId);
      const now = new Date().toISOString();
      return {
        budgetMs: 30_000,
        createdAt: now,
        id: "subagent-owned-session",
        orgId: input.orgId,
        parentRunId: null,
        principalUserId: input.principal.userId,
        status: "running",
        task: input.task,
        updatedAt: now,
      };
    };
    const start = async (
      caller: Awaited<ReturnType<typeof loginUserSession>>
    ): Promise<Response> =>
      app.fetch(
        new Request("http://localhost:4310/v1/subagents", {
          body: JSON.stringify({
            profileId: PROFILE_ID,
            sessionId,
            task: "Use the attached session",
          }),
          headers: caller.headers({
            "Content-Type": "application/json",
            "X-CSRF-Token": caller.csrfToken,
          }),
          method: "POST",
        })
      );

    expect((await start(member)).status).toBe(404);
    expect((await start(admin)).status).toBe(404);
    expect((await start(owner)).status).toBe(201);
    expect(startedFor).toEqual(["user_owner"]);
  });

  test("scopes worker session access to a non-viewer persisted principal", async () => {
    const { app, db } = await createScenario();
    const now = new Date().toISOString();
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: "viewer-wa",
      createdAt: now,
      orgId: ORG_ID,
      userId: "user_viewer",
    });
    const whatsappToken = await createWorkspaceWorkerAuthToken({
      channel: "whatsapp",
      orgId: ORG_ID,
    });
    const workerHeaders = {
      Authorization: `Bearer ${whatsappToken}`,
      "Content-Type": "application/json",
    };

    const viewerCreate = await app.fetch(
      new Request("http://localhost:4310/v1/sessions", {
        body: JSON.stringify({
          channel: "whatsapp",
          externalPrincipal: { channelUserId: "viewer-wa" },
          profileId: PROFILE_ID,
        }),
        headers: workerHeaders,
        method: "POST",
      })
    );
    expect(viewerCreate.status).toBe(403);

    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "whatsapp",
      createdAt: now,
      id: "session-worker-owner",
      modelOverride: null,
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      title: null,
      userId: "user_owner",
    });
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "whatsapp",
      createdAt: now,
      id: "session-worker-unattributed",
      modelOverride: null,
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      title: null,
      userId: null,
    });
    await db.replaceMessagesForSession("session-worker-owner", [
      {
        createdAt: now,
        id: "worker-message",
        payload: { content: "worker-visible", role: "user" },
        seq: 0,
        sessionId: "session-worker-owner",
      },
    ]);

    const matchingRead = await app.fetch(
      new Request(
        "http://localhost:4310/v1/sessions/session-worker-owner/messages",
        { headers: workerHeaders }
      )
    );
    expect(matchingRead.status).toBe(200);
    const unattributedRead = await app.fetch(
      new Request(
        "http://localhost:4310/v1/sessions/session-worker-unattributed/messages",
        { headers: workerHeaders }
      )
    );
    expect(unattributedRead.status).toBe(404);
  });
});
