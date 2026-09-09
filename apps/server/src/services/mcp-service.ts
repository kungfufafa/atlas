import type {
  CreateMcpServerRequest,
  ListMcpServersResponse,
  McpHttpConfig,
  McpServerConfig,
  McpServerDetail,
  McpServerResponse,
  McpServerSummary,
  McpStdioConfig,
  McpTransport,
  ProfileRef,
  TestMcpServerResponse,
  UpdateMcpServerRequest,
} from "@atlas/core";
import { AtlasApiError, createId } from "@atlas/core";
import { isPreinstalledMcpServerId } from "@atlas/core/mcp/preinstalled";
import type {
  DatabaseAdapter,
  StoredMcpServerRecord,
  StoredProfileRecord,
} from "@atlas/db";
import {
  type McpClientManager,
  McpConnectionSupersededError,
  toCachedMcpToolSummaries,
} from "./mcp-client-manager";

export class McpService {
  private onConfigurationChanged?: (orgId: string) => void;
  private onStartupConnectionReady?: (orgId: string) => void;
  private readonly serverMutations = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly manager: McpClientManager
  ) {}

  setConfigurationChangeListener(listener: (orgId: string) => void): void {
    this.onConfigurationChanged = listener;
  }

  setStartupConnectionListener(listener: (orgId: string) => void): void {
    this.onStartupConnectionReady = listener;
  }

  async listServers(orgId: string): Promise<ListMcpServersResponse> {
    const servers = await this.db.listMcpServersForOrg(orgId);
    const profileCounts = await this.db.listMcpServerProfileCounts();

    return {
      servers: servers.map((server) =>
        toMcpServerSummary(server, profileCounts[server.id] ?? 0)
      ),
    };
  }

  async getServer(orgId: string, serverId: string): Promise<McpServerResponse> {
    const server = await this.requireServer(orgId, serverId);
    const profileCounts = await this.db.listMcpServerProfileCounts();

    return { server: toMcpServerDetail(server, profileCounts[serverId] ?? 0) };
  }

  async createServer(
    orgId: string,
    request: CreateMcpServerRequest
  ): Promise<McpServerResponse> {
    const name = request.name.trim();

    if (!name) {
      throw invalidMcpServerRequest("MCP server name is required.");
    }

    const transport = normalizeTransport(request.transport);
    validateConfig(transport, request.config);

    const existing = await this.db.getMcpServerByName(name, orgId);

    if (existing) {
      throw new AtlasApiError(`MCP server already exists: ${name}`, 409);
    }

    const now = new Date().toISOString();
    let record: StoredMcpServerRecord = {
      cachedTools: [],
      config: request.config,
      createdAt: now,
      enabled: request.enabled ?? true,
      id: createId("mcp"),
      lastError: null,
      name,
      orgId,
      status: "disconnected",
      transport,
      updatedAt: now,
    };

    // Connect before persisting so a failed initial connection is a client
    // error (4xx) and never leaves a broken server row behind.
    if (request.connect !== false && record.enabled) {
      try {
        const cachedTools = await this.manager.connect(record);
        record = { ...record, cachedTools, status: "connected" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new AtlasApiError(
          `Could not connect MCP server "${name}": ${message}`,
          422
        );
      }
    }

    await this.db.upsertMcpServer(record);
    this.onConfigurationChanged?.(orgId);

    return this.getServer(orgId, record.id);
  }

  async updateServer(
    orgId: string,
    serverId: string,
    request: UpdateMcpServerRequest
  ): Promise<McpServerResponse> {
    return this.withServerMutation(serverId, async () => {
      const server = await this.requireServer(orgId, serverId);
      const nextName = request.name?.trim() ?? server.name;

      if (!nextName) {
        throw new Error("MCP server name is required.");
      }

      if (nextName !== server.name) {
        const existing = await this.db.getMcpServerByName(nextName, orgId);

        if (existing && existing.id !== serverId) {
          throw new Error(`MCP server already exists: ${nextName}`);
        }
      }

      const transportChanged =
        request.transport !== undefined &&
        request.transport !== server.transport;
      const transport = request.transport ?? server.transport;
      const config = request.config
        ? transportChanged
          ? request.config
          : mergeMcpConfig(
              transport,
              resolveMcpConfig(server.transport, server.config),
              request.config
            )
        : resolveMcpConfig(server.transport, server.config);

      if (request.transport !== undefined) {
        validateTransport(transport);
      }

      validateConfig(transport, config);

      const updated: StoredMcpServerRecord = {
        ...server,
        config,
        enabled: request.enabled ?? server.enabled,
        name: nextName,
        orgId,
        transport,
        updatedAt: new Date().toISOString(),
      };

      const configChanged =
        JSON.stringify(server.config) !== JSON.stringify(config) ||
        server.transport !== transport;

      if (configChanged || !updated.enabled) {
        await this.manager.disconnect(serverId);
        updated.status = "disconnected";
        updated.lastError = null;
      }

      await this.db.upsertMcpServer(updated);
      this.onConfigurationChanged?.(orgId);

      return this.getServer(orgId, serverId);
    });
  }

  async deleteServer(orgId: string, serverId: string): Promise<void> {
    return this.withServerMutation(serverId, async () => {
      const server = await this.requireServer(orgId, serverId);

      if (isPreinstalledMcpServerId(server.id)) {
        throw new Error(
          `Preinstalled MCP server "${server.name}" cannot be deleted.`
        );
      }

      const profiles = await this.db.listProfilesForMcpServer(serverId);
      const profilesInOrg = profiles.filter(
        (profile) => profile.orgId === orgId
      );

      if (profilesInOrg.length > 0) {
        const profileRefs = toProfileRefs(profilesInOrg);
        throw new AtlasApiError(
          formatMcpServerInUseMessage(profileRefs),
          409,
          undefined,
          profileRefs
        );
      }

      if (profiles.length > 0) {
        throw new AtlasApiError("MCP server is assigned to a profile.", 409);
      }

      await this.manager.disconnect(serverId);

      const deleted = await this.db.deleteMcpServer(serverId);

      if (!deleted) {
        throw new AtlasApiError("MCP server not found.", 404);
      }
      this.onConfigurationChanged?.(orgId);
    });
  }

  async connectServer(
    orgId: string,
    serverId: string
  ): Promise<McpServerResponse> {
    const server = await this.requireServer(orgId, serverId);
    return this.connectServerRecord(server);
  }

  async syncServer(
    orgId: string,
    serverId: string
  ): Promise<McpServerResponse> {
    const server = await this.requireServer(orgId, serverId);

    if (!this.manager.isConnected(serverId, server.transport)) {
      return this.connectServer(orgId, serverId);
    }

    let cachedTools: StoredMcpServerRecord["cachedTools"];
    try {
      cachedTools = await this.manager.listTools(serverId, server.transport);
    } catch (error) {
      await this.recordConnectionError(server, error);
      throw error;
    }
    return this.saveConnectedServer(server, cachedTools);
  }

  async testServer(
    orgId: string,
    transport: McpTransport,
    config: McpServerConfig,
    serverId?: string
  ): Promise<TestMcpServerResponse> {
    const normalizedTransport = normalizeTransport(transport);
    const resolvedConfig = serverId
      ? mergeMcpConfig(
          normalizedTransport,
          resolveMcpConfig(
            normalizedTransport,
            (await this.requireServer(orgId, serverId)).config
          ),
          config
        )
      : config;

    validateConfig(normalizedTransport, resolvedConfig);

    try {
      const tools = await this.manager.testConnection(
        normalizedTransport,
        resolvedConfig
      );

      return {
        ok: true,
        toolCount: tools.length,
        tools: toCachedMcpToolSummaries(tools),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        toolCount: 0,
        tools: [],
      };
    }
  }

  async connectEnabledServers(): Promise<void> {
    const servers = await this.db.listMcpServers();
    const organizations = await this.db.listOrganizations();
    const hasTenantOrganizations = organizations.length > 0;
    const activeOrgIds = new Set(
      organizations
        .filter((organization) => !organization.archivedAt)
        .map((organization) => organization.id)
    );

    for (const server of servers) {
      const canConnect = server.orgId
        ? activeOrgIds.has(server.orgId)
        : !hasTenantOrganizations;
      if (!(server.enabled && canConnect)) {
        continue;
      }

      try {
        await this.connectServerRecord(server, true);
      } catch (error) {
        console.warn(
          `Could not connect MCP server "${server.name}":`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  async assignServerToProfile(
    orgId: string,
    profileId: string,
    serverId: string
  ): Promise<void> {
    const profile = await this.db.getProfile(profileId);

    if (!profile || profile.orgId !== orgId) {
      throw new AtlasApiError("Profile not found.", 404);
    }

    await this.requireServer(orgId, serverId);
    await this.db.assignMcpServerToProfile(profileId, serverId);
    this.onConfigurationChanged?.(orgId);
  }

  async unassignServerFromProfile(
    orgId: string,
    profileId: string,
    serverId: string
  ): Promise<void> {
    const profile = await this.db.getProfile(profileId);

    if (!profile || profile.orgId !== orgId) {
      throw new AtlasApiError("Profile not found.", 404);
    }

    const removed = await this.db.unassignMcpServerFromProfile(
      profileId,
      serverId
    );

    if (!removed) {
      throw new Error("MCP server is not assigned to this profile.");
    }
    this.onConfigurationChanged?.(orgId);
  }

  async getStatusSummary(orgId?: string): Promise<{
    serverCount: number;
    connectedCount: number;
    assignedProfileCount: number;
  }> {
    const servers = orgId
      ? await this.db.listMcpServersForOrg(orgId)
      : await this.db.listMcpServers();
    const profileCounts = await this.db.listMcpServerProfileCounts();
    let assignedProfileCount = 0;
    let connectedCount = 0;

    for (const server of servers) {
      assignedProfileCount += profileCounts[server.id] ?? 0;
      if (this.manager.isConnected(server.id, server.transport)) {
        connectedCount += 1;
      }
    }

    return {
      assignedProfileCount,
      connectedCount,
      serverCount: servers.length,
    };
  }

  private async requireServer(
    orgId: string,
    serverId: string
  ): Promise<StoredMcpServerRecord> {
    const server = await this.db.getMcpServer(serverId);

    if (!server || server.orgId !== orgId) {
      throw new AtlasApiError("MCP server not found.", 404);
    }

    return server;
  }

  private async connectServerRecord(
    server: StoredMcpServerRecord,
    startup = false
  ): Promise<McpServerResponse> {
    if (!server.enabled) {
      throw new Error(`MCP server "${server.name}" is disabled.`);
    }

    let cachedTools: StoredMcpServerRecord["cachedTools"];
    try {
      cachedTools = await this.manager.connect(server);
    } catch (error) {
      await this.recordConnectionError(server, error);
      throw error;
    }
    return this.saveConnectedServer(server, cachedTools, startup);
  }

  private async recordConnectionError(
    server: StoredMcpServerRecord,
    error: unknown
  ): Promise<void> {
    if (error instanceof McpConnectionSupersededError) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await this.withServerMutation(server.id, async () => {
      const current = await this.db.getMcpServer(server.id);
      if (current && sameMcpConnectionConfiguration(server, current)) {
        await this.db.upsertMcpServer({
          ...current,
          lastError: message,
          status: "error",
          updatedAt: new Date().toISOString(),
        });
      }
    });
  }

  private async saveConnectedServer(
    server: StoredMcpServerRecord,
    cachedTools: StoredMcpServerRecord["cachedTools"],
    startup = false
  ): Promise<McpServerResponse> {
    return this.withServerMutation(server.id, async () => {
      const current = await this.db.getMcpServer(server.id);
      if (!(current && sameMcpConnectionConfiguration(server, current))) {
        // A slow startup connection must not restore configuration revoked while
        // its transport was connecting, or publish stale tools into that workspace.
        await this.manager.disconnectIfConfigurationMatches(server);
        throw new AtlasApiError(
          "MCP configuration changed while connecting.",
          409
        );
      }
      const updated: StoredMcpServerRecord = {
        ...current,
        cachedTools,
        lastError: null,
        status: "connected",
        updatedAt: new Date().toISOString(),
      };

      await this.db.upsertMcpServer(updated);
      if (server.orgId) {
        if (startup) {
          this.onStartupConnectionReady?.(server.orgId);
        } else {
          this.onConfigurationChanged?.(server.orgId);
        }
      }

      return { server: toMcpServerDetail(updated) };
    });
  }

  private async withServerMutation<T>(
    serverId: string,
    mutation: () => Promise<T>
  ): Promise<T> {
    // Keep the record check and write together. Transport connection itself
    // stays outside this queue so an admin can revoke a stalled connection.
    const previous = this.serverMutations.get(serverId);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.serverMutations.set(serverId, pending);
    try {
      await previous;
      return await mutation();
    } finally {
      release();
      if (this.serverMutations.get(serverId) === pending) {
        this.serverMutations.delete(serverId);
      }
    }
  }
}

function sameMcpConnectionConfiguration(
  expected: StoredMcpServerRecord,
  current: StoredMcpServerRecord
): boolean {
  return (
    current.enabled === expected.enabled &&
    current.orgId === expected.orgId &&
    current.transport === expected.transport &&
    JSON.stringify(current.config) === JSON.stringify(expected.config)
  );
}

function toMcpServerSummary(
  server: StoredMcpServerRecord,
  assignedProfileCount?: number
): McpServerSummary {
  return {
    assignedProfileCount,
    createdAt: server.createdAt,
    enabled: server.enabled,
    id: server.id,
    lastError: server.lastError,
    name: server.name,
    status: server.status,
    toolCount: server.cachedTools.length,
    transport: server.transport,
    updatedAt: server.updatedAt,
  };
}

function toMcpServerDetail(
  server: StoredMcpServerRecord,
  assignedProfileCount?: number
): McpServerDetail {
  return {
    ...toMcpServerSummary(server, assignedProfileCount),
    cachedTools: toCachedMcpToolSummaries(server.cachedTools),
    config: redactMcpConfig(server.transport, server.config),
  };
}

function toProfileRefs(profiles: StoredProfileRecord[]): ProfileRef[] {
  return profiles.map((profile) => ({ id: profile.id, name: profile.name }));
}

function formatMcpServerInUseMessage(profiles: ProfileRef[]): string {
  const names = profiles.map((profile) => profile.name).join(", ");

  if (profiles.length === 1) {
    return `MCP server is assigned to profile "${names}". Unassign it on the Profiles page before deleting.`;
  }

  return `MCP server is assigned to ${profiles.length} profiles (${names}). Unassign it from each profile before deleting.`;
}

const REDACTED_SECRET_VALUE = "••••••••";

function resolveMcpConfig(
  transport: McpTransport,
  config: unknown
): McpServerConfig {
  if (typeof config !== "object" || config === null) {
    return transport === "http" ? { url: "" } : { command: "" };
  }

  return config as McpServerConfig;
}

function mergeMcpConfig(
  transport: McpTransport,
  previous: McpServerConfig,
  next: McpServerConfig
): McpServerConfig {
  if (transport === "http") {
    return mergeMcpHttpConfig(previous as McpHttpConfig, next as McpHttpConfig);
  }

  return mergeMcpStdioConfig(
    previous as McpStdioConfig,
    next as McpStdioConfig
  );
}

function mergeMcpHttpConfig(
  previous: McpHttpConfig,
  next: McpHttpConfig
): McpHttpConfig {
  const url = next.url?.trim() || previous.url;

  return {
    headers: mergeRedactedStringRecord(previous.headers, next.headers),
    url,
  };
}

function mergeMcpStdioConfig(
  previous: McpStdioConfig,
  next: McpStdioConfig
): McpStdioConfig {
  const command = next.command?.trim() || previous.command;

  return {
    args:
      next.args === undefined ? previous.args : normalizeStringArray(next.args),
    command,
    env: mergeRedactedStringRecord(previous.env, next.env),
  };
}

function mergeRedactedStringRecord(
  previous: Record<string, string> | undefined,
  next: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!next) {
    return previous;
  }

  const previousRecord = previous ?? {};
  const merged: Record<string, string> = {};

  for (const [key, nextValue] of Object.entries(next)) {
    const trimmedKey = key.trim();

    if (!trimmedKey) {
      continue;
    }

    const trimmedValue = nextValue.trim();

    if (!trimmedValue) {
      if (trimmedKey in previousRecord) {
        merged[trimmedKey] = previousRecord[trimmedKey]!;
      }

      continue;
    }

    if (
      trimmedValue === REDACTED_SECRET_VALUE &&
      trimmedKey in previousRecord
    ) {
      merged[trimmedKey] = previousRecord[trimmedKey]!;
      continue;
    }

    merged[trimmedKey] = trimmedValue;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeStringArray(
  value: string[] | undefined
): string[] | undefined {
  if (!value) {
    return;
  }

  const items = value.map((entry) => entry.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function redactMcpConfig(
  transport: McpTransport,
  config: unknown
): McpServerConfig {
  if (transport === "stdio") {
    const stdio =
      typeof config === "object" && config !== null
        ? (config as McpStdioConfig)
        : { command: "" };

    return {
      args: stdio.args,
      command: stdio.command,
      env: redactStringRecord(stdio.env),
    };
  }

  const http =
    typeof config === "object" && config !== null
      ? (config as McpHttpConfig)
      : { url: "" };

  return {
    headers: redactStringRecord(http.headers),
    url: http.url,
  };
}

function invalidMcpServerRequest(message: string): AtlasApiError {
  return new AtlasApiError(message, 400);
}

function redactStringRecord(
  value: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!value) {
    return;
  }

  const redacted: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = entry ? REDACTED_SECRET_VALUE : entry;
  }

  return redacted;
}

function normalizeTransport(transport: string | undefined): McpTransport {
  const value = transport?.trim().toLowerCase();

  if (value === "http") {
    return "http";
  }

  if (value === "stdio" || value === "command") {
    return "stdio";
  }

  throw invalidMcpServerRequest('MCP transport must be "http" or "stdio".');
}

function validateTransport(
  transport: string
): asserts transport is McpTransport {
  normalizeTransport(transport);
}

function validateConfig(transport: McpTransport, config: unknown): void {
  if (typeof config !== "object" || config === null) {
    throw invalidMcpServerRequest("MCP server config is required.");
  }

  const record = config as Record<string, unknown>;

  if (transport === "http") {
    const url = record.url;

    if (typeof url !== "string" || !url.trim()) {
      throw invalidMcpServerRequest("HTTP MCP servers require config.url.");
    }

    try {
      new URL(url);
    } catch {
      throw invalidMcpServerRequest(`Invalid MCP server URL: ${url}`);
    }

    return;
  }

  const command = record.command;

  if (typeof command !== "string" || !command.trim()) {
    throw invalidMcpServerRequest("stdio MCP servers require config.command.");
  }
}

export function toMcpServerSummaries(
  servers: StoredMcpServerRecord[]
): McpServerSummary[] {
  return servers.map((server) => toMcpServerSummary(server));
}
