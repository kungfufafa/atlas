import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AgentService } from "../services/agent-service";
import { AuthService } from "../services/auth-service";
import { OrgService } from "../services/org-service";
import { setupTestConfigDir } from "../test-config-dir";
import { createHonoApp } from "./app";
import {
  loginPlatformAdminSession,
  loginUserSession,
  seedOrgAdmin,
} from "./test-session-helpers";

setupTestConfigDir("atlas-coding-harness-settings-test-");

function createTestApp() {
  const databaseAdapter = createInMemoryDatabaseAdapter();
  const authService = new AuthService();
  const app = createHonoApp({
    agent: new AgentService(null, null, databaseAdapter),
    authService,
    automationService: {} as never,
    databaseAdapter,
    mcpService: {} as never,
    orgService: new OrgService(databaseAdapter, authService),
    systemStatus: { getStatus: async () => ({ ok: true }) } as never,
    taskService: {} as never,
    webDistDir: null,
    workerManager: {} as never,
  });
  return { app, authService, databaseAdapter };
}

async function seedOrganization(
  databaseAdapter: ReturnType<typeof createInMemoryDatabaseAdapter>,
  id: string,
  slug: string
): Promise<void> {
  const now = new Date().toISOString();
  await databaseAdapter.upsertOrganization({
    archivedAt: null,
    createdAt: now,
    id,
    name: slug,
    slug,
    updatedAt: now,
  });
}

describe("coding harness auth settings", () => {
  test("is platform-admin-only and isolated per workspace", async () => {
    const { app, authService, databaseAdapter } = createTestApp();
    await seedOrganization(databaseAdapter, "org-a", "org-a");
    await seedOrganization(databaseAdapter, "org-b", "org-b");
    const platform = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter
    );
    const platformUser = await databaseAdapter.getUserByEmail(
      "platform@example.com"
    );
    if (!platformUser) {
      throw new Error("Platform user was not created.");
    }
    for (const orgId of ["org-a", "org-b"]) {
      await databaseAdapter.upsertOrgMember({
        createdAt: new Date().toISOString(),
        orgId,
        role: "admin",
        userId: platformUser.id,
      });
    }

    const update = await app.fetch(
      new Request("http://localhost:4310/v1/settings/coding-harnesses", {
        body: JSON.stringify({ providerPassthroughEnabled: false }),
        headers: platform.headers(
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": platform.csrfToken,
          },
          "org-a"
        ),
        method: "PUT",
      })
    );
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      loginCommands: [
        { command: "codex login", name: "Codex" },
        { command: "claude auth login", name: "Claude Code" },
        { command: "opencode auth login", name: "OpenCode" },
        { command: "pi (then enter /login)", name: "pi.dev" },
      ],
      providerPassthroughEnabled: false,
    });

    const orgA = await app.fetch(
      new Request("http://localhost:4310/v1/settings/coding-harnesses", {
        headers: platform.headers({}, "org-a"),
      })
    );
    const orgB = await app.fetch(
      new Request("http://localhost:4310/v1/settings/coding-harnesses", {
        headers: platform.headers({}, "org-b"),
      })
    );
    await expect(orgA.json()).resolves.toMatchObject({
      providerPassthroughEnabled: false,
    });
    await expect(orgB.json()).resolves.toMatchObject({
      providerPassthroughEnabled: true,
    });
  });

  test("rejects org admins and malformed updates", async () => {
    const { app, authService, databaseAdapter } = createTestApp();
    const orgAdmin = await seedOrgAdmin(databaseAdapter, {
      authService,
      orgId: "org-admin-only",
    });
    const adminSession = await loginUserSession(
      app,
      orgAdmin.email,
      orgAdmin.password,
      orgAdmin.orgId
    );
    const denied = await app.fetch(
      new Request("http://localhost:4310/v1/settings/coding-harnesses", {
        headers: adminSession.headers(),
      })
    );
    expect(denied.status).toBe(403);

    const platform = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter,
      "root@example.com"
    );
    const rootUser = await databaseAdapter.getUserByEmail("root@example.com");
    if (!rootUser) {
      throw new Error("Platform user was not created.");
    }
    await databaseAdapter.upsertOrgMember({
      createdAt: new Date().toISOString(),
      orgId: orgAdmin.orgId,
      role: "admin",
      userId: rootUser.id,
    });
    const malformed = await app.fetch(
      new Request("http://localhost:4310/v1/settings/coding-harnesses", {
        body: JSON.stringify({ providerPassthroughEnabled: "no" }),
        headers: platform.headers(
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": platform.csrfToken,
          },
          orgAdmin.orgId
        ),
        method: "PUT",
      })
    );
    expect(malformed.status).toBe(400);
  });
});
