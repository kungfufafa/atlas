import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AuthService } from "../services/auth-service";
import { OrgService } from "../services/org-service";
import { setupTestConfigDir } from "../test-config-dir";
import { createHonoApp } from "./app";
import {
  browserSessionFromResponse,
  loginPlatformAdminSession,
} from "./test-session-helpers";

setupTestConfigDir("atlas-platform-orgs-test-");

function createPlatformApp() {
  const databaseAdapter = createInMemoryDatabaseAdapter();
  const authService = new AuthService();
  const invalidatedOrgIds: string[] = [];
  return {
    app: createHonoApp({
      agent: {
        invalidateSessionsForOrg(orgId: string) {
          invalidatedOrgIds.push(orgId);
        },
        listProfiles: async () => ({ profiles: [{ id: "default" }] }),
      } as any,
      authService,
      automationService: {} as any,
      databaseAdapter,
      mcpService: {} as any,
      orgService: new OrgService(databaseAdapter, authService),
      systemStatus: { getStatus: async () => ({ ok: true }) } as any,
      taskService: {} as any,
      webDistDir: null,
      workerManager: {} as any,
    }),
    authService,
    databaseAdapter,
    invalidatedOrgIds,
  };
}

describe("platform org routes", () => {
  test("platform admin can create and list organizations", async () => {
    const { app, authService, databaseAdapter } = createPlatformApp();
    const session = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter
    );

    const createResponse = await app.fetch(
      new Request("http://localhost:4310/v1/platform/orgs", {
        body: JSON.stringify({ name: "Acme Corp", slug: "acme-corp" }),
        headers: session.headers({
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toEqual({
      adminMember: {
        member: {
          createdAt: expect.any(String),
          email: "platform@example.com",
          name: null,
          phone: null,
          role: "admin",
          userId: expect.stringMatching(/^user_/),
        },
        temporaryPassword: null,
      },
      organization: {
        archivedAt: null,
        createdAt: expect.any(String),
        id: expect.stringMatching(/^org_/),
        name: "Acme Corp",
        skillsCuratorConsolidation: false,
        skillsCuratorLastRunAt: null,
        skillsPostTurnReview: false,
        skillsWriteApproval: false,
        slug: "acme-corp",
        updatedAt: expect.any(String),
      },
    });

    const listResponse = await app.fetch(
      new Request("http://localhost:4310/v1/platform/orgs", {
        headers: session.headers(),
      })
    );

    expect(listResponse.status).toBe(200);
    const payload = (await listResponse.json()) as {
      organizations: Array<{ slug: string }>;
    };
    expect(payload.organizations).toHaveLength(1);
    expect(payload.organizations[0]?.slug).toBe("acme-corp");
  });

  test("non-platform users cannot manage organizations", async () => {
    const { app, authService, databaseAdapter } = createPlatformApp();
    const platformSession = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter
    );

    const createResponse = await app.fetch(
      new Request("http://localhost:4310/v1/platform/orgs", {
        body: JSON.stringify({
          admin: {
            email: "admin@acme.com",
            name: "Acme Admin",
            phone: "+628123456789",
          },
          name: "Acme Corp",
          slug: "acme-corp",
        }),
        headers: platformSession.headers({
          "X-CSRF-Token": platformSession.csrfToken,
        }),
        method: "POST",
      })
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
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
    const orgAdminSession = browserSessionFromResponse(
      orgAdminLogin,
      created.organization.id
    );

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/platform/orgs", {
        body: JSON.stringify({ name: "Beta Corp", slug: "beta-corp" }),
        headers: orgAdminSession.headers({
          "X-CSRF-Token": orgAdminSession.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Superadmin access required",
    });

    const archiveResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/platform/orgs/${created.organization.id}`,
        {
          headers: orgAdminSession.headers({
            "X-CSRF-Token": orgAdminSession.csrfToken,
          }),
          method: "DELETE",
        }
      )
    );
    expect(archiveResponse.status).toBe(403);
  });

  test("returns 409 for duplicate organization slugs", async () => {
    const { app, authService, databaseAdapter } = createPlatformApp();
    const session = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter
    );
    const headers = session.headers({
      "X-CSRF-Token": session.csrfToken,
    });

    const first = await app.fetch(
      new Request("http://localhost:4310/v1/platform/orgs", {
        body: JSON.stringify({ name: "Acme", slug: "acme" }),
        headers,
        method: "POST",
      })
    );
    expect(first.status).toBe(201);

    const second = await app.fetch(
      new Request("http://localhost:4310/v1/platform/orgs", {
        body: JSON.stringify({ name: "Acme 2", slug: "acme" }),
        headers,
        method: "POST",
      })
    );

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({
      error: "Organization slug already exists.",
    });
  });

  test("platform admin archives an org and stale tenant context becomes unusable", async () => {
    const { app, authService, databaseAdapter, invalidatedOrgIds } =
      createPlatformApp();
    const session = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter
    );
    const mutationHeaders = session.headers({
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrfToken,
    });
    const createdIds: string[] = [];
    for (const [name, slug] of [
      ["Acme", "acme"],
      ["Beta", "beta"],
    ] as const) {
      const response = await app.fetch(
        new Request("http://localhost:4310/v1/platform/orgs", {
          body: JSON.stringify({ name, slug }),
          headers: mutationHeaders,
          method: "POST",
        })
      );
      const payload = (await response.json()) as {
        organization: { id: string };
      };
      createdIds.push(payload.organization.id);
    }
    const archivedOrgId = createdIds[0]!;
    const remainingOrgId = createdIds[1]!;
    await databaseAdapter.upsertProfile({
      createdAt: "2026-08-26T00:00:00.000Z",
      id: "profile_retained",
      isDefault: false,
      isSuper: false,
      model: null,
      name: "Retained profile",
      orgId: archivedOrgId,
      systemPrompt: "Retained data",
      updatedAt: "2026-08-26T00:00:00.000Z",
    });

    const archived = await app.fetch(
      new Request(`http://localhost:4310/v1/platform/orgs/${archivedOrgId}`, {
        headers: mutationHeaders,
        method: "DELETE",
      })
    );
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({
      organization: { archivedAt: expect.any(String), id: archivedOrgId },
    });
    expect(invalidatedOrgIds).toEqual([archivedOrgId]);
    await expect(
      databaseAdapter.getProfile("profile_retained")
    ).resolves.toMatchObject({
      orgId: archivedOrgId,
      systemPrompt: "Retained data",
    });

    const staleContext = await app.fetch(
      new Request("http://localhost:4310/v1/profiles", {
        headers: session.headers({}, archivedOrgId),
      })
    );
    expect(staleContext.status).toBe(404);

    const memberships = await app.fetch(
      new Request("http://localhost:4310/v1/auth/orgs", {
        headers: session.headers(),
      })
    );
    await expect(memberships.json()).resolves.toMatchObject({
      orgs: [{ id: remainingOrgId }],
    });

    const updateArchived = await app.fetch(
      new Request(`http://localhost:4310/v1/platform/orgs/${archivedOrgId}`, {
        body: JSON.stringify({ name: "Resurrected" }),
        headers: mutationHeaders,
        method: "PATCH",
      })
    );
    expect(updateArchived.status).toBe(404);

    const archiveLast = await app.fetch(
      new Request(`http://localhost:4310/v1/platform/orgs/${remainingOrgId}`, {
        headers: mutationHeaders,
        method: "DELETE",
      })
    );
    expect(archiveLast.status).toBe(409);
  });
});
