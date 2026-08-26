import { describe, expect, test } from "bun:test";
import { AtlasApiError, nanoid } from "@atlas/core";
import {
  PREINSTALLED_MCP_SERVER_IDS,
  preinstalledMcpServerIdForOrg,
} from "@atlas/core/mcp/preinstalled";
import {
  createInMemoryDatabaseAdapter,
  ensurePreinstalledMcpServers,
} from "@atlas/db";
import { McpClientManager } from "./mcp-client-manager";
import { McpService } from "./mcp-service";

const ORG_A = "org_a";
const ORG_B = "org_b";

async function seedOrg(
  db: ReturnType<typeof createInMemoryDatabaseAdapter>,
  orgId: string
) {
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: orgId,
    name: orgId,
    slug: orgId,
    updatedAt: now,
  });
}

async function seedProfile(
  db: ReturnType<typeof createInMemoryDatabaseAdapter>,
  orgId: string
) {
  const now = new Date().toISOString();
  const profile = {
    createdAt: now,
    id: nanoid(),
    isSuper: false,
    model: null,
    name: "Test Bot",
    orgId,
    systemPrompt: "You are helpful.",
    updatedAt: now,
  };

  await db.upsertProfile(profile);

  return profile.id;
}

describe("McpService", () => {
  test("creates and lists MCP servers", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    await service.createServer(ORG_A, {
      config: { url: "https://example.com/mcp" },
      connect: false,
      name: "demo",
      transport: "http",
    });

    const listed = await service.listServers(ORG_A);

    expect(listed.servers).toHaveLength(1);
    expect(listed.servers[0]?.name).toBe("demo");
    expect(listed.servers[0]?.toolCount).toBe(0);
  });

  test("assigns MCP servers to profiles", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    const created = await service.createServer(ORG_A, {
      config: { url: "https://example.com/mcp" },
      connect: false,
      name: "demo",
      transport: "http",
    });

    const profileId = await seedProfile(db, ORG_A);

    await service.assignServerToProfile(ORG_A, profileId, created.server.id);

    const assigned = await db.listMcpServersForProfile(profileId);

    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.id).toBe(created.server.id);
  });

  test("updates MCP server config while preserving blank header values", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    const created = await service.createServer(ORG_A, {
      config: {
        headers: {
          Authorization: "secret-token",
          "X-Custom": "keep-me",
        },
        url: "https://example.com/mcp",
      },
      connect: false,
      name: "demo",
      transport: "http",
    });

    const updated = await service.updateServer(ORG_A, created.server.id, {
      config: {
        headers: {
          Authorization: "",
          "X-Custom": "updated-value",
        },
        url: "https://example.com/mcp",
      },
    });

    const stored = await db.getMcpServer(created.server.id);

    expect(updated.server.config.headers).toEqual({
      Authorization: "••••••••",
      "X-Custom": "••••••••",
    });
    expect(stored?.config).toEqual({
      headers: {
        Authorization: "secret-token",
        "X-Custom": "updated-value",
      },
      url: "https://example.com/mcp",
    });
  });

  test("creates and lists stdio MCP servers", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    await service.createServer(ORG_A, {
      config: {
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        command: "npx",
      },
      connect: false,
      name: "filesystem",
      transport: "stdio",
    });

    const listed = await service.listServers(ORG_A);

    expect(listed.servers).toHaveLength(1);
    expect(listed.servers[0]?.name).toBe("filesystem");
    expect(listed.servers[0]?.transport).toBe("stdio");
  });

  test("rejects stdio MCP servers without command", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    await expect(
      service.createServer(ORG_A, {
        config: { command: "" },
        connect: false,
        name: "broken",
        transport: "stdio",
      })
    ).rejects.toThrow("stdio MCP servers require config.command.");
  });

  test("does not persist a stdio server whose command fails to connect", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    const error = await service
      .createServer(ORG_A, {
        config: { command: "qa-nonexistent-cmd-xyz" },
        name: "broken",
        transport: "stdio",
      })
      .catch((caught: unknown) => caught);

    expect(error instanceof AtlasApiError).toBe(true);
    expect((error as AtlasApiError).status).toBe(422);

    const listed = await service.listServers(ORG_A);
    expect(listed.servers).toHaveLength(0);
  });

  test("updates stdio MCP server config while preserving blank env values", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    const created = await service.createServer(ORG_A, {
      config: {
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        command: "npx",
        env: {
          API_KEY: "secret-token",
          NODE_ENV: "production",
        },
      },
      connect: false,
      name: "filesystem",
      transport: "stdio",
    });

    const updated = await service.updateServer(ORG_A, created.server.id, {
      config: {
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        command: "npx",
        env: {
          API_KEY: "",
          NODE_ENV: "development",
        },
      },
    });

    const stored = await db.getMcpServer(created.server.id);

    expect(updated.server.config).toEqual({
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      command: "npx",
      env: {
        API_KEY: "••••••••",
        NODE_ENV: "••••••••",
      },
    });
    expect(stored?.config).toEqual({
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      command: "npx",
      env: {
        API_KEY: "secret-token",
        NODE_ENV: "development",
      },
    });
  });

  test("accepts command as an alias for stdio transport", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    await service.createServer(ORG_A, {
      config: {
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        command: "npx",
      },
      connect: false,
      name: "filesystem",
      transport: "command" as "stdio",
    });

    const listed = await service.listServers(ORG_A);

    expect(listed.servers[0]?.transport).toBe("stdio");
  });

  test("rejects stdio config when transport is http", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    await expect(
      service.createServer(ORG_A, {
        config: { command: "npx" },
        connect: false,
        name: "broken",
        transport: "http",
      })
    ).rejects.toThrow("HTTP MCP servers require config.url.");
  });

  test("rejects HTTP config when transport is stdio", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    await expect(
      service.createServer(ORG_A, {
        config: { url: "https://example.com/mcp" },
        connect: false,
        name: "broken",
        transport: "stdio",
      })
    ).rejects.toThrow("stdio MCP servers require config.command.");
  });

  test("blocks delete when MCP server is assigned to a profile", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    const created = await service.createServer(ORG_A, {
      config: { url: "https://example.com/mcp" },
      connect: false,
      name: "demo",
      transport: "http",
    });

    const profileId = await seedProfile(db, ORG_A);
    await service.assignServerToProfile(ORG_A, profileId, created.server.id);

    await expect(
      service.deleteServer(ORG_A, created.server.id)
    ).rejects.toMatchObject({
      profiles: [{ id: profileId, name: "Test Bot" }],
      status: 409,
    });

    expect(await db.getMcpServer(created.server.id)).not.toBeNull();
  });

  test("deletes MCP server when not assigned to any profile", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    const created = await service.createServer(ORG_A, {
      config: { url: "https://example.com/mcp" },
      connect: false,
      name: "demo",
      transport: "http",
    });

    await service.deleteServer(ORG_A, created.server.id);

    expect(await db.getMcpServer(created.server.id)).toBeNull();
  });

  test("blocks delete for preinstalled MCP servers", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    await ensurePreinstalledMcpServers(db, ORG_A);
    const exaId = preinstalledMcpServerIdForOrg(
      PREINSTALLED_MCP_SERVER_IDS.exa,
      ORG_A
    );
    const firecrawlId = preinstalledMcpServerIdForOrg(
      PREINSTALLED_MCP_SERVER_IDS.firecrawl,
      ORG_A
    );

    await expect(service.deleteServer(ORG_A, exaId)).rejects.toThrow(
      'Preinstalled MCP server "exa" cannot be deleted.'
    );

    expect(await db.getMcpServer(exaId)).not.toBeNull();

    await expect(service.deleteServer(ORG_A, firecrawlId)).rejects.toThrow(
      'Preinstalled MCP server "firecrawl" cannot be deleted.'
    );

    expect(await db.getMcpServer(firecrawlId)).not.toBeNull();
  });

  test("lists assigned profile counts on MCP servers", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    const service = new McpService(db, new McpClientManager());

    const created = await service.createServer(ORG_A, {
      config: { url: "https://example.com/mcp" },
      connect: false,
      name: "demo",
      transport: "http",
    });

    const profileId = await seedProfile(db, ORG_A);
    await service.assignServerToProfile(ORG_A, profileId, created.server.id);

    const listed = await service.listServers(ORG_A);

    expect(listed.servers[0]?.assignedProfileCount).toBe(1);
  });

  test("does not list or mutate another workspace's MCP server", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    await seedOrg(db, ORG_B);
    const service = new McpService(db, new McpClientManager());

    const created = await service.createServer(ORG_A, {
      config: {
        headers: { Authorization: "Bearer workspace-a-secret" },
        url: "https://example.com/mcp",
      },
      connect: false,
      name: "demo",
      transport: "http",
    });

    await service.createServer(ORG_B, {
      config: { url: "https://example.com/other" },
      connect: false,
      name: "demo",
      transport: "http",
    });

    const listedA = await service.listServers(ORG_A);
    const listedB = await service.listServers(ORG_B);

    expect(listedA.servers.map((server) => server.id)).toEqual([
      created.server.id,
    ]);
    expect(listedB.servers).toHaveLength(1);
    expect(listedB.servers[0]?.id).not.toBe(created.server.id);

    await expect(
      service.getServer(ORG_B, created.server.id)
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.updateServer(ORG_B, created.server.id, { name: "stolen" })
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.deleteServer(ORG_B, created.server.id)
    ).rejects.toMatchObject({ status: 404 });

    const profileB = await seedProfile(db, ORG_B);
    await expect(
      service.assignServerToProfile(ORG_B, profileB, created.server.id)
    ).rejects.toMatchObject({ status: 404 });

    expect(await db.listMcpServersForProfile(profileB)).toEqual([]);
    expect(await db.getMcpServer(created.server.id)).toMatchObject({
      name: "demo",
      orgId: ORG_A,
    });
  });

  test("connects enabled servers only for active workspaces", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrg(db, ORG_A);
    await seedOrg(db, ORG_B);
    const archivedAt = "2026-08-21T00:00:00.000Z";
    await db.upsertOrganization({
      archivedAt,
      createdAt: archivedAt,
      id: ORG_B,
      name: ORG_B,
      slug: ORG_B,
      updatedAt: archivedAt,
    });
    const frozenAt = "2026-08-20T00:00:00.000Z";
    for (const [id, orgId] of [
      ["mcp_active", ORG_A],
      ["mcp_archived", ORG_B],
    ] as const) {
      await db.upsertMcpServer({
        cachedTools: [],
        config: { url: `https://example.com/${id}` },
        createdAt: frozenAt,
        enabled: true,
        id,
        lastError: null,
        name: id,
        orgId,
        status: "disconnected",
        transport: "http",
        updatedAt: frozenAt,
      });
    }
    const connected: string[] = [];
    const service = new McpService(db, {
      connect: async (server: { id: string }) => {
        connected.push(server.id);
        return [];
      },
    } as never);

    await service.connectEnabledServers();

    expect(connected).toEqual(["mcp_active"]);
    expect(await db.getMcpServer("mcp_active")).toMatchObject({
      status: "connected",
    });
    expect(await db.getMcpServer("mcp_archived")).toMatchObject({
      cachedTools: [],
      lastError: null,
      status: "disconnected",
      updatedAt: frozenAt,
    });
  });

  test("connects legacy global servers before organizations exist", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertMcpServer({
      cachedTools: [],
      config: { url: "https://example.com/legacy" },
      createdAt: now,
      enabled: true,
      id: "mcp_legacy",
      lastError: null,
      name: "legacy",
      orgId: null,
      status: "disconnected",
      transport: "http",
      updatedAt: now,
    });
    const connected: string[] = [];
    const service = new McpService(db, {
      connect: async (server: { id: string }) => {
        connected.push(server.id);
        return [];
      },
    } as never);

    await service.connectEnabledServers();

    expect(connected).toEqual(["mcp_legacy"]);
    expect(await db.getMcpServer("mcp_legacy")).toMatchObject({
      status: "connected",
    });
  });
});
