import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadComposioConfigFile,
  loadLocalAuthToken,
  saveComposioConfig,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AgentService } from "../../services/agent-service";
import { AuthService } from "../../services/auth-service";
import type { ComposioApiClient } from "../../services/composio-api-client";
import { ComposioService } from "../../services/composio-service";
import { createMinimalHonoApp } from "../test-app-helpers";
import {
  createPlatformAdminUser,
  seedLocalClientUser,
} from "../test-org-helpers";
import { loginUserSession, seedOrgAdmin } from "../test-session-helpers";

const TEST_API_KEY = "ck_test";

function createMockClient(): ComposioApiClient {
  return {
    async createProfileSession() {
      return {
        headers: { Authorization: "Bearer test" },
        sessionId: "sess_1",
        url: "https://mcp.composio.dev/sess_1",
      };
    },
    async deleteConnectedAccount() {},
    async getConnectedAccount() {
      return null;
    },
    async linkToolkitAccount() {
      return { redirectUrl: "https://example.com/oauth" };
    },
    async listCatalogToolkits() {
      return [
        {
          description: "Google Mail",
          logoUrl: null,
          name: "Gmail",
          slug: "gmail",
        },
      ];
    },
    async listSessionTools() {
      return [];
    },
  };
}

function injectMockComposioClient(
  service: ComposioService,
  client: ComposioApiClient
): void {
  (
    service as unknown as {
      apiClientCache: { key: string; client: ComposioApiClient } | null;
    }
  ).apiClientCache = { client, key: TEST_API_KEY };
}

async function createApp() {
  const configDir = await mkdtemp(join(tmpdir(), "atlas-composio-route-"));
  process.env.ATLAS_CONFIG_DIR = configDir;
  await saveComposioConfig({ apiKey: TEST_API_KEY });

  const databaseAdapter = createInMemoryDatabaseAdapter();
  const authService = new AuthService();
  const composioService = new ComposioService(databaseAdapter, authService);
  composioService.reloadConfiguration();
  injectMockComposioClient(composioService, createMockClient());

  return createMinimalHonoApp({
    agent: new AgentService(null, null, databaseAdapter),
    authService,
    composioService,
    databaseAdapter,
  });
}

