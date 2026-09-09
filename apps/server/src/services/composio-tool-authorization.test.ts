import { describe, expect, test } from "bun:test";
import {
  createInMemoryDatabaseAdapter,
  type StoredComposioToolkitRecord,
  type StoredComposioUserConnectionRecord,
} from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";
import { AuthService } from "./auth-service";
import { ComposioService } from "./composio-service";
import {
  buildComposioConnectTools,
  buildComposioToolDefinitions,
} from "./composio-tool-bridge";
import { McpClientManager } from "./mcp-client-manager";

setupTestConfigDir("atlas-composio-tool-authorization-");
const ORG = "org_connector";
const USER = "user_connector";
const PROFILE = "profile_connector";
const NOW = "2026-09-06T00:00:00.000Z";

async function fixture() {
  const db = createInMemoryDatabaseAdapter();
  await db.upsertOrganization({
    createdAt: NOW,
    id: ORG,
    name: ORG,
    slug: ORG,
    updatedAt: NOW,
  });
  await db.createUser({
    createdAt: NOW,
    email: "connector@example.com",
    id: USER,
    passwordHash: "test",
    updatedAt: NOW,
  });
  await db.upsertOrgMember({
    createdAt: NOW,
    orgId: ORG,
    role: "member",
    userId: USER,
  });
  await db.upsertProfile({
    createdAt: NOW,
    id: PROFILE,
    isSuper: false,
    model: null,
    name: PROFILE,
    orgId: ORG,
    systemPrompt: "",
    updatedAt: NOW,
  });
  const toolkit: StoredComposioToolkitRecord = {
    cachedTools: [
      {
        description: "Read mail",
        inputSchema: { type: "object" },
        name: "Read mail",
        slug: "GMAIL_FETCH_EMAILS",
      },
      {
        description: "Manage",
        inputSchema: { type: "object" },
        name: "Manage",
        slug: "COMPOSIO_MANAGE_CONNECTIONS",
      },
    ],
    createdAt: NOW,
    displayName: "Gmail",
    id: "toolkit_connector",
    lastError: null,
    orgId: ORG,
    status: "enabled",
    toolkitSlug: "gmail",
    updatedAt: NOW,
  };
  const connection: StoredComposioUserConnectionRecord = {
    connectedAccountId: "personal_account",
    createdAt: NOW,
    id: "connection_personal",
    lastError: null,
    oauthStateHash: null,
    orgId: ORG,
    sessionIdEnc: null,
    status: "connected",
    toolkitId: toolkit.id,
    updatedAt: NOW,
    userId: USER,
  };
  await db.upsertComposioToolkit(toolkit);
  await db.upsertComposioUserConnection(connection);
  await db.replaceProfileComposioToolkits(PROFILE, [
    { allowedActions: null, profileId: PROFILE, toolkitId: toolkit.id },
  ]);
  const service = new ComposioService(db, new AuthService());
  service.isAvailable = async () => true;
  let header = "first_test_header";
  service.getProfileSessionEndpoint = async () => ({
    headers: { authorization: header },
    sessionId: "endpoint_session",
    url: "https://mcp.example.invalid",
  });
  const manager = new McpClientManager();
  const calls: Array<{
    key: string;
    slug: string;
    args: Record<string, unknown>;
  }> = [];
  const headers: Array<Record<string, string> | undefined> = [];
  manager.connectHttpEndpoint = async (_key, _url, currentHeaders) => {
    headers.push(currentHeaders);
    return [];
  };
  manager.disconnectHttpEndpoint = async () => {};
  manager.isHttpEndpointConnected = () => true;
  manager.callHttpEndpointTool = async (key, slug, args) => {
    calls.push({ args, key, slug });
    return { ok: true };
  };
  const tools = await buildComposioToolDefinitions(
    ORG,
    USER,
    PROFILE,
    service,
    manager
  );
  const invoke = (action = "gmail_fetch_emails") =>
    tools[1]!.run(
      { action_slug: action, arguments: { max: 1 }, toolkit_slug: "GMAIL" },
      {}
    );
  return {
    calls,
    connection,
    db,
    headers,
    invoke,
    manager,
    rotateHeader: () => {
      header = "rotated_test_header";
    },
    service,
    toolkit,
    tools,
  };
}

