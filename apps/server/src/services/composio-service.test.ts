import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composioUserId, saveComposioConfig } from "@atlas/core";
import { LOCAL_CLIENT_USER_ID } from "@atlas/core/local-auth";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AuthService } from "./auth-service";
import type { ComposioApiClient } from "./composio-api-client";
import {
  type ComposioOAuthStatePayload,
  ComposioService,
} from "./composio-service";

const TEST_API_KEY = "ck_test";
const USER_ID = "user_admin";
const ORG_ID = "org_1";

function encodeOAuthState(payload: ComposioOAuthStatePayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function hashOAuthState(
  authService: AuthService,
  nonce: string,
  issuedAt: number
): string {
  return authService.hashToken(`${issuedAt}.${nonce}`);
}

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

async function seedPendingOAuthConnection(options: {
  connectionId: string;
  db: ReturnType<typeof createInMemoryDatabaseAdapter>;
  issuedAt: number;
  legacyHash?: boolean;
  nonce: string;
  service: ComposioService;
}): Promise<{ toolkitId: string }> {
  await seedOrgWithAdmin(options.db);
  const toolkit = await options.service.enableToolkit(ORG_ID, {
    toolkitSlug: "gmail",
  });
  const authService = new AuthService();
  const now = new Date().toISOString();
  await options.db.upsertComposioUserConnection({
    connectedAccountId: "ca_from_link",
    createdAt: now,
    id: options.connectionId,
    lastError: null,
    oauthStateHash: options.legacyHash
      ? authService.hashToken(options.nonce)
      : hashOAuthState(authService, options.nonce, options.issuedAt),
    orgId: ORG_ID,
    sessionIdEnc: null,
    status: "oauth_in_progress",
    toolkitId: toolkit.id,
    updatedAt: now,
    userId: USER_ID,
  });
  return { toolkitId: toolkit.id };
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
    const { db, service, restore } = await createConfiguredService();
    let callbackUrl = "";

    injectMockComposioClient(service, {
      ...createMockClient(),
      async linkToolkitAccount(_userId, _toolkitSlug, nextCallbackUrl) {
        callbackUrl = nextCallbackUrl;
        return {
          connectedAccountId: "ca_1",
          redirectUrl: "https://example.com/oauth",
        };
      },
    });

    try {
      await seedOrgWithAdmin(db);
      await service.enableToolkit(ORG_ID, { toolkitSlug: "gmail" });
      const beforeConnect = Date.now();
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

      const encodedState = new URL(callbackUrl).searchParams.get("state");
      expect(encodedState).not.toBeNull();
      const state = JSON.parse(
        Buffer.from(encodedState!, "base64url").toString("utf8")
      ) as ComposioOAuthStatePayload;
      expect(state.issuedAt).toBeGreaterThanOrEqual(beforeConnect);
      expect(state.issuedAt).toBeLessThanOrEqual(Date.now());
      const connection = await db.getComposioUserConnectionById(
        state.connectionId
      );
      expect(connection?.oauthStateHash).toBe(
        hashOAuthState(new AuthService(), state.nonce, state.issuedAt)
      );
    } finally {
      restore();
    }
  });

  for (const unsafeRedirectUrl of [
    "javascript:alert(1)",
    "http://oauth.example.com/start",
    "https://user:password@oauth.example.com/start",
  ]) {
    test(`connectToolkit rejects unsafe redirect ${unsafeRedirectUrl}`, async () => {
      const { db, service, restore } = await createConfiguredService();
      injectMockComposioClient(service, {
        ...createMockClient(),
        async linkToolkitAccount() {
          return { redirectUrl: unsafeRedirectUrl };
        },
      });

      try {
        await seedOrgWithAdmin(db);
        const toolkit = await service.enableToolkit(ORG_ID, {
          toolkitSlug: "gmail",
        });

        await expect(
          service.connectToolkit(
            ORG_ID,
            USER_ID,
            "gmail",
            "https://atlas.example.com"
          )
        ).rejects.toThrow(/OAuth URL/);
        expect(
          await db.getComposioUserConnection(USER_ID, toolkit.id)
        ).toBeNull();
      } finally {
        restore();
      }
    });
  }

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

  test("resolveComposioActingUserId refuses to borrow a human connection for local client", async () => {
    const { db, service, restore } = await createConfiguredService();

    try {
      await seedOrgWithAdmin(db);
      await expect(
        service.resolveComposioActingUserId(ORG_ID, LOCAL_CLIENT_USER_ID)
      ).rejects.toMatchObject({ status: 403 });
      expect(await service.resolveComposioActingUserId(ORG_ID, USER_ID)).toBe(
        USER_ID
      );
      await expect(
        service.resolveComposioActingUserId("org_other", USER_ID)
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      restore();
    }
  });

  test("getAssignedToolkitRecords fails closed for unbound local client sessions", async () => {
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

      await expect(
        service.getAssignedToolkitRecords(
          ORG_ID,
          LOCAL_CLIENT_USER_ID,
          "profile_1"
        )
      ).rejects.toMatchObject({ status: 403 });
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

  test("completeOAuth rejects and consumes legacy state without issuedAt", async () => {
    const { db, service, restore } = await createConfiguredService();
    const nonce = "oauth-nonce-legacy-no-issued-at";
    const connectionId = "cuc_oauth_legacy";

    try {
      const { toolkitId } = await seedPendingOAuthConnection({
        connectionId,
        db,
        issuedAt: Date.now(),
        legacyHash: true,
        nonce,
        service,
      });
      const state = Buffer.from(
        JSON.stringify({
          connectionId,
          nonce,
          orgId: ORG_ID,
          toolkitId,
          userId: USER_ID,
        })
      ).toString("base64url");

      await expect(service.completeOAuth(state)).rejects.toMatchObject({
        message: "Invalid OAuth state.",
        status: 400,
      });
      expect(
        await db.getComposioUserConnectionById(connectionId)
      ).toMatchObject({
        oauthStateHash: null,
        status: "error",
      });
    } finally {
      restore();
    }
  });

  for (const scenario of [
    {
      issuedAt: () => Date.now() - 60 * 60 * 1000,
      name: "stale",
    },
    {
      issuedAt: () => Date.now() + 5 * 60 * 1000,
      name: "future-dated",
    },
  ]) {
    test(`completeOAuth rejects and consumes ${scenario.name} state`, async () => {
      const { db, service, restore } = await createConfiguredService();
      const nonce = `oauth-nonce-${scenario.name}`;
      const connectionId = `cuc_oauth_${scenario.name}`;
      const issuedAt = scenario.issuedAt();

      try {
        const { toolkitId } = await seedPendingOAuthConnection({
          connectionId,
          db,
          issuedAt,
          nonce,
          service,
        });
        const state = encodeOAuthState({
          connectionId,
          issuedAt,
          nonce,
          orgId: ORG_ID,
          toolkitId,
          userId: USER_ID,
        });

        await expect(service.completeOAuth(state)).rejects.toMatchObject({
          status: 400,
        });
        expect(
          await db.getComposioUserConnectionById(connectionId)
        ).toMatchObject({
          oauthStateHash: null,
          status: "error",
        });
      } finally {
        restore();
      }
    });
  }

  test("completeOAuth binds issuedAt to the nonce hash", async () => {
    const { db, service, restore } = await createConfiguredService();
    const nonce = "oauth-nonce-timestamp-tamper";
    const connectionId = "cuc_oauth_timestamp_tamper";
    const issuedAt = Date.now();

    try {
      const { toolkitId } = await seedPendingOAuthConnection({
        connectionId,
        db,
        issuedAt,
        nonce,
        service,
      });
      const state = encodeOAuthState({
        connectionId,
        issuedAt: issuedAt + 1,
        nonce,
        orgId: ORG_ID,
        toolkitId,
        userId: USER_ID,
      });

      await expect(service.completeOAuth(state)).rejects.toMatchObject({
        message: "Invalid OAuth state.",
        status: 400,
      });
      expect(
        await db.getComposioUserConnectionById(connectionId)
      ).toMatchObject({
        oauthStateHash: hashOAuthState(new AuthService(), nonce, issuedAt),
        status: "oauth_in_progress",
      });
    } finally {
      restore();
    }
  });

  test("completeOAuth atomically rejects a duplicate callback", async () => {
    const { db, service, restore } = await createConfiguredService();
    const nonce = "oauth-nonce-duplicate";
    const issuedAt = Date.now();
    const connectionId = "cuc_oauth_duplicate";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let remoteSessionCalls = 0;

    injectMockComposioClient(service, {
      ...createMockClient(),
      async createProfileSession() {
        remoteSessionCalls += 1;
        markStarted();
        await gate;
        return {
          headers: { Authorization: "Bearer test" },
          sessionId: "sess_duplicate",
          url: "https://mcp.composio.dev/sess_duplicate",
        };
      },
    });

    try {
      const { toolkitId } = await seedPendingOAuthConnection({
        connectionId,
        db,
        issuedAt,
        nonce,
        service,
      });
      const state = encodeOAuthState({
        connectionId,
        issuedAt,
        nonce,
        orgId: ORG_ID,
        toolkitId,
        userId: USER_ID,
      });

      const firstCallback = service.completeOAuth(state);
      await started;
      await expect(service.completeOAuth(state)).rejects.toMatchObject({
        message: "Invalid OAuth state.",
        status: 400,
      });
      release();
      await expect(firstCallback).resolves.toMatchObject({
        orgId: ORG_ID,
        toolkitSlug: "gmail",
      });
      expect(remoteSessionCalls).toBe(1);
      expect(
        await db.getComposioUserConnectionById(connectionId)
      ).toMatchObject({ oauthStateHash: null, status: "connected" });
    } finally {
      release();
      restore();
    }
  });

  test("an old callback cannot overwrite a newly started OAuth flow", async () => {
    const { db, service, restore } = await createConfiguredService();
    const oldNonce = "oauth-nonce-old-flow";
    const oldIssuedAt = Date.now();
    const connectionId = "cuc_oauth_old_vs_new";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let remoteSessionCalls = 0;
    let newCallbackUrl = "";

    injectMockComposioClient(service, {
      ...createMockClient(),
      async createProfileSession() {
        remoteSessionCalls += 1;
        if (remoteSessionCalls === 1) {
          markStarted();
          await gate;
        }
        return {
          headers: { Authorization: "Bearer test" },
          sessionId: `sess_generation_${remoteSessionCalls}`,
          url: `https://mcp.composio.dev/sess_generation_${remoteSessionCalls}`,
        };
      },
      async linkToolkitAccount(_userId, _toolkitSlug, callbackUrl) {
        newCallbackUrl = callbackUrl;
        return {
          connectedAccountId: "ca_new_flow",
          redirectUrl: "https://oauth.example.com/new-flow",
        };
      },
    });

    try {
      const { toolkitId } = await seedPendingOAuthConnection({
        connectionId,
        db,
        issuedAt: oldIssuedAt,
        nonce: oldNonce,
        service,
      });
      const oldState = encodeOAuthState({
        connectionId,
        issuedAt: oldIssuedAt,
        nonce: oldNonce,
        orgId: ORG_ID,
        toolkitId,
        userId: USER_ID,
      });

      const oldCallback = service.completeOAuth(oldState);
      await started;
      await service.connectToolkit(
        ORG_ID,
        USER_ID,
        "gmail",
        "https://atlas.example.com"
      );
      const encodedNewState = new URL(newCallbackUrl).searchParams.get("state");
      expect(encodedNewState).not.toBeNull();
      const newState = JSON.parse(
        Buffer.from(encodedNewState!, "base64url").toString("utf8")
      ) as ComposioOAuthStatePayload;

      release();
      await expect(oldCallback).rejects.toMatchObject({
        message: "Invalid OAuth state.",
        status: 400,
      });
      expect(
        await db.getComposioUserConnectionById(connectionId)
      ).toMatchObject({
        connectedAccountId: "ca_new_flow",
        oauthStateHash: hashOAuthState(
          new AuthService(),
          newState.nonce,
          newState.issuedAt
        ),
        status: "oauth_in_progress",
      });

      await expect(
        service.completeOAuth(encodedNewState!)
      ).resolves.toMatchObject({ orgId: ORG_ID, toolkitSlug: "gmail" });
      expect(
        await db.getComposioUserConnectionById(connectionId)
      ).toMatchObject({
        connectedAccountId: "ca_new_flow",
        oauthStateHash: null,
        status: "connected",
      });
      expect(remoteSessionCalls).toBe(2);
    } finally {
      release();
      restore();
    }
  });

  test("completeOAuth rejects an unverified connected_account_id query", async () => {
    const { db, service, restore } = await createConfiguredService();
    const authService = new AuthService();
    const nonce = "oauth-nonce-unverified-account-id";
    const issuedAt = Date.now();
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
        oauthStateHash: hashOAuthState(authService, nonce, issuedAt),
        orgId: ORG_ID,
        sessionIdEnc: null,
        status: "oauth_in_progress",
        toolkitId: toolkit.id,
        updatedAt: now,
        userId: USER_ID,
      });

      const state = encodeOAuthState({
        connectionId: "cuc_oauth",
        issuedAt,
        nonce,
        orgId: ORG_ID,
        toolkitId: toolkit.id,
        userId: USER_ID,
      });

      await expect(
        service.completeOAuth(state, {
          connectedAccountId: "ca_attacker_hijack",
        })
      ).rejects.toMatchObject({
        message: "Invalid OAuth state.",
        status: 400,
      });

      const connection = await db.getComposioUserConnectionById("cuc_oauth");
      expect(connection?.status).toBe("error");
      expect(connection?.connectedAccountId).toBe("ca_from_link");
      expect(connection?.oauthStateHash).toBeNull();
    } finally {
      restore();
    }
  });

  test("completeOAuth rejects an archived org and invalidates its pending state", async () => {
    const { db, service, restore } = await createConfiguredService();
    const authService = new AuthService();
    const nonce = "oauth-nonce-archived-org";
    const issuedAt = Date.now();
    const now = "2026-01-01T00:00:00.000Z";
    let remoteCalls = 0;

    injectMockComposioClient(service, {
      ...createMockClient(),
      async createProfileSession() {
        remoteCalls += 1;
        return {
          headers: { Authorization: "Bearer test" },
          sessionId: "should-not-be-created",
          url: "https://mcp.composio.dev/should-not-be-created",
        };
      },
      async getConnectedAccount() {
        remoteCalls += 1;
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
        id: "cuc_oauth_archived",
        lastError: null,
        oauthStateHash: hashOAuthState(authService, nonce, issuedAt),
        orgId: ORG_ID,
        sessionIdEnc: null,
        status: "oauth_in_progress",
        toolkitId: toolkit.id,
        updatedAt: now,
        userId: USER_ID,
      });

      const organization = await db.getOrganizationById(ORG_ID);
      expect(organization).not.toBeNull();
      await db.upsertOrganization({
        ...organization!,
        archivedAt: "2026-01-02T00:00:00.000Z",
      });
      const state = encodeOAuthState({
        connectionId: "cuc_oauth_archived",
        issuedAt,
        nonce,
        orgId: ORG_ID,
        toolkitId: toolkit.id,
        userId: USER_ID,
      });

      await expect(service.completeOAuth(state)).rejects.toMatchObject({
        message: "Invalid OAuth state.",
        status: 400,
      });
      expect(remoteCalls).toBe(0);

      const connection =
        await db.getComposioUserConnectionById("cuc_oauth_archived");
      expect(connection?.status).toBe("error");
      expect(connection?.oauthStateHash).toBeNull();
      expect(connection?.connectedAccountId).toBe("ca_from_link");
    } finally {
      restore();
    }
  });

  for (const race of [
    {
      connectedUpsertNumber: 1,
      name: "immediately after the provisional connected upsert",
    },
    {
      connectedUpsertNumber: 3,
      name: "immediately after the final connected upsert",
    },
  ]) {
    test(`completeOAuth cannot leave a connection active when archived ${race.name}`, async () => {
      const { db, service, restore } = await createConfiguredService();
      const nonce = `oauth-race-${race.name}`;
      const connectionId = `cuc_${race.name.replaceAll(/[^a-z]+/g, "_")}`;
      const issuedAt = Date.now();

      injectMockComposioClient(service, {
        ...createMockClient(),
        async createProfileSession() {
          return {
            headers: { Authorization: "Bearer test" },
            sessionId: "sess_race",
            url: "https://mcp.composio.dev/sess_race",
          };
        },
      });

      try {
        const { toolkitId } = await seedPendingOAuthConnection({
          connectionId,
          db,
          issuedAt,
          nonce,
          service,
        });
        const originalCompareAndSwap =
          db.compareAndSwapComposioUserConnection.bind(db);
        let archivedDuringUpsert = false;
        let connectedUpserts = 0;
        db.compareAndSwapComposioUserConnection = async (
          connection,
          expectedOAuthStateHash
        ) => {
          const swapped = await originalCompareAndSwap(
            connection,
            expectedOAuthStateHash
          );
          if (swapped && connection.status === "connected") {
            connectedUpserts += 1;
          }
          if (
            !archivedDuringUpsert &&
            connectedUpserts === race.connectedUpsertNumber
          ) {
            archivedDuringUpsert = true;
            const organization = await db.getOrganizationById(ORG_ID);
            if (!organization) {
              throw new Error("Missing OAuth race-test organization.");
            }
            await db.upsertOrganization({
              ...organization,
              archivedAt: new Date().toISOString(),
            });
          }
          return swapped;
        };
        const state = encodeOAuthState({
          connectionId,
          issuedAt,
          nonce,
          orgId: ORG_ID,
          toolkitId,
          userId: USER_ID,
        });

        await expect(service.completeOAuth(state)).rejects.toMatchObject({
          status: 400,
        });
        expect(archivedDuringUpsert).toBe(true);
        expect(
          await db.getComposioUserConnectionById(connectionId)
        ).toMatchObject({
          oauthStateHash: null,
          sessionIdEnc: null,
          status: "error",
        });
      } finally {
        restore();
      }
    });
  }

  test("completeOAuth accepts a query id only after Composio confirms ownership", async () => {
    const { db, service, restore } = await createConfiguredService();
    const authService = new AuthService();
    const nonce = "oauth-nonce-verified-account-id";
    const issuedAt = Date.now();
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
        oauthStateHash: hashOAuthState(authService, nonce, issuedAt),
        orgId: ORG_ID,
        sessionIdEnc: null,
        status: "oauth_in_progress",
        toolkitId: toolkit.id,
        updatedAt: now,
        userId: USER_ID,
      });

      const state = encodeOAuthState({
        connectionId: "cuc_oauth_ok",
        issuedAt,
        nonce,
        orgId: ORG_ID,
        toolkitId: toolkit.id,
        userId: USER_ID,
      });

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
    const issuedAt = Date.now();
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
        oauthStateHash: hashOAuthState(authService, nonce, issuedAt),
        orgId: ORG_ID,
        sessionIdEnc: null,
        status: "oauth_in_progress",
        toolkitId: toolkit.id,
        updatedAt: now,
        userId: USER_ID,
      });

      const state = encodeOAuthState({
        connectionId: "cuc_oauth_fail",
        issuedAt,
        nonce,
        orgId: ORG_ID,
        toolkitId: toolkit.id,
        userId: USER_ID,
      });

      await expect(service.completeOAuth(state)).rejects.toMatchObject({
        message: "Could not complete Composio connection.",
        status: 400,
      });

      const connection =
        await db.getComposioUserConnectionById("cuc_oauth_fail");
      expect(connection?.status).toBe("error");
      expect(connection?.oauthStateHash).toBeNull();
      expect(connection?.lastError).not.toContain("ck_live_abc123");
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
