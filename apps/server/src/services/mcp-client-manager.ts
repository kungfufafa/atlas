import type {
  CachedMcpToolSummary,
  McpHttpConfig,
  McpStdioConfig,
  McpTransport,
} from "@atlas/core";
import type { CachedMcpTool, StoredMcpServerRecord } from "@atlas/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  createMcpStdioTransportPreparer,
  type McpStdioAdmissionPolicy,
} from "./mcp-stdio-runtime";
import {
  getRestrictedProcessAdmissionEvidence,
  type RestrictedProcessAdmissionReceipt,
} from "./restricted-process";

export interface McpClientManagerOptions {
  /** Trusted server startup options, never MCP config or model JSON. */
  stdioAdmission?: McpStdioAdmissionPolicy;
}

interface ManagedMcpTransport {
  cleanup?(): Promise<void>;
  getAdmissionReceipt?(): RestrictedProcessAdmissionReceipt | undefined;
  transport: Transport;
}

interface ConnectedMcpClient extends ManagedMcpTransport {
  client: Client;
  transport: Transport;
}

export class McpClientManager {
  private readonly connections = new Map<string, ConnectedMcpClient>();
  private readonly prepareStdio: ReturnType<
    typeof createMcpStdioTransportPreparer
  >;

  constructor(options: McpClientManagerOptions = {}) {
    this.prepareStdio = createMcpStdioTransportPreparer(options.stdioAdmission);
  }

  /** Trusted host lookup only. No receipt is included in tools, results or HTTP records. */
  getRuntimeAdmissionReceipt(
    serverId: string,
    profileId?: string,
    orgId?: string
  ): RestrictedProcessAdmissionReceipt | undefined {
    const receipt = this.connections
      .get(connectionKey(serverId, "stdio", profileId, orgId))
      ?.getAdmissionReceipt?.();
    if (receipt) {
      getRestrictedProcessAdmissionEvidence(receipt);
    }
    return receipt;
  }

  isConnected(
    serverId: string,
    transport: McpTransport,
    profileId?: string,
    orgId?: string
  ): boolean {
    return this.connections.has(
      connectionKey(serverId, transport, profileId, orgId)
    );
  }

  getConnectedCount(): number {
    return this.connections.size;
  }

  async ensureConnected(
    server: StoredMcpServerRecord,
    orgId: string,
    profileId: string
  ): Promise<void> {
    if (this.isConnected(server.id, server.transport, profileId, orgId)) {
      return;
    }

    await this.connect(server, { orgId, profileId });
  }

  async connect(
    server: StoredMcpServerRecord,
    options?: { orgId?: string; profileId?: string }
  ): Promise<CachedMcpTool[]> {
    const capturedOptions = options ? { ...options } : undefined;
    const transportKind = server.transport;
    const config =
      transportKind === "stdio"
        ? readStdioConfig(server.config)
        : server.config;
    const key = connectionKey(
      server.id,
      transportKind,
      capturedOptions?.profileId,
      capturedOptions?.orgId
    );
    if (capturedOptions?.orgId && server.orgId !== capturedOptions.orgId) {
      throw new Error(
        "MCP server does not belong to the requested organization."
      );
    }
    await this.disconnectKey(key);
    const managed = await createTransport(
      transportKind,
      config,
      this.prepareStdio,
      capturedOptions
    );
    const { transport } = managed;
    const previousOnClose = transport.onclose;
    transport.onclose = () => {
      previousOnClose?.();
      if (this.connections.get(key)?.transport === transport) {
        this.connections.delete(key);
      }
      // The callback cannot await cleanup. Explicit disconnect also awaits the
      // same retained promise; natural-exit cleanup is best effort.
      void managed.cleanup?.().catch(() => {});
    };
    const client = new Client({
      name: "atlas",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);
      const result = await client.listTools();
      const tools = normalizeListedTools(result.tools);
      this.connections.set(key, { client, ...managed });
      return tools;
    } catch (error) {
      await closeManagedTransport(managed);
      throw error;
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const keys = [...this.connections.keys()].filter(
      (key) => key === serverId || key.startsWith(`${serverId}:`)
    );

    for (const key of keys) {
      await this.disconnectKey(key);
    }
  }

  async disconnectAll(): Promise<void> {
    const keys = [...this.connections.keys()];

    for (const key of keys) {
      await this.disconnectKey(key);
    }
  }

  async listTools(
    serverId: string,
    transport: McpTransport,
    profileId?: string
  ): Promise<CachedMcpTool[]> {
    const client = this.requireClient(serverId, transport, profileId);
    const result = await client.listTools();
    return normalizeListedTools(result.tools);
  }

  async callTool(
    serverId: string,
    transport: McpTransport,
    toolName: string,
    input: unknown,
    profileId?: string,
    orgId?: string
  ): Promise<unknown> {
    const client = this.requireClient(serverId, transport, profileId, orgId);
    const result = await client.callTool({
      arguments: asToolArguments(input),
      name: toolName,
    });

    if ("toolResult" in result) {
      return result.toolResult;
    }

    if (result.isError) {
      return {
        error: formatToolContent(result.content),
      };
    }

    if (result.structuredContent !== undefined) {
      return result.structuredContent;
    }

    return {
      content: result.content,
      text: formatToolContent(result.content),
    };
  }

  async testConnection(
    transport: McpTransport,
    config: unknown
  ): Promise<CachedMcpTool[]> {
    const managed = await createTransport(transport, config, this.prepareStdio);
    const { transport: mcpTransport } = managed;
    const client = new Client({
      name: "atlas",
      version: "1.0.0",
    });

    try {
      await client.connect(mcpTransport);
      const result = await client.listTools();
      return normalizeListedTools(result.tools);
    } finally {
      await closeManagedTransport(managed);
    }
  }

  async connectHttpEndpoint(
    connectionKey: string,
    url: string,
    headers?: Record<string, string>
  ): Promise<CachedMcpTool[]> {
    await this.disconnectKey(connectionKey);

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers,
      },
    });
    const client = new Client({
      name: "atlas",
      version: "1.0.0",
    });

    await client.connect(transport);
    const result = await client.listTools();
    const tools = normalizeListedTools(result.tools);
    this.connections.set(connectionKey, { client, transport });
    return tools;
  }

  isHttpEndpointConnected(connectionKey: string): boolean {
    return this.connections.has(connectionKey);
  }

  async callHttpEndpointTool(
    connectionKey: string,
    toolName: string,
    input: unknown
  ): Promise<unknown> {
    const client = this.requireClientByKey(connectionKey);
    const result = await client.callTool({
      arguments: asToolArguments(input),
      name: toolName,
    });

    if ("toolResult" in result) {
      return result.toolResult;
    }

    if (result.isError) {
      return {
        error: formatToolContent(result.content),
      };
    }

    if (result.structuredContent !== undefined) {
      return result.structuredContent;
    }

    return {
      content: result.content,
      text: formatToolContent(result.content),
    };
  }

  async disconnectHttpEndpoint(connectionKey: string): Promise<void> {
    await this.disconnectKey(connectionKey);
  }

  private requireClientByKey(connectionKey: string): Client {
    const connection = this.connections.get(connectionKey);

    if (!connection) {
      throw new Error(`HTTP MCP endpoint "${connectionKey}" is not connected.`);
    }

    return connection.client;
  }

  private requireClient(
    serverId: string,
    transport: McpTransport,
    profileId?: string,
    orgId?: string
  ): Client {
    const connection = this.connections.get(
      connectionKey(serverId, transport, profileId, orgId)
    );

    if (!connection) {
      throw new Error(`MCP server "${serverId}" is not connected.`);
    }

    return connection.client;
  }

  private async disconnectKey(key: string): Promise<void> {
    const connection = this.connections.get(key);

    if (!connection) {
      return;
    }

    this.connections.delete(key);

    await closeManagedTransport(connection);
  }
}