describe("Composio invocation authorization against current stored assignments", () => {
  test("a service toolkit change rebuilds the cached agent session", async () => {
    const f = await fixture();
    const agent = new AgentService(null, null, f.db);
    agent.setComposioService(f.service);
    agent.setMcpClientManager(f.manager);
    const sessionId = await agent.createSession(ORG, "web", PROFILE, USER, {
      orgRole: "member",
    });
    const before = await agent.resolveSession(ORG, sessionId);
    expect(before).not.toBeNull();
    await f.service.disableToolkit(ORG, "gmail");
    const after = await agent.resolveSession(ORG, sessionId);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(
      await buildComposioToolDefinitions(
        ORG,
        USER,
        PROFILE,
        f.service,
        f.manager
      )
    ).toEqual([]);
  });
  test.each([
    "getAssignedToolkitRecords",
    "getProfileSessionEndpoint",
  ] as const)(
    "%s rejects a foreign profile before any endpoint work",
    async (method) => {
      const f = await fixture();
      await f.db.upsertProfile({
        createdAt: NOW,
        id: "foreign_profile",
        isSuper: false,
        model: null,
        name: "Foreign",
        orgId: "org_foreign",
        systemPrompt: "",
        updatedAt: NOW,
      });
      await f.db.replaceProfileComposioToolkits("foreign_profile", [
        {
          allowedActions: null,
          profileId: "foreign_profile",
          toolkitId: f.toolkit.id,
        },
      ]);
      const actualService = new ComposioService(f.db, new AuthService());
      await expect(
        actualService[method](ORG, USER, "foreign_profile")
      ).rejects.toMatchObject({ status: 404 });
      expect(f.calls).toHaveLength(0);
    }
  );
  test.each([
    "disabled",
    "unassigned",
    "action_removed",
    "disconnected",
    "account_replaced",
  ] as const)(
    "stale action cannot reach transport after %s",
    async (change) => {
      const f = await fixture();
      expect(await f.invoke()).toEqual({ ok: true });
      expect(f.calls).toEqual([
        {
          args: { max: 1 },
          key: `composio:${ORG}:${USER}:${PROFILE}`,
          slug: "GMAIL_FETCH_EMAILS",
        },
      ]);
      if (change === "disabled") {
        await f.db.upsertComposioToolkit({ ...f.toolkit, status: "disabled" });
      } else if (change === "unassigned") {
        await f.db.replaceProfileComposioToolkits(PROFILE, []);
      } else if (change === "action_removed") {
        await f.db.replaceProfileComposioToolkits(PROFILE, [
          { allowedActions: [], profileId: PROFILE, toolkitId: f.toolkit.id },
        ]);
      } else {
        await f.db.upsertComposioUserConnection({
          ...f.connection,
          ...(change === "disconnected"
            ? { status: "error" as const }
            : { connectedAccountId: "replacement_account" }),
        });
      }
      expect(await f.invoke()).toHaveProperty("error");
      expect(f.calls).toHaveLength(1);
      if (change !== "account_replaced") {
        expect(await f.tools[0]!.run({ query: "" }, {})).toEqual({
          actions: [],
          count: 0,
        });
      }
    }
  );

  test("cannot invoke a foreign toolkit with the same action alias", async () => {
    const f = await fixture();
    await f.db.upsertComposioToolkit({ ...f.toolkit, orgId: "org_foreign" });
    expect(await f.invoke()).toHaveProperty("error");
    expect(f.calls).toHaveLength(0);
  });

  test("never executes provider connection-management meta-actions", async () => {
    const f = await fixture();
    expect(await f.invoke("composio_manage_connections")).toHaveProperty(
      "error"
    );
    expect(f.calls).toHaveLength(0);
  });

  test("does not inherit another user's connected account", async () => {
    const f = await fixture();
    await f.db.upsertComposioUserConnection({
      ...f.connection,
      userId: "other_user",
    });
    expect(await f.invoke()).toHaveProperty("error");
    expect(f.calls).toHaveLength(0);
  });

  test("refreshes endpoint credentials even when its URL stays the same", async () => {
    const f = await fixture();
    f.rotateHeader();
    expect(await f.invoke()).toEqual({ ok: true });
    expect(f.headers.at(-1)).toEqual({ authorization: "rotated_test_header" });
    expect(f.calls).toHaveLength(1);
  });

  test("cannot start OAuth from a cached connect tool after assignment is removed", async () => {
    const f = await fixture();
    await f.db.upsertComposioUserConnection({
      ...f.connection,
      status: "error",
    });
    let oauthCalls = 0;
    f.service.connectToolkit = async () => {
      oauthCalls += 1;
      return { redirectUrl: "https://oauth.example.invalid" };
    };
    const tools = await buildComposioConnectTools(
      ORG,
      USER,
      PROFILE,
      f.service
    );
    expect(tools).toHaveLength(1);
    await f.db.replaceProfileComposioToolkits(PROFILE, []);
    expect(
      await tools[0]!.run(
        { toolkit_slug: "gmail" },
        { clientOrigin: "https://atlas.example.invalid" }
      )
    ).toHaveProperty("error");
    expect(oauthCalls).toBe(0);
  });
});
