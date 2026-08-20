import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composioUserId, saveComposioConfig } from "@atlas/core";
import { LOCAL_CLIENT_USER_ID } from "@atlas/core/local-auth";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AuthService } from "./auth-service";
import type { ComposioApiClient } from "./composio-api-client";
import { ComposioService } from "./composio-service";

const TEST_API_KEY = "ck_test";
const USER_ID = "user_admin";
const ORG_ID = "org_1";

function createMockClient(): ComposioApiClient {
  return {
    async createProfileSession(
      userId,
      _toolkitSlugs,
      _allowedTools,
      connectedAccounts = {}
    ) {
      expect(userId).toBe("atlas:user:user_admin");
      expect(connectedAccounts).toEqual({});
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
    async linkToolkitAccount(_userId, _toolkitSlug) {
      return {
        connectedAccountId: "ca_1",
        redirectUrl: "https://example.com/oauth",
      };
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
      return [
        {
          description: "Send an email",
          inputSchema: { properties: {}, type: "object" },
          name: "Send Email",
          slug: "GMAIL_SEND_EMAIL",
        },
      ];
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
  ).apiClientCache = {
    client,
    key: TEST_API_KEY,
  };
}

async function seedOrgWithAdmin(
  db: ReturnType<typeof createInMemoryDatabaseAdapter>
) {
  const now = "2026-01-01T00:00:00.000Z";
  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Org",
    slug: "org",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "admin@example.com",
    id: USER_ID,
    passwordHash: "hash",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "local-client@atlas.internal",
    id: LOCAL_CLIENT_USER_ID,
    passwordHash: "hash",
    updatedAt: now,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role: "admin",
    userId: LOCAL_CLIENT_USER_ID,
  });
  await db.upsertOrgMember({
    createdAt: "2026-01-01T00:00:01.000Z",
    orgId: ORG_ID,
    role: "admin",
    userId: USER_ID,
  });
}

async function createConfiguredService() {
  const configDir = await mkdtemp(join(tmpdir(), "atlas-composio-service-"));
  const previous = process.env.ATLAS_CONFIG_DIR;
  process.env.ATLAS_CONFIG_DIR = configDir;
  await saveComposioConfig({ apiKey: TEST_API_KEY });

  const db = createInMemoryDatabaseAdapter();
  const service = new ComposioService(db, new AuthService());
  injectMockComposioClient(service, createMockClient());

  return {
    db,
    restore() {
      if (previous === undefined) {
        delete process.env.ATLAS_CONFIG_DIR;
      } else {
        process.env.ATLAS_CONFIG_DIR = previous;
      }
    },
    service,
  };
}