function connectionKey(
  serverId: string,
  transport: McpTransport,
  profileId?: string,
  orgId?: string
): string {
  if (transport === "stdio" && profileId && orgId) {
    return `${serverId}:${orgId}:${profileId}`;
  }

  return serverId;
}

async function createTransport(
  transport: McpTransport,
  config: unknown,
  prepareStdio: ReturnType<typeof createMcpStdioTransportPreparer>,
  options?: { orgId?: string; profileId?: string }
): Promise<ManagedMcpTransport> {
  if (transport === "http") {
    const http = readHttpConfig(config);

    return {
      transport: new StreamableHTTPClientTransport(new URL(http.url), {
        requestInit: { headers: http.headers },
      }),
    };
  }

  if (transport === "stdio") {
    const stdio = readStdioConfig(config);
    return prepareStdio(stdio, options);
  }

  throw new Error(`Unsupported MCP transport: ${transport}`);
}

async function closeManagedTransport(
  managed: ManagedMcpTransport
): Promise<void> {
  try {
    await managed.transport.close();
  } catch {
    // Preserve existing transport shutdown behavior, including the original connection error.
  } finally {
    await managed.cleanup?.();
  }
}

function readStdioConfig(config: unknown): McpStdioConfig {
  if (typeof config !== "object" || config === null) {
    throw new Error("stdio MCP servers require config.command.");
  }

  const record = config as Record<string, unknown>;
  const command =
    typeof record.command === "string" && record.command.trim()
      ? record.command.trim()
      : null;

  if (!command) {
    throw new Error("stdio MCP servers require config.command.");
  }

  const args = readStringArray(record.args);
  const env = readStringRecord(record.env);

  return {
    command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
  };
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return;
  }

  const items = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

function readHttpConfig(config: unknown): McpHttpConfig {
  if (typeof config !== "object" || config === null) {
    throw new Error("HTTP MCP servers require config.url.");
  }

  const record = config as Record<string, unknown>;
  const url =
    typeof record.url === "string" && record.url.trim()
      ? record.url.trim()
      : null;

  if (!url) {
    throw new Error("HTTP MCP servers require config.url.");
  }

  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid MCP server URL: ${url}`);
  }

  return {
    headers: readStringRecord(record.headers),
    url,
  };
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }

  const record: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      record[key] = entry;
    }
  }

  return Object.keys(record).length > 0 ? record : undefined;
}

function normalizeListedTools(
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>
): CachedMcpTool[] {
  return tools.map((tool) => ({
    description: tool.description?.trim() || tool.name,
    inputSchema: tool.inputSchema,
    name: tool.name,
  }));
}

function asToolArguments(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  return {};
}

function formatToolContent(
  content: Array<{ type: string; text?: string }> | undefined
): string {
  if (!content || content.length === 0) {
    return "Tool completed with no content.";
  }

  return content
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }

      return JSON.stringify(part);
    })
    .join("\n");
}

export function toCachedMcpToolSummaries(
  tools: CachedMcpTool[]
): CachedMcpToolSummary[] {
  return tools.map((tool) => ({
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: tool.name,
  }));
}