describe("composio routes", () => {
  test("org admin can enable toolkit and assign it to a profile", async () => {
    const { app, databaseAdapter } = await createApp();
    const { email, password, orgId, profileId } = await seedOrgAdmin(
      databaseAdapter,
      { profileId: "profile_test" }
    );
    const session = await loginUserSession(app, email, password, orgId);

    const enableResponse = await app.fetch(
      new Request("http://localhost:4310/v1/composio/toolkits/gmail/enable", {
        body: JSON.stringify({ toolkitSlug: "gmail" }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(enableResponse.status).toBe(200);
    const enabled = (await enableResponse.json()) as {
      toolkitSlug: string;
      id: string;
    };
    expect(enabled.toolkitSlug).toBe("gmail");

    const assignResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/profiles/${encodeURIComponent(profileId!)}/composio-toolkits`,
        {
          body: JSON.stringify({
            assignments: [{ toolkitId: enabled.id }],
          }),
          headers: session.headers({
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrfToken,
          }),
          method: "PUT",
        }
      )
    );

    expect(assignResponse.status).toBe(200);
    await expect(assignResponse.json()).resolves.toMatchObject({
      assignments: [
        expect.objectContaining({
          toolkitId: enabled.id,
          toolkitSlug: "gmail",
        }),
      ],
    });
  });

  test("org admin can connect an enabled toolkit with their user id", async () => {
    const { app, databaseAdapter } = await createApp();
    const { email, password, orgId } = await seedOrgAdmin(databaseAdapter, {
      profileId: "profile_test",
    });
    const session = await loginUserSession(app, email, password, orgId);

    const enableResponse = await app.fetch(
      new Request("http://localhost:4310/v1/composio/toolkits/gmail/enable", {
        body: JSON.stringify({ toolkitSlug: "gmail" }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(enableResponse.status).toBe(200);

    const connectResponse = await app.fetch(
      new Request("http://localhost:4310/v1/composio/toolkits/gmail/connect", {
        body: JSON.stringify({ callbackOrigin: "http://localhost:3000" }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(connectResponse.status).toBe(200);
    await expect(connectResponse.json()).resolves.toMatchObject({
      redirectUrl: "https://example.com/oauth",
    });

    const connections =
      await databaseAdapter.listComposioUserConnectionsForUser(
        orgId,
        "user_admin"
      );
    expect(connections).toHaveLength(1);
    expect(connections[0]?.userId).toBe("user_admin");
    expect(connections[0]?.status).toBe("oauth_in_progress");
  });

  test("connect route does not return an unsafe OAuth redirect", async () => {
    const { app, composioService, databaseAdapter } = await createApp();
    const { email, password, orgId } = await seedOrgAdmin(databaseAdapter, {
      profileId: "profile_test",
    });
    const session = await loginUserSession(app, email, password, orgId);
    await composioService!.enableToolkit(orgId, { toolkitSlug: "gmail" });
    injectMockComposioClient(composioService!, {
      ...createMockClient(),
      async linkToolkitAccount() {
        return { redirectUrl: "javascript:alert(1)" };
      },
    });

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/composio/toolkits/gmail/connect", {
        body: JSON.stringify({ callbackOrigin: "http://localhost:4310" }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("OAuth URL"),
    });
    expect(
      await databaseAdapter.listComposioUserConnectionsForUser(
        orgId,
        "user_admin"
      )
    ).toEqual([]);
  });

  test("local-token caller cannot borrow the workspace admin OAuth identity", async () => {
    const { app, composioService, databaseAdapter } = await createApp();
    const { orgId } = await seedOrgAdmin(databaseAdapter, {
      profileId: "profile_test",
    });
    await seedLocalClientUser(databaseAdapter);
    await databaseAdapter.upsertOrgMember({
      createdAt: new Date().toISOString(),
      orgId,
      role: "admin",
      userId: "user_local_client",
    });
    await composioService!.enableToolkit(orgId, { toolkitSlug: "gmail" });
    const token = await loadLocalAuthToken();

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/composio/toolkits/gmail/connect", {
        body: JSON.stringify({ callbackOrigin: "http://localhost:4310" }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Org-Id": orgId,
        },
        method: "POST",
      })
    );

    expect(response.status).toBe(403);
    expect(
      await databaseAdapter.listComposioUserConnectionsForUser(
        orgId,
        "user_admin"
      )
    ).toEqual([]);
  });

  test("org member can list toolkits but cannot enable them", async () => {
    const { app, databaseAdapter } = await createApp();
    const { orgId } = await seedOrgAdmin(databaseAdapter, {
      profileId: "profile_test",
    });
    const now = new Date().toISOString();
    const authService = new AuthService();

    await databaseAdapter.createUser({
      createdAt: now,
      email: "member@example.com",
      id: "user_member",
      passwordHash: await authService.hashPassword("password123"),
      updatedAt: now,
    });
    await databaseAdapter.upsertOrgMember({
      createdAt: now,
      orgId,
      role: "member",
      userId: "user_member",
    });

    const session = await loginUserSession(
      app,
      "member@example.com",
      "password123",
      orgId
    );
    const listResponse = await app.fetch(
      new Request("http://localhost:4310/v1/composio/toolkits", {
        headers: session.headers(),
      })
    );

    expect(listResponse.status).toBe(200);

    const enableResponse = await app.fetch(
      new Request("http://localhost:4310/v1/composio/toolkits/gmail/enable", {
        body: JSON.stringify({ toolkitSlug: "gmail" }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(enableResponse.status).toBe(403);
  });

  test("oauth callback does not require a browser session", async () => {
    const { app } = await createApp();

    const response = await app.fetch(
      new Request(
        "http://localhost:4310/v1/composio/oauth/callback?state=not-valid",
        {
          headers: { Accept: "application/json" },
        }
      )
    );

    expect(response.status).not.toBe(401);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid OAuth state.",
    });
  });

  test("oauth callback rejects archived org state and consumes its nonce", async () => {
    const { app, authService, databaseAdapter } = await createApp();
    const { orgId } = await seedOrgAdmin(databaseAdapter, {
      profileId: "profile_archived_oauth",
    });
    const now = new Date().toISOString();
    const nonce = "archived-org-callback-nonce";
    const issuedAt = Date.now();

    await databaseAdapter.upsertComposioToolkit({
      cachedTools: [],
      createdAt: now,
      displayName: "Gmail",
      id: "toolkit_archived_oauth",
      lastError: null,
      orgId,
      status: "enabled",
      toolkitSlug: "gmail",
      updatedAt: now,
    });
    await databaseAdapter.upsertComposioUserConnection({
      connectedAccountId: "ca_existing",
      createdAt: now,
      id: "connection_archived_oauth",
      lastError: null,
      oauthStateHash: authService.hashToken(`${issuedAt}.${nonce}`),
      orgId,
      sessionIdEnc: null,
      status: "oauth_in_progress",
      toolkitId: "toolkit_archived_oauth",
      updatedAt: now,
      userId: "user_admin",
    });
    const organization = await databaseAdapter.getOrganizationById(orgId);
    expect(organization).not.toBeNull();
    await databaseAdapter.upsertOrganization({
      ...organization!,
      archivedAt: now,
    });

    const state = Buffer.from(
      JSON.stringify({
        connectionId: "connection_archived_oauth",
        issuedAt,
        nonce,
        orgId,
        toolkitId: "toolkit_archived_oauth",
        userId: "user_admin",
      })
    ).toString("base64url");
    const response = await app.fetch(
      new Request(
        `http://localhost:4310/v1/composio/oauth/callback?state=${encodeURIComponent(state)}`,
        { headers: { Accept: "application/json" } }
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid OAuth state.",
    });
    expect(
      await databaseAdapter.getComposioUserConnectionById(
        "connection_archived_oauth"
      )
    ).toMatchObject({ oauthStateHash: null, status: "error" });
  });

  test("oauth callback HEAD is not a public mutation", async () => {
    const { app } = await createApp();

    const response = await app.fetch(
      new Request(
        "http://localhost:4310/v1/composio/oauth/callback?state=abc",
        {
          method: "HEAD",
        }
      )
    );

    expect(response.status).toBe(401);
  });

  test("workspace admin cannot read or write the host Composio API key", async () => {
    const { app, databaseAdapter } = await createApp();
    const { email, password, orgId } = await seedOrgAdmin(databaseAdapter, {
      profileId: "profile_test",
    });
    const session = await loginUserSession(app, email, password, orgId);

    const getResponse = await app.fetch(
      new Request("http://localhost:4310/v1/settings/composio", {
        headers: session.headers(),
      })
    );
    expect(getResponse.status).toBe(403);
    await expect(getResponse.json()).resolves.toEqual({
      error: "Superadmin access required",
    });

    const putResponse = await app.fetch(
      new Request("http://localhost:4310/v1/settings/composio", {
        body: JSON.stringify({ apiKey: "ck_workspace_admin" }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "PUT",
      })
    );
    expect(putResponse.status).toBe(403);
    expect(await loadComposioConfigFile()).toMatchObject({
      apiKey: TEST_API_KEY,
    });
  });

  test("superadmin with membership can set the host Composio API key", async () => {
    const { app, authService, databaseAdapter } = await createApp();
    const { orgId } = await seedOrgAdmin(databaseAdapter, {
      profileId: "profile_test",
    });
    await createPlatformAdminUser(
      databaseAdapter,
      authService,
      "platform@example.com",
      "password123"
    );
    const platformUser = await databaseAdapter.getUserByEmail(
      "platform@example.com"
    );
    await databaseAdapter.upsertOrgMember({
      createdAt: new Date().toISOString(),
      orgId,
      role: "admin",
      userId: platformUser!.id,
    });
    const session = await loginUserSession(
      app,
      "platform@example.com",
      "password123",
      orgId
    );

    const getResponse = await app.fetch(
      new Request("http://localhost:4310/v1/settings/composio", {
        headers: session.headers(),
      })
    );
    expect(getResponse.status).toBe(200);

    const putResponse = await app.fetch(
      new Request("http://localhost:4310/v1/settings/composio", {
        body: JSON.stringify({ apiKey: "ck_superadmin_host_key" }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "PUT",
      })
    );
    expect(putResponse.status).toBe(200);
    expect(await loadComposioConfigFile()).toMatchObject({
      apiKey: "ck_superadmin_host_key",
    });
  });
});