describe("ComposioService", () => {
  test("enableToolkit creates org-scoped toolkit row", async () => {
    const { service, restore } = await createConfiguredService();

    try {
      const toolkit = await service.enableToolkit(ORG_ID, {
        toolkitSlug: "gmail",
      });
      expect(toolkit.toolkitSlug).toBe("gmail");
      expect(toolkit.status).toBe("enabled");

      const listed = await service.listToolkits(ORG_ID, USER_ID);
      expect(listed.orgToolkits).toHaveLength(1);
      expect(listed.userConnections).toEqual([]);
    } finally {
      restore();
    }
  });

  test("connectToolkit stores oauth state on user connection and returns redirect URL", async () => {
    const { service, restore } = await createConfiguredService();

    try {
      await service.enableToolkit(ORG_ID, { toolkitSlug: "gmail" });
      const response = await service.connectToolkit(
        ORG_ID,
        USER_ID,
        "gmail",
        "http://localhost:4310"
      );

      expect(response.redirectUrl).toBe("https://example.com/oauth");
      const listed = await service.listToolkits(ORG_ID, USER_ID);
      expect(listed.orgToolkits[0]?.status).toBe("enabled");
      expect(listed.userConnections[0]?.status).toBe("oauth_in_progress");
    } finally {
      restore();
    }
  });

  test("listToolkits surfaces catalogError when catalog fetch fails", async () => {
    const { service, restore } = await createConfiguredService();

    injectMockComposioClient(service, {
      ...createMockClient(),
      async listCatalogToolkits() {
        throw new Error("Failed to fetch toolkits");
      },
    });

    try {
      const listed = await service.listToolkits(ORG_ID, USER_ID);
      expect(listed.configured).toBe(true);
      expect(listed.composioReachable).toBe(false);
      expect(listed.composioAvailable).toBe(false);
      expect(listed.catalogError).toBe("Failed to fetch toolkits");
      expect(listed.catalog).toEqual([]);
      expect(listed.orgToolkits).toEqual([]);
      expect(listed.userConnections).toEqual([]);
    } finally {
      restore();
    }
  });

  test("isReachable probes with limit 1 and caches the result", async () => {
    const { service, restore } = await createConfiguredService();
    let calls = 0;
    let lastLimit: number | undefined;

    injectMockComposioClient(service, {
      ...createMockClient(),
      async listCatalogToolkits(options) {
        calls += 1;
        lastLimit = options?.limit;
        return [
          { description: null, logoUrl: null, name: "Gmail", slug: "gmail" },
        ];
      },
    });

    try {
      expect(await service.isReachable()).toBe(true);
      expect(await service.isReachable()).toBe(true);
      expect(calls).toBe(1);
      expect(lastLimit).toBe(1);

      (
        service as unknown as {
          reachabilityCache: { value: boolean; expiresAt: number } | null;
        }
      ).reachabilityCache = { expiresAt: Date.now() - 1, value: true };

      // Stale cache returns immediately and refreshes in the background.
      expect(await service.isReachable()).toBe(true);
      expect(calls).toBe(1);
      const inflight = (
        service as unknown as { reachabilityInflight: Promise<boolean> | null }
      ).reachabilityInflight;
      expect(inflight).not.toBeNull();
      await inflight;
      expect(calls).toBe(2);

      service.reloadConfiguration();
      injectMockComposioClient(service, {
        ...createMockClient(),
        async listCatalogToolkits(options) {
          calls += 1;
          lastLimit = options?.limit;
          return [];
        },
      });
      expect(await service.isReachable()).toBe(true);
      expect(calls).toBe(3);
      expect(lastLimit).toBe(1);
    } finally {
      restore();
    }
  });

  test("isReachable coalesces concurrent probes", async () => {
    const { service, restore } = await createConfiguredService();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    injectMockComposioClient(service, {
      ...createMockClient(),
      async listCatalogToolkits() {
        calls += 1;
        await gate;
        return [];
      },
    });

    try {
      const pending = Promise.all([
        service.isReachable(),
        service.isReachable(),
        service.isReachable(),
      ]);
      release();
      expect(await pending).toEqual([true, true, true]);
      expect(calls).toBe(1);
    } finally {
      restore();
    }
  });

  test("resolveComposioActingUserId maps local client to earliest human admin", async () => {
    const { db, service, restore } = await createConfiguredService();

    try {
      await seedOrgWithAdmin(db);
      expect(
        await service.resolveComposioActingUserId(ORG_ID, LOCAL_CLIENT_USER_ID)
      ).toBe(USER_ID);
      expect(await service.resolveComposioActingUserId(ORG_ID, USER_ID)).toBe(
        USER_ID
      );
    } finally {
      restore();
    }
  });

  test("getAssignedToolkitRecords uses admin connections for local client sessions", async () => {
    const { db, service, restore } = await createConfiguredService();
    const now = "2026-01-01T00:00:00.000Z";

    try {
      await seedOrgWithAdmin(db);
      const toolkit = await service.enableToolkit(ORG_ID, {
        toolkitSlug: "gmail",
      });
      await db.upsertComposioUserConnection({
        connectedAccountId: "ca_admin",
        createdAt: now,
        id: "cuc_admin",
        lastError: null,
        oauthStateHash: null,
        orgId: ORG_ID,
        sessionIdEnc: null,
        status: "connected",
        toolkitId: toolkit.id,
        updatedAt: now,
        userId: USER_ID,
      });
      await db.upsertProfile({
        createdAt: now,
        id: "profile_1",
        isDefault: true,
        isSuper: false,
        model: null,
        name: "Bot",
        orgId: ORG_ID,
        systemPrompt: "",
        updatedAt: now,
      });
      await db.replaceProfileComposioToolkits("profile_1", [
        { allowedActions: null, profileId: "profile_1", toolkitId: toolkit.id },
      ]);

      const assigned = await service.getAssignedToolkitRecords(
        ORG_ID,
        LOCAL_CLIENT_USER_ID,
        "profile_1"
      );

      expect(assigned).toHaveLength(1);
      expect(assigned[0]?.userConnection?.status).toBe("connected");
      expect(assigned[0]?.userConnection?.userId).toBe(USER_ID);
    } finally {
      restore();
    }
  });

  test("formatProfileConnectionsContext guides search+invoke workflow and tool selection", async () => {
    const { db, service, restore } = await createConfiguredService();
    const now = "2026-01-01T00:00:00.000Z";

    try {
      await seedOrgWithAdmin(db);
      const toolkit = await service.enableToolkit(ORG_ID, {
        toolkitSlug: "gmail",
      });
      await db.upsertComposioUserConnection({
        connectedAccountId: "ca_admin",
        createdAt: now,
        id: "cuc_admin",
        lastError: null,
        oauthStateHash: null,
        orgId: ORG_ID,
        sessionIdEnc: null,
        status: "connected",
        toolkitId: toolkit.id,
        updatedAt: now,
        userId: USER_ID,
      });
      await db.upsertProfile({
        createdAt: now,
        id: "profile_1",
        isDefault: true,
        isSuper: false,
        model: null,
        name: "Bot",
        orgId: ORG_ID,
        systemPrompt: "",
        updatedAt: now,
      });
      await db.replaceProfileComposioToolkits("profile_1", [
        { allowedActions: null, profileId: "profile_1", toolkitId: toolkit.id },
      ]);

      const context = await service.formatProfileConnectionsContext(
        ORG_ID,
        USER_ID,
        "profile_1"
      );

      expect(context).toContain("composio__search_actions");
      expect(context).toContain("composio__invoke_action");
      expect(context).toContain("composio__connect_account");
      // Selection guidance: steer toward web_search for public facts.
      expect(context).toContain("web_search");
      // Per-toolkit connection status line.
      expect(context).toContain("`gmail`");
      expect(context).toContain("connected");
    } finally {
      restore();
    }
  });

  test("formatProfileConnectionsContext omits search/invoke workflow when no toolkit is connected", async () => {
    const { db, service, restore } = await createConfiguredService();
    const now = "2026-01-01T00:00:00.000Z";

    try {
      await seedOrgWithAdmin(db);
      const toolkit = await service.enableToolkit(ORG_ID, {
        toolkitSlug: "gmail",
      });
      await db.upsertProfile({
        createdAt: now,
        id: "profile_unconnected",
        isDefault: false,
        isSuper: false,
        model: null,
        name: "Bot",
        orgId: ORG_ID,
        systemPrompt: "",
        updatedAt: now,
      });
      await db.replaceProfileComposioToolkits("profile_unconnected", [
        {
          allowedActions: null,
          profileId: "profile_unconnected",
          toolkitId: toolkit.id,
        },
      ]);

      const context = await service.formatProfileConnectionsContext(
        ORG_ID,
        USER_ID,
        "profile_unconnected"
      );

      // Assigned toolkit is listed, but no connection exists.
      expect(context).toContain("`gmail`");
      expect(context).toContain("not_connected");
      // The search/invoke workflow is not exposed until a toolkit is connected.
      expect(context).not.toContain("composio__search_actions");
      expect(context).not.toContain("composio__invoke_action");
      // Connect-account guidance is still present.
      expect(context).toContain("composio__connect_account");
    } finally {
      restore();
    }
  });

  test("formatProfileConnectionsContext is empty when no toolkits are assigned", async () => {
    const { db, service, restore } = await createConfiguredService();
    const now = "2026-01-01T00:00:00.000Z";

    try {
      await seedOrgWithAdmin(db);
      await db.upsertProfile({
        createdAt: now,
        id: "profile_empty",
        isDefault: false,
        isSuper: false,
        model: null,
        name: "Bot",
        orgId: ORG_ID,
        systemPrompt: "",
        updatedAt: now,
      });

      const context = await service.formatProfileConnectionsContext(
        ORG_ID,
        USER_ID,
        "profile_empty"
      );

      expect(context).toBe("");
    } finally {
      restore();
    }
  });

  test("completeOAuth rejects an unverified connected_account_id query", async () => {
    const { db, service, restore } = await createConfiguredService();
    const authService = new AuthService();
    const nonce = "oauth-nonce-unverified-account-id";
    const now = "2026-01-01T00:00:00.000Z";

    try {
      await seedOrgWithAdmin(db);
      const toolkit = await service.enableToolkit(ORG_ID, {
        toolkitSlug: "gmail",
      });
      await db.upsertComposioUserConnection({
        connectedAccountId: "ca_from_link",
        createdAt: now,
        id: "cuc_oauth",
        lastError: null,
        oauthStateHash: authService.hashToken(nonce),
        orgId: ORG_ID,
        sessionIdEnc: null,
        status: "oauth_in_progress",
        toolkitId: toolkit.id,
        updatedAt: now,
        userId: USER_ID,
      });

      const state = Buffer.from(
        JSON.stringify({
          connectionId: "cuc_oauth",
          nonce,
          orgId: ORG_ID,
          toolkitId: toolkit.id,
          userId: USER_ID,
        })
      ).toString("base64url");

      await expect(
        service.completeOAuth(state, {
          connectedAccountId: "ca_attacker_hijack",
        })
      ).rejects.toMatchObject({
        message: "Invalid OAuth state.",
        status: 400,
      });

      const connection = await db.getComposioUserConnectionById("cuc_oauth");
      expect(connection?.status).toBe("oauth_in_progress");
      expect(connection?.connectedAccountId).toBe("ca_from_link");
      expect(connection?.oauthStateHash).toBe(authService.hashToken(nonce));
    } finally {
      restore();
    }
  });

  test("completeOAuth accepts a query id only after Composio confirms ownership", async () => {
    const { db, service, restore } = await createConfiguredService();
    const authService = new AuthService();
    const nonce = "oauth-nonce-verified-account-id";
    const now = "2026-01-01T00:00:00.000Z";

    injectMockComposioClient(service, {
      ...createMockClient(),
      async createProfileSession() {
        return {
          headers: { Authorization: "Bearer test" },
          sessionId: "sess_1",
          url: "https://mcp.composio.dev/sess_1",
        };
      },
      async getConnectedAccount(connectedAccountId) {
        if (connectedAccountId !== "ca_verified") {
          return null;
        }
        return { userId: composioUserId(USER_ID) };
      },
    });

    try {
      await seedOrgWithAdmin(db);
      const toolkit = await service.enableToolkit(ORG_ID, {
        toolkitSlug: "gmail",
      });
      await db.upsertComposioUserConnection({
        connectedAccountId: "ca_from_link",
        createdAt: now,
        id: "cuc_oauth_ok",
        lastError: null,
        oauthStateHash: authService.hashToken(nonce),
        orgId: ORG_ID,
        sessionIdEnc: null,
        status: "oauth_in_progress",
        toolkitId: toolkit.id,
        updatedAt: now,
        userId: USER_ID,
      });

      const state = Buffer.from(
        JSON.stringify({
          connectionId: "cuc_oauth_ok",
          nonce,
          orgId: ORG_ID,
          toolkitId: toolkit.id,
          userId: USER_ID,
        })
      ).toString("base64url");

      const result = await service.completeOAuth(state, {
        connectedAccountId: "ca_verified",
      });
      expect(result.toolkitSlug).toBe("gmail");

      const connection = await db.getComposioUserConnectionById("cuc_oauth_ok");
      expect(connection?.status).toBe("connected");
      expect(connection?.connectedAccountId).toBe("ca_verified");
    } finally {
      restore();
    }
  });

  test("completeOAuth reverts oauth_in_progress when sync fails", async () => {
    const { db, service, restore } = await createConfiguredService();
    const authService = new AuthService();
    const nonce = "oauth-nonce-sync-fail";
    const now = "2026-01-01T00:00:00.000Z";

    injectMockComposioClient(service, {
      ...createMockClient(),
      async createProfileSession() {
        throw new Error("composio secret leaked: ck_live_abc123");
      },
    });

    try {
      await seedOrgWithAdmin(db);
      const toolkit = await service.enableToolkit(ORG_ID, {
        toolkitSlug: "gmail",
      });
      await db.upsertComposioUserConnection({
        connectedAccountId: "ca_from_link",
        createdAt: now,
        id: "cuc_oauth_fail",
        lastError: null,
        oauthStateHash: authService.hashToken(nonce),
        orgId: ORG_ID,
        sessionIdEnc: null,
        status: "oauth_in_progress",
        toolkitId: toolkit.id,
        updatedAt: now,
        userId: USER_ID,
      });

      const state = Buffer.from(
        JSON.stringify({
          connectionId: "cuc_oauth_fail",
          nonce,
          orgId: ORG_ID,
          toolkitId: toolkit.id,
          userId: USER_ID,
        })
      ).toString("base64url");

      await expect(service.completeOAuth(state)).rejects.toMatchObject({
        message: "Could not complete Composio connection.",
        status: 400,
      });

      const connection =
        await db.getComposioUserConnectionById("cuc_oauth_fail");
      expect(connection?.status).toBe("oauth_in_progress");
      expect(connection?.oauthStateHash).toBe(authService.hashToken(nonce));
    } finally {
      restore();
    }
  });

  test("completeOAuth maps a null state payload to invalid OAuth state", async () => {
    const { service, restore } = await createConfiguredService();

    try {
      const state = Buffer.from("null").toString("base64url");
      await expect(service.completeOAuth(state)).rejects.toMatchObject({
        message: "Invalid OAuth state.",
        status: 400,
      });
    } finally {
      restore();
    }
  });
});
