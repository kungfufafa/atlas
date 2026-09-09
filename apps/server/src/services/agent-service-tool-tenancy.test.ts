import { describe, expect, test } from "bun:test";
import {
  type AgentChatSession,
  type AgentChatSessionOptions,
  type AgentHarness,
  createAgentHarness,
  executeToolCall,
} from "@atlas/agent";
import {
  type AgentChannel,
  getProfileSoulDir,
  type OrgRole,
  type ProviderClient,
} from "@atlas/core";
import {
  createInMemoryDatabaseAdapter,
  type StoredMcpServerRecord,
} from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";
import { McpClientManager } from "./mcp-client-manager";
import { McpService } from "./mcp-service";

setupTestConfigDir("atlas-tool-tenancy-");

const ORG_ID = "org_tool_tenancy";
const PROFILE_ID = "profile_tool_tenancy";
const USER_ID = "user_tool_tenancy";
const NOW = "2026-09-06T00:00:00.000Z";

async function fixture(
  role: OrgRole = "admin",
  platformAdmin = false,
  channel: AgentChannel = "web"
) {
  const db = createInMemoryDatabaseAdapter();
  for (const orgId of [ORG_ID, "org_foreign_tools"]) {
    await db.upsertOrganization({
      createdAt: NOW,
      id: orgId,
      name: orgId,
      slug: orgId,
      updatedAt: NOW,
    });
  }
  await db.createUser({
    createdAt: NOW,
    email: "tool-tenancy@example.com",
    id: USER_ID,
    isPlatformAdmin: platformAdmin,
    name: "Tool operator",
    passwordHash: "test",
    updatedAt: NOW,
  });
  await db.upsertOrgMember({
    createdAt: NOW,
    orgId: ORG_ID,
    role,
    userId: USER_ID,
  });
  const profile = {
    createdAt: NOW,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Tool profile",
    orgId: ORG_ID,
    systemPrompt: "",
    updatedAt: NOW,
  };
  await db.upsertProfile(profile);
  for (const name of [
    "calculator",
    "python_execute",
    "bash",
    "tool_search",
    "office_document",
    "pdf_document",
    "spreadsheet",
    "read_file",
  ]) {
    await db.upsertTool({
      createdAt: NOW,
      description: name,
      handlerConfig: {},
      handlerType: "builtin",
      id: `tool_tenancy_${name}`,
      name,
      orgId: ORG_ID,
      updatedAt: NOW,
    });
    await db.assignToolToProfile(PROFILE_ID, `tool_tenancy_${name}`);
  }
  const service = new AgentService(null, null, db);
  let captured: AgentChatSessionOptions | undefined;
  const generatedSession: AgentChatSession = {
    clear() {},
    compact: async () => ({
      action: "none",
      messagesAfter: 0,
      messagesBefore: 0,
    }),
    createAutomation: async () => {
      throw new Error("unused");
    },
    getContextUsage: () => null,
    getHistory: () => [],
    getHistoryRevision: () => 0,
    send: async () => "unused",
    sendStream: async () => "unused",
  };
  (
    service as unknown as { createHarnessForProfile: () => AgentHarness }
  ).createHarnessForProfile = () => ({
    createAutomationFromPrompt: async () => {
      throw new Error("unused");
    },
    createChatSession(options) {
      captured = options;
      return generatedSession;
    },
  });
  const sessionId = await service.createSession(
    ORG_ID,
    channel,
    PROFILE_ID,
    USER_ID,
    {
      isPlatformAdmin: platformAdmin,
      orgRole: role,
    }
  );
  await service.resolveSession(ORG_ID, sessionId);
  const options = () => {
    if (!(captured?.toolContext && captured.tools)) {
      throw new Error("Missing captured service tool context");
    }
    return { context: captured.toolContext, tools: captured.tools };
  };
  return { db, options, profile, service, sessionId };
}

const calculate = ({
  context,
  tools,
}: ReturnType<Awaited<ReturnType<typeof fixture>>["options"]>) =>
  executeToolCall(
    tools,
    {
      arguments: { expression: "1 + 2" },
      id: crypto.randomUUID(),
      name: "calculator",
    },
    context
  );

