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
  configuration?: string;
  transport: Transport;
}

interface ConnectionAttempt {
  closing?: Promise<void>;
  configuration?: string;
  managed?: ManagedMcpTransport;
  serverId?: string;
}

export class McpConnectionSupersededError extends Error {
  constructor() {
    super("MCP connection was superseded or disconnected.");
    this.name = "McpConnectionSupersededError";
  }
}

export class McpClientManager {
  private readonly connections = new Map<string, ConnectedMcpClient>();
  // Pending transports are not in connections yet. Revocation and newer
  // attempts must still prevent them from publishing a client after an await.
  private readonly connectionAttempts = new Map<string, ConnectionAttempt>();
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
    const attempt: ConnectionAttempt = {
      configuration: connectionConfiguration(server),
      serverId: server.id,
    };
    const previousAttempt = this.connectionAttempts.get(key);
    this.connectionAttempts.set(key, attempt);
    let managed: ManagedMcpTransport;
    try {
      await Promise.all([
        this.disconnectKey(key),
        this.closeConnectionAttempt(previousAttempt),
      ]);
      this.requireCurrentConnectionAttempt(key, attempt);
      managed = await createTransport(
        transportKind,
        config,
        this.prepareStdio,
        capturedOptions
      );
      attempt.managed = managed;
    } catch (error) {
      this.finishConnectionAttempt(key, attempt);
      throw error;
    }
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
      this.requireCurrentConnectionAttempt(key, attempt);
      await client.connect(transport);
      const result = await client.listTools();
      const tools = normalizeListedTools(result.tools);
      this.requireCurrentConnectionAttempt(key, attempt);
      this.connections.set(key, {
        client,
        configuration: attempt.configuration,
        ...managed,
      });
      return tools;
    } catch (error) {
      const superseded = this.connectionAttempts.get(key) !== attempt;
      await this.closeConnectionAttempt(attempt);
      if (superseded) {
        throw new McpConnectionSupersededError();
      }
      throw error;
    } finally {
      this.finishConnectionAttempt(key, attempt);
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const pending: ConnectionAttempt[] = [];
    for (const [key, attempt] of this.connectionAttempts) {
      if (attempt.serverId === serverId) {
        this.connectionAttempts.delete(key);
        pending.push(attempt);
      }
    }
    const keys = [...this.connections.keys()].filter(
      (key) => key === serverId || key.startsWith(`${serverId}:`)
    );

    await this.closeConnectionsAndAttempts(keys, pending);
  }

  async disconnectAll(): Promise<void> {
    const pending = [...this.connectionAttempts.values()];
    this.connectionAttempts.clear();
    const keys = [...this.connections.keys()];
    await this.closeConnectionsAndAttempts(keys, pending);
  }

  async disconnectIfConfigurationMatches(
    server: StoredMcpServerRecord
  ): Promise<void> {
    const configuration = connectionConfiguration(server);
    const pending: ConnectionAttempt[] = [];
    for (const [key, attempt] of this.connectionAttempts) {
      if (
        attempt.serverId === server.id &&
        attempt.configuration === configuration
      ) {
        this.connectionAttempts.delete(key);
        pending.push(attempt);
      }
    }
    const keys: string[] = [];
    for (const [key, connection] of this.connections) {
      if (
        (key === server.id || key.startsWith(`${server.id}:`)) &&
        connection.configuration === configuration
      ) {
        keys.push(key);
      }
    }
    await this.closeConnectionsAndAttempts(keys, pending);
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
    const attempt: ConnectionAttempt = {};
    const previousAttempt = this.connectionAttempts.get(connectionKey);
    this.connectionAttempts.set(connectionKey, attempt);
    try {
      await Promise.all([
        this.disconnectKey(connectionKey),
        this.closeConnectionAttempt(previousAttempt),
      ]);
      this.requireCurrentConnectionAttempt(connectionKey, attempt);
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers,
        },
      });
      attempt.managed = { transport };
      const client = new Client({
        name: "atlas",
        version: "1.0.0",
      });

      this.requireCurrentConnectionAttempt(connectionKey, attempt);
      await client.connect(transport);
      const result = await client.listTools();
      const tools = normalizeListedTools(result.tools);
      this.requireCurrentConnectionAttempt(connectionKey, attempt);
      this.connections.set(connectionKey, { client, transport });
      return tools;
    } catch (error) {
      const superseded = this.connectionAttempts.get(connectionKey) !== attempt;
      await this.closeConnectionAttempt(attempt);
      if (superseded) {
        throw new McpConnectionSupersededError();
      }
      throw error;
    } finally {
      this.finishConnectionAttempt(connectionKey, attempt);
    }
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
    const pending = this.connectionAttempts.get(connectionKey);
    this.connectionAttempts.delete(connectionKey);
    await this.closeConnectionsAndAttempts(
      [connectionKey],
      pending ? [pending] : []
    );
  }

  private async closeConnectionsAndAttempts(
    keys: string[],
    pending: ConnectionAttempt[]
  ): Promise<void> {
    const results = await Promise.allSettled([
      ...keys.map((key) => this.disconnectKey(key)),
      ...pending.map((attempt) => this.closeConnectionAttempt(attempt)),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  }

  private async closeConnectionAttempt(
    attempt: ConnectionAttempt | undefined
  ): Promise<void> {
    if (!attempt?.managed) {
      return;
    }
    // Revocation and the rejected connect call await the same cleanup, without
    // closing a later attempt's transport or closing this transport twice.
    attempt.closing ??= closeManagedTransport(attempt.managed);
    await attempt.closing;
  }

  private requireCurrentConnectionAttempt(
    key: string,
    attempt: ConnectionAttempt
  ): void {
    if (this.connectionAttempts.get(key) !== attempt) {
      throw new McpConnectionSupersededError();
    }
  }

  private finishConnectionAttempt(
    key: string,
    attempt: ConnectionAttempt
  ): void {
    if (this.connectionAttempts.get(key) === attempt) {
      this.connectionAttempts.delete(key);
    }
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

function connectionConfiguration(server: StoredMcpServerRecord): string {
  return JSON.stringify([server.orgId, server.transport, server.config]);
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
