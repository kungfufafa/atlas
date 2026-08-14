import { describe, expect, test } from "bun:test";
import type { OrgRole } from "@atlas/core";
import type { AuthService } from "../../services/auth-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import { loginUserSession } from "../test-session-helpers";

setupTestConfigDir("atlas-rbac-mutations-test-");

const ORG_ID = "org_test";
const PASSWORD = "password123";

function createApp() {
  const calls: string[] = [];
  const record =
    (name: string) =>
    async (..._args: unknown[]) => {
      calls.push(name);
      return { id: "x", name: "x", prompt: "x" } as any;
    };

  const result = createMinimalHonoApp({
    agent: {
      configureProvider: record("agent.configureProvider"),
      createProvider: record("agent.createProvider"),
      deleteProvider: record("agent.deleteProvider"),
      discoverModels: record("agent.discoverModels"),
      draftAutomation: record("agent.draftAutomation"),
      draftTaskPrompt: record("agent.draftTaskPrompt"),
      getDiscordSettings: record("agent.getDiscordSettings"),
      getTelegramSettings: record("agent.getTelegramSettings"),
      getWhatsAppSettings: record("agent.getWhatsAppSettings"),
      listProfiles: async () => ({ profiles: [{ id: "default" }] }),
      listProviders: record("agent.listProviders"),
      runAutomation: async () => {
        calls.push("agent.runAutomation");
        return { skipped: false };
      },
      runTask: async () => {
        calls.push("agent.runTask");
        return { skipped: false };
      },
      testProvider: record("agent.testProvider"),
      updateProvider: record("agent.updateProvider"),
    },
    automationService: {
      create: record("automationService.create"),
      delete: record("automationService.delete"),
      deleteRun: record("automationService.deleteRun"),
      get: async () => ({ id: "a", name: "a", prompt: "x" }),
      listRuns: async () => [{ id: "r", status: "ok" }],
      update: record("automationService.update"),
    },
    taskService: {
      create: record("taskService.create"),
      delete: record("taskService.delete"),
      get: async () => ({ id: "t", status: "todo" }),
      listRuns: async () => [{ id: "r", status: "ok" }],
      update: record("taskService.update"),
    },
  });

  return { ...result, calls };
}

async function seedUser(
  databaseAdapter: ReturnType<typeof createApp>["databaseAdapter"],
  authService: AuthService,
  email: string,
  role: OrgRole
) {
  const now = new Date().toISOString();
  const userId = `user_${role}`;
  await databaseAdapter.createUser({
    createdAt: now,
    email,
    id: userId,
    passwordHash: await authService.hashPassword(PASSWORD),
    updatedAt: now,
  });
  await databaseAdapter.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Test Org",
    slug: "test-org",
    updatedAt: now,
  });
  await databaseAdapter.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role,
    userId,
  });
}

// State-changing routes a viewer must not be able to reach.
const MUTATING_ROUTES: Array<{ method: string; path: string; body?: unknown }> =
  [
    {
      body: { channel: "web", prompt: "x" },
      method: "POST",
      path: "/v1/automations/draft",
    },
    {
      body: { name: "x", prompt: "x" },
      method: "POST",
      path: "/v1/automations",
    },
    { body: { name: "x" }, method: "PUT", path: "/v1/automations/a1" },
    { method: "DELETE", path: "/v1/automations/a1" },
    { method: "POST", path: "/v1/automations/a1/run" },
    { method: "DELETE", path: "/v1/automations/a1/runs/r1" },
    {
      body: { description: "x", title: "x" },
      method: "POST",
      path: "/v1/tasks/draft-prompt",
    },
    { body: { prompt: "x", title: "x" }, method: "POST", path: "/v1/tasks" },
    { body: { title: "x" }, method: "PUT", path: "/v1/tasks/t1" },
    { method: "DELETE", path: "/v1/tasks/t1" },
    { method: "POST", path: "/v1/tasks/t1/run" },
  ];

const PROVIDER_MANAGEMENT_ROUTES: Array<{
  method: string;
  path: string;
  body?: unknown;
}> = [
  { method: "GET", path: "/v1/providers" },
  {
    body: { baseUrl: "https://example.com/v1", provider: "openai_compatible" },
    method: "POST",
    path: "/v1/models/discover",
  },
  {
    body: {
      apiKey: "secret",
      baseUrl: "https://example.com/v1",
      type: "openai_compatible",
    },
    method: "POST",
    path: "/v1/providers/test",
  },
  {
    body: {
      apiKey: "secret",
      baseUrl: "https://example.com/v1",
      label: "Example",
      type: "openai_compatible",
    },
    method: "POST",
    path: "/v1/providers",
  },
  {
    body: { label: "Renamed" },
    method: "PATCH",
    path: "/v1/providers/provider_1",
  },
  { method: "DELETE", path: "/v1/providers/provider_1" },
  {
    body: { apiKey: "secret", provider: "openai" },
    method: "PUT",
    path: "/v1/settings/provider",
  },
];

const SYSTEM_SETTINGS_ROUTES = [
  "/v1/settings/email",
  "/v1/settings/agent-browser",
  "/v1/settings/composio",
  "/v1/system/web-public-url",
] as const;

const WORKSPACE_CHANNEL_ROUTES = [
  "/v1/settings/telegram",
  "/v1/settings/discord",
  "/v1/settings/whatsapp",
] as const;

