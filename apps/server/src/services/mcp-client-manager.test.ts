import { expect, test } from "bun:test";
import type { StoredMcpServerRecord } from "@atlas/db";
import {
  McpClientManager,
  McpConnectionSupersededError,
} from "./mcp-client-manager";

function endpoint(name: string) {
  const listing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    async fetch(request) {
      if (request.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      const message = (await request.json()) as {
        id?: string | number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (message.id === undefined) {
        return new Response(null, { status: 202 });
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          capabilities: { tools: {} },
          protocolVersion: message.params?.protocolVersion,
          serverInfo: { name, version: "1.0.0" },
        };
      } else if (message.method === "tools/list") {
        listing.resolve();
        await release.promise;
        result = {
          tools: [{ inputSchema: { type: "object" }, name: "identify" }],
        };
      } else {
        result = { content: [{ text: name, type: "text" }] };
      }
      return Response.json({ id: message.id, jsonrpc: "2.0", result });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return { listing: listing.promise, release: () => release.resolve(), server };
}

function record(url: string): StoredMcpServerRecord {
  return {
    cachedTools: [],
    config: { url },
    createdAt: "2026-09-09T00:00:00Z",
    enabled: true,
    id: "mcp_pending",
    lastError: null,
    name: "pending",
    orgId: "org_pending",
    status: "disconnected",
    transport: "http",
    updatedAt: "2026-09-09T00:00:00Z",
  };
}

test.each(["server", "all", "endpoint"] as const)(
  "disconnecting a pending %s connection prevents it from becoming available",
  async (kind) => {
    const remote = endpoint("late");
    const manager = new McpClientManager();
    const server = record(remote.server.url.toString());
    const pending = (
      kind === "endpoint"
        ? manager.connectHttpEndpoint(server.id, remote.server.url.toString())
        : manager.connect(server)
    ).catch((error: unknown) => error);
    try {
      await remote.listing;
      if (kind === "all") {
        await manager.disconnectAll();
      } else if (kind === "endpoint") {
        await manager.disconnectHttpEndpoint(server.id);
      } else {
        await manager.disconnect(server.id);
      }
      remote.release();
      expect(await pending).toBeInstanceOf(McpConnectionSupersededError);
      expect(manager.getConnectedCount()).toBe(0);
    } finally {
      remote.release();
      await pending;
      await manager.disconnectAll();
      await remote.server.stop(true);
    }
  }
);

test("a late connection and stale cleanup cannot replace or close a newer endpoint", async () => {
  const older = endpoint("old");
  const newer = endpoint("new");
  const manager = new McpClientManager();
  const oldServer = record(older.server.url.toString());
  const newServer = record(newer.server.url.toString());
  const oldPending = manager
    .connect(oldServer)
    .catch((error: unknown) => error);
  let newPending: Promise<unknown> | undefined;
  try {
    await older.listing;
    newPending = manager.connect(newServer);
    await newer.listing;
    newer.release();
    await newPending;
    older.release();
    expect(await oldPending).toBeInstanceOf(McpConnectionSupersededError);
    await manager.disconnectIfConfigurationMatches(oldServer);
    expect(manager.isConnected(newServer.id, "http")).toBe(true);
    expect(
      await manager.callTool(newServer.id, "http", "identify", {})
    ).toMatchObject({ text: "new" });
  } finally {
    older.release();
    newer.release();
    await Promise.allSettled([oldPending, newPending]);
    await manager.disconnectAll();
    await older.server.stop(true);
    await newer.server.stop(true);
  }
});