describe("AgentService tool tenancy and live authorization", () => {
  test("an MCP service change rebuilds the next session catalog", async () => {
    const { db, options, service, sessionId } = await fixture();
    const manager = new McpClientManager();
    const mcp = new McpService(db, manager);
    const { server } = await mcp.createServer(ORG_ID, {
      config: { url: "https://mcp.example.invalid" },
      connect: false,
      name: "reloading",
      transport: "http",
    });
    const record = await db.getMcpServer(server.id);
    if (!record) {
      throw new Error("Missing MCP server");
    }
    await db.upsertMcpServer({
      ...record,
      cachedTools: [{ description: "Read", name: "read" }],
    });
    await mcp.assignServerToProfile(ORG_ID, PROFILE_ID, server.id);
    service.setMcpClientManager(manager);
    service.setMcpService(mcp);
    await service.resolveSession(ORG_ID, sessionId);
    const stale = options();
    expect(stale.tools.map((tool) => tool.name)).toContain("reloading__read");
    await mcp.updateServer(ORG_ID, server.id, { enabled: false });
    await service.resolveSession(ORG_ID, sessionId);
    expect(options().tools.map((tool) => tool.name)).not.toContain(
      "reloading__read"
    );
    expect(await calculate(options())).toMatchObject({ result: 3 });
    expect(await calculate(stale)).toMatchObject({ errorCode: "CANCELLED" });
  });
  test.each([
    { args: { command: "true" }, name: "bash" },
    { args: { code: "print(1)" }, name: "python_execute" },
    {
      args: { documentRef: "example.docx", operation: "inspect" },
      name: "office_document",
    },
    {
      args: { documentRef: "example.pdf", operation: "inspect" },
      name: "pdf_document",
    },
    { args: { action: "inspect", path: "example.xlsx" }, name: "spreadsheet" },
    { args: { path: "example.txt" }, name: "read_file" },
  ])(
    "revoked admin context cannot reach the $name handler",
    async ({ name, args }) => {
      const { db, options } = await fixture();
      const { tools, context } = options();
      const assigned = tools.find((tool) => tool.name === name);
      if (!assigned) {
        throw new Error(`Missing assigned tool ${name}`);
      }
      let handlerCalls = 0;
      const probe = {
        ...assigned,
        async run() {
          handlerCalls += 1;
          return { ok: true };
        },
      };
      expect(
        await executeToolCall(
          [probe],
          { arguments: args, id: "authorized", name },
          context
        )
      ).toMatchObject({ ok: true });
      await db.upsertOrgMember({
        createdAt: NOW,
        orgId: ORG_ID,
        role: "member",
        userId: USER_ID,
      });
      expect(
        await executeToolCall(
          [probe],
          { arguments: args, id: "revoked", name },
          context
        )
      ).toMatchObject({ errorCode: "PERMISSION_DENIED" });
      expect(handlerCalls).toBe(1);
    }
  );
  test.each(["disabled", "configuration", "unassigned"] as const)(
    "MCP cached tool refuses transport after its server is %s",
    async (change) => {
      const { db, service, options, sessionId } = await fixture();
      const server: StoredMcpServerRecord = {
        cachedTools: [
          {
            description: "Read MCP data",
            inputSchema: { type: "object" },
            name: "read",
          },
        ],
        config: { url: "https://mcp.example.invalid" },
        createdAt: NOW,
        enabled: true,
        id: "mcp_tenant",
        lastError: null,
        name: "tenant_mcp",
        orgId: ORG_ID,
        status: "connected",
        transport: "http",
        updatedAt: NOW,
      };
      await db.upsertMcpServer(server);
      await db.assignMcpServerToProfile(PROFILE_ID, server.id);
      const manager = new McpClientManager();
      let transportCalls = 0;
      manager.isConnected = () => true;
      manager.disconnect = async () => {};
      manager.callTool = async () => {
        transportCalls += 1;
        return { ok: true };
      };
      service.setMcpClientManager(manager);
      await service.resolveSession(ORG_ID, sessionId);
      const stale = options();
      const invoke = () =>
        executeToolCall(
          stale.tools,
          { arguments: {}, id: crypto.randomUUID(), name: "tenant_mcp__read" },
          stale.context
        );
      expect(await invoke()).toEqual({ ok: true });
      if (change === "unassigned") {
        await db.unassignMcpServerFromProfile(PROFILE_ID, server.id);
      } else {
        await new McpService(db, manager).updateServer(
          ORG_ID,
          server.id,
          change === "disabled"
            ? { enabled: false }
            : { config: { url: "https://other.example.invalid" } }
        );
      }
      expect(await invoke()).toMatchObject({ errorCode: "PERMISSION_DENIED" });
      expect(transportCalls).toBe(1);
    }
  );
  test.each(["whatsapp", "telegram", "discord"] as const)(
    "%s paired member loses executable tools immediately after becoming a viewer",
    async (channel) => {
      const { db, options } = await fixture("member", false, channel);
      const stale = options();
      expect(await calculate(stale)).toMatchObject({ result: 3 });
      await db.upsertOrgMember({
        createdAt: NOW,
        orgId: ORG_ID,
        role: "viewer",
        userId: USER_ID,
      });
      expect(await calculate(stale)).toMatchObject({
        errorCode: "PERMISSION_DENIED",
      });
    }
  );

  test.each(["normal", "runtime"] as const)(
    "%s provider dispatch cannot execute a second tool after membership revocation",
    async (transport) => {
      const { db, options } = await fixture("member");
      const { context, tools } = options();
      const calculator = tools.find((tool) => tool.name === "calculator");
      if (!calculator) {
        throw new Error("Missing calculator");
      }
      let effects = 0;
      const guarded = {
        ...calculator,
        run: async () => {
          effects += 1;
          return { result: 3 };
        },
      };
      let generations = 0;
      const call = (id: string) => ({
        arguments: { expression: "1+2" },
        id,
        name: "calculator",
      });
      const provider: ProviderClient = {
        async generateChat(input) {
          generations += 1;
          if (transport === "runtime") {
            if (!input.executeToolCall) {
              throw new Error("Missing runtime dispatcher");
            }
            expect((await input.executeToolCall(call("first"))).success).toBe(
              true
            );
            await db.deleteOrgMember(ORG_ID, USER_ID);
            expect((await input.executeToolCall(call("second"))).success).toBe(
              false
            );
          } else if (generations <= 2) {
            if (generations === 2) {
              await db.deleteOrgMember(ORG_ID, USER_ID);
            }
            const toolCalls = [call(`call_${generations}`)];
            return {
              assistantMessage: { content: "", role: "assistant", toolCalls },
              content: "",
              toolCalls,
            };
          }
          return {
            assistantMessage: { content: "done", role: "assistant" },
            content: "done",
            toolCalls: [],
          };
        },
        generateText: async () => ({ content: "unused" }),
        name: transport === "runtime" ? "chatgpt" : "openai",
        streamChat: async () => {
          throw new Error("unused");
        },
      };
      const session = createAgentHarness({ provider }).createChatSession({
        toolContext: context,
        tools: [guarded],
      });
      await session.send("Run two calculations.");
      expect(effects).toBe(1);
    }
  );
  test.each(["member", "admin"] as const)(
    "allows current %s in the profile workspace",
    async (role) => {
      const { options } = await fixture(role);
      expect(options().context.workspaceRoot).toBe(
        getProfileSoulDir(ORG_ID, PROFILE_ID)
      );
      expect(await calculate(options())).toMatchObject({ result: 3 });
    }
  );

  test.each(["viewer", "removed", "member"] as const)(
    "blocks cached admin tools after role becomes %s",
    async (change) => {
      const { db, options } = await fixture();
      const stale = options();
      expect(await calculate(stale)).toMatchObject({ result: 3 });
      if (change === "removed") {
        await db.deleteOrgMember(ORG_ID, USER_ID);
      } else {
        await db.upsertOrgMember({
          createdAt: NOW,
          orgId: ORG_ID,
          role: change,
          userId: USER_ID,
        });
      }
      expect(await calculate(stale)).toMatchObject({
        errorCode: "PERMISSION_DENIED",
      });
    }
  );

  test("allows a platform admin without an org membership", async () => {
    const { db, options } = await fixture("admin", true);
    await db.deleteOrgMember(ORG_ID, USER_ID);
    expect(await calculate(options())).toMatchObject({ result: 3 });
  });

  test("blocks tools for a current viewer even if a session was loaded internally", async () => {
    const { options } = await fixture("viewer");
    expect(await calculate(options())).toMatchObject({
      errorCode: "PERMISSION_DENIED",
    });
  });

  test("search activation cannot restore an unassigned Python tool", async () => {
    const { service, sessionId, options } = await fixture();
    const search = await executeToolCall(
      options().tools,
      {
        arguments: { query: "python_execute" },
        id: "activate_python",
        name: "tool_search",
      },
      options().context
    );
    expect(search).toMatchObject({ activatedTools: ["python_execute"] });
    await service.unassignTool(
      ORG_ID,
      PROFILE_ID,
      "tool_tenancy_python_execute"
    );
    await service.resolveSession(ORG_ID, sessionId);
    expect(options().tools.map((tool) => tool.name)).not.toContain(
      "python_execute"
    );
    const result = await executeToolCall(
      options().tools,
      {
        arguments: { code: "print('unauthorized')" },
        id: "revoked_python",
        name: "python_execute",
      },
      options().context
    );
    expect(result).toHaveProperty("error");
  });

  test("revoking an assigned tool cancels the already resolved tool closure", async () => {
    const { service, options } = await fixture();
    const stale = options();
    expect(await calculate(stale)).toMatchObject({ result: 3 });
    await service.unassignTool(ORG_ID, PROFILE_ID, "tool_tenancy_calculator");
    expect(await calculate(stale)).toMatchObject({ errorCode: "CANCELLED" });
  });

  test("deleting an org tool cancels the already resolved tool closure", async () => {
    const { service, options } = await fixture();
    const stale = options();
    await service.deleteTool(ORG_ID, "tool_tenancy_calculator");
    expect(await calculate(stale)).toMatchObject({ errorCode: "CANCELLED" });
  });

  test("foreign tenant tool assignments are neither exposed nor searchable", async () => {
    const { db, service, options, sessionId } = await fixture();
    await db.upsertTool({
      createdAt: NOW,
      description: "Foreign document reader",
      handlerConfig: {},
      handlerType: "builtin",
      id: "foreign_search_files",
      name: "search_files",
      orgId: "org_foreign_tools",
      updatedAt: NOW,
    });
    await db.assignToolToProfile(PROFILE_ID, "foreign_search_files");
    service.invalidateSessionsForOrg(ORG_ID);
    await service.resolveSession(ORG_ID, sessionId);
    expect(options().tools.map((tool) => tool.name)).not.toContain(
      "search_files"
    );
    expect(
      await executeToolCall(
        options().tools,
        {
          arguments: { query: "search_files" },
          id: "foreign_search",
          name: "tool_search",
        },
        options().context
      )
    ).toMatchObject({ totalMatches: 0 });
  });

  test("rejects a foreign principal before automation configuration or provider work", async () => {
    const { service } = await fixture();
    await expect(
      service.runAutomationPrompt(
        ORG_ID,
        PROFILE_ID,
        "inspect files",
        undefined,
        undefined,
        {
          isPlatformAdmin: false,
          orgId: "org_foreign_tools",
          orgRole: "admin",
          userId: USER_ID,
        }
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  test.each(["member", "viewer"] as const)(
    "rejects direct playground work by a %s",
    async (role) => {
      const { service } = await fixture(role);
      await expect(
        service.runToolPlayground(
          "unread_module",
          {},
          { orgId: ORG_ID, userId: USER_ID }
        )
      ).rejects.toMatchObject({ status: 403 });
    }
  );
});