describe("RBAC: viewer cannot reach state-changing automation/task routes", () => {
  for (const route of MUTATING_ROUTES) {
    test(`${route.method} ${route.path} -> 403 for viewer`, async () => {
      const { app, databaseAdapter, authService, calls } = createApp();
      await seedUser(
        databaseAdapter,
        authService,
        "viewer@example.com",
        "viewer"
      );
      const viewer = await loginUserSession(
        app,
        "viewer@example.com",
        PASSWORD,
        ORG_ID
      );

      const response = await app.fetch(
        new Request(`http://localhost:4310${route.path}`, {
          body: route.body ? JSON.stringify(route.body) : undefined,
          headers: viewer.headers({ "X-CSRF-Token": viewer.csrfToken }),
          method: route.method,
        })
      );

      expect(response.status).toBe(403);
      // Guard must reject before any service/agent side effect runs.
      expect(calls).toEqual([]);
    });
  }
});

describe("RBAC: admin can still reach the same routes (not a 403)", () => {
  test("POST /v1/automations is not forbidden for admin", async () => {
    const { app, databaseAdapter, authService } = createApp();
    await seedUser(databaseAdapter, authService, "admin@example.com", "admin");
    const admin = await loginUserSession(
      app,
      "admin@example.com",
      PASSWORD,
      ORG_ID
    );

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/automations", {
        body: JSON.stringify({ name: "x", prompt: "x" }),
        headers: admin.headers({ "X-CSRF-Token": admin.csrfToken }),
        method: "POST",
      })
    );

    expect(response.status).not.toBe(403);
  });
});

describe("RBAC: provider management requires an admin", () => {
  for (const role of ["member", "viewer"] as const) {
    for (const route of PROVIDER_MANAGEMENT_ROUTES) {
      test(`${route.method} ${route.path} -> 403 for ${role}`, async () => {
        const { app, databaseAdapter, authService, calls } = createApp();
        await seedUser(
          databaseAdapter,
          authService,
          `${role}@example.com`,
          role
        );
        const session = await loginUserSession(
          app,
          `${role}@example.com`,
          PASSWORD,
          ORG_ID
        );

        const response = await app.fetch(
          new Request(`http://localhost:4310${route.path}`, {
            body: route.body ? JSON.stringify(route.body) : undefined,
            headers: session.headers({
              "X-CSRF-Token": session.csrfToken,
            }),
            method: route.method,
          })
        );

        expect(response.status).toBe(403);
        expect(calls).toEqual([]);
      });
    }
  }

  test("Workspace Admin can create a provider", async () => {
    const { app, databaseAdapter, authService, calls } = createApp();
    await seedUser(databaseAdapter, authService, "admin@example.com", "admin");
    const admin = await loginUserSession(
      app,
      "admin@example.com",
      PASSWORD,
      ORG_ID
    );

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/providers", {
        body: JSON.stringify({
          apiKey: "secret",
          baseUrl: "https://example.com/v1",
          label: "Example",
          type: "openai_compatible",
        }),
        headers: admin.headers({ "X-CSRF-Token": admin.csrfToken }),
        method: "POST",
      })
    );

    expect(response.status).not.toBe(403);
    expect(calls).toContain("agent.createProvider");
  });
});

describe("RBAC: system settings require Superadmin", () => {
  for (const path of SYSTEM_SETTINGS_ROUTES) {
    test(`GET ${path} -> 403 for Workspace Admin`, async () => {
      const { app, databaseAdapter, authService, calls } = createApp();
      await seedUser(
        databaseAdapter,
        authService,
        "workspace-admin@example.com",
        "admin"
      );
      const admin = await loginUserSession(
        app,
        "workspace-admin@example.com",
        PASSWORD,
        ORG_ID
      );

      const response = await app.fetch(
        new Request(`http://localhost:4310${path}`, {
          headers: admin.headers(),
        })
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Superadmin access required",
      });
      expect(calls).toEqual([]);
    });
  }
});

describe("RBAC: channel settings belong to the workspace", () => {
  for (const path of WORKSPACE_CHANNEL_ROUTES) {
    test(`GET ${path} is available to Workspace Admin`, async () => {
      const { app, databaseAdapter, authService } = createApp();
      await seedUser(
        databaseAdapter,
        authService,
        "workspace-admin@example.com",
        "admin"
      );
      const admin = await loginUserSession(
        app,
        "workspace-admin@example.com",
        PASSWORD,
        ORG_ID
      );

      const response = await app.fetch(
        new Request(`http://localhost:4310${path}`, {
          headers: admin.headers(),
        })
      );

      expect(response.status).not.toBe(403);
    });

    for (const role of ["member", "viewer"] as const) {
      test(`GET ${path} -> 403 for ${role}`, async () => {
        const { app, databaseAdapter, authService, calls } = createApp();
        await seedUser(
          databaseAdapter,
          authService,
          `${role}@example.com`,
          role
        );
        const session = await loginUserSession(
          app,
          `${role}@example.com`,
          PASSWORD,
          ORG_ID
        );

        const response = await app.fetch(
          new Request(`http://localhost:4310${path}`, {
            headers: session.headers(),
          })
        );

        expect(response.status).toBe(403);
        expect(calls).toEqual([]);
      });
    }
  }
});
