import {
  builtinTools,
  type McpHttpConfig,
  type McpStdioConfig,
} from "@atlas/core";
import {
  isPreinstalledMcpServerId,
  preinstalledMcpServerIdForOrg,
  preinstalledMcpServers,
} from "@atlas/core/mcp/preinstalled";
import {
  BUILTIN_TOOL_IDS,
  PYTHON_EXECUTE_TOOL_ID,
  SUB_AGENT_TOOL_ID,
  serverHandlerTypeForToolName,
  TOOL_SEARCH_TOOL_ID,
} from "@atlas/core/tools/protected";
import { ensureLocalClientAccess } from "./local-client";
import {
  ensureBashToolDefinition,
  ensureGenerateImageToolDefinition,
  ensureOrgSuperAgentProfiles,
} from "./org-profiles";
import type { DatabaseAdapter } from "./types";

const LEGACY_BUILTIN_TOOL_NAMES = new Set([
  "echo",
  "log",
  "delay",
  "search_workspace",
]);
const DEPRECATED_BUILTIN_TOOL_NAMES = new Set([
  "archive_profile_memory",
  "update_profile_memory",
  "save_artifact",
  "create_skill",
]);
const DEPRECATED_SERVER_TOOL_NAMES = new Set(["delegate_coding_task"]);
const SUPPORTED_TOOL_HANDLER_TYPES = new Set([
  "builtin",
  "bash",
  "javascript",
  "sub_agent",
  "generate_image",
  "python_execute",
  "tool_search",
  "memory",
  "conversation",
]);

export async function seedDatabase(db: DatabaseAdapter): Promise<void> {
  await removeLegacyBuiltinTools(db);
  await removeDeprecatedBuiltinTools(db);
  await removeDeprecatedServerTools(db);
  await removeUnsupportedTools(db);
  await ensureBuiltinToolDefinitions(db);
  await ensureSubAgentToolDefinition(db);
  await ensureBashToolDefinition(db);
  await ensureGenerateImageToolDefinition(db);
  await ensurePythonExecuteToolDefinition(db);
  await ensureToolSearchToolDefinition(db);
  await ensureLocalClientAccess(db);
  await ensureOrgSuperAgentProfiles(db);
  await ensurePreinstalledMcpServers(db);
}

export async function removeLegacyBuiltinTools(
  db: DatabaseAdapter
): Promise<void> {
  const profiles = await db.listProfiles();
  const tools = await db.listTools();

  for (const tool of tools) {
    if (
      tool.handlerType !== "builtin" ||
      !LEGACY_BUILTIN_TOOL_NAMES.has(tool.name)
    ) {
      continue;
    }

    for (const profile of profiles) {
      await db.unassignToolFromProfile(profile.id, tool.id);
    }

    await db.deleteTool(tool.id);
  }
}

export async function removeDeprecatedBuiltinTools(
  db: DatabaseAdapter
): Promise<void> {
  const profiles = await db.listProfiles();
  const tools = await db.listTools();

  for (const tool of tools) {
    if (
      tool.handlerType !== "builtin" ||
      !DEPRECATED_BUILTIN_TOOL_NAMES.has(tool.name)
    ) {
      continue;
    }

    for (const profile of profiles) {
      await db.unassignToolFromProfile(profile.id, tool.id);
    }

    await db.deleteTool(tool.id);
  }
}

export async function removeDeprecatedServerTools(
  db: DatabaseAdapter
): Promise<void> {
  const profiles = await db.listProfiles();
  const tools = await db.listTools();

  for (const tool of tools) {
    if (!DEPRECATED_SERVER_TOOL_NAMES.has(tool.name)) {
      continue;
    }

    for (const profile of profiles) {
      await db.unassignToolFromProfile(profile.id, tool.id);
    }

    await db.deleteTool(tool.id);
  }
}

export async function removeUnsupportedTools(
  db: DatabaseAdapter
): Promise<void> {
  const profiles = await db.listProfiles();
  const tools = await db.listTools();

  for (const tool of tools) {
    if (SUPPORTED_TOOL_HANDLER_TYPES.has(tool.handlerType)) {
      continue;
    }

    for (const profile of profiles) {
      await db.unassignToolFromProfile(profile.id, tool.id);
    }

    await db.deleteTool(tool.id);
  }
}

export async function ensureBuiltinToolDefinitions(
  db: DatabaseAdapter
): Promise<void> {
  const now = new Date().toISOString();

  for (const [toolName, toolId] of Object.entries(BUILTIN_TOOL_IDS)) {
    const builtinTool = builtinTools.find((t) => t.name === toolName);
    const existing = await db.getTool(toolId);

    await db.upsertTool({
      createdAt: existing?.createdAt ?? now,
      description:
        builtinTool?.description ??
        `Built-in tool for ${toolName.replace(/_/g, " ")}.`,
      handlerConfig: { name: toolName },
      handlerType: serverHandlerTypeForToolName(toolName) ?? "builtin",
      id: toolId,
      name: toolName,
      updatedAt: now,
    });
  }
}

export async function ensureSubAgentToolDefinition(
  db: DatabaseAdapter
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db.getTool(SUB_AGENT_TOOL_ID);

  await db.upsertTool({
    createdAt: existing?.createdAt ?? now,
    description:
      "Run a focused same-profile sub-agent for delegated research, review, planning, or debugging. Returns a structured result for the parent to summarize. Not for repo coding work — use bash with coding-agent for that.",
    handlerConfig: {},
    handlerType: "sub_agent",
    id: SUB_AGENT_TOOL_ID,
    name: "sub_agent",
    updatedAt: now,
  });
}

export async function ensurePythonExecuteToolDefinition(
  db: DatabaseAdapter
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db.getTool(PYTHON_EXECUTE_TOOL_ID);

  await db.upsertTool({
    createdAt: existing?.createdAt ?? now,
    description:
      "Execute Python code in an isolated workspace analysis sandbox. Useful for data analysis, CSV/Excel computation, statistics, data transformations, and generating artifacts/charts. stdout, stderr, and any newly generated files are captured.",
    handlerConfig: {},
    handlerType: "python_execute",
    id: PYTHON_EXECUTE_TOOL_ID,
    name: "python_execute",
    updatedAt: now,
  });
}

export async function ensureToolSearchToolDefinition(
  db: DatabaseAdapter
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db.getTool(TOOL_SEARCH_TOOL_ID);

  await db.upsertTool({
    createdAt: existing?.createdAt ?? now,
    description:
      "Search the available tool catalog for specific capabilities, tools, and connectors. Returns matching tool definitions.",
    handlerConfig: {},
    handlerType: "tool_search",
    id: TOOL_SEARCH_TOOL_ID,
    name: "tool_search",
    updatedAt: now,
  });
}

const FIRECRAWL_LEGACY_KEY_URL =
  /^https:\/\/mcp\.firecrawl\.dev\/([^/]+)\/v2\/mcp\/?$/i;

export async function ensurePreinstalledMcpServers(
  db: DatabaseAdapter,
  orgId?: string
): Promise<void> {
  if (orgId) {
    const organization = await db.getOrganizationById(orgId);
    if (!organization || organization.archivedAt) {
      return;
    }
    await ensurePreinstalledMcpServersForOrg(db, orgId);
    return;
  }

  const orgs = await db.listOrganizations();

  if (orgs.length === 0) {
    await ensurePreinstalledMcpServersForOrg(db, null);
    return;
  }

  for (const org of orgs) {
    if (org.archivedAt) {
      continue;
    }
    await ensurePreinstalledMcpServersForOrg(db, org.id);
  }
}

async function ensurePreinstalledMcpServersForOrg(
  db: DatabaseAdapter,
  orgId: string | null
): Promise<void> {
  const now = new Date().toISOString();

  for (const server of preinstalledMcpServers) {
    const existing = await findExistingPreinstalledMcpServer(
      db,
      server.id,
      server.name,
      orgId
    );

    if (existing && !isPreinstalledMcpServerId(existing.id)) {
      console.warn(
        `Preinstalled MCP server "${server.name}" was not inserted: name already used by ${existing.id}.`
      );
      continue;
    }

    const id =
      existing?.id ??
      (orgId ? preinstalledMcpServerIdForOrg(server.id, orgId) : server.id);

    await db.upsertMcpServer({
      cachedTools: existing?.cachedTools ?? [],
      config: existing
        ? mergePreinstalledHttpConfig(server.config, existing.config)
        : server.config,
      createdAt: existing?.createdAt ?? now,
      enabled: existing?.enabled ?? true,
      id,
      lastError: existing?.lastError ?? null,
      name: server.name,
      orgId: orgId ?? existing?.orgId ?? null,
      status: existing?.status ?? "disconnected",
      transport: server.transport,
      updatedAt: now,
    });
  }
}

async function findExistingPreinstalledMcpServer(
  db: DatabaseAdapter,
  catalogId: string,
  catalogName: string,
  orgId: string | null
) {
  if (orgId) {
    const scoped = await db.getMcpServer(
      preinstalledMcpServerIdForOrg(catalogId, orgId)
    );

    if (scoped) {
      return scoped;
    }

    const byName = await db.getMcpServerByName(catalogName, orgId);

    if (byName) {
      return byName;
    }

    const legacy = await db.getMcpServer(catalogId);

    if (legacy && (legacy.orgId === orgId || !legacy.orgId)) {
      return legacy;
    }

    return null;
  }

  return (
    (await db.getMcpServer(catalogId)) ??
    (await db.getMcpServerByName(catalogName))
  );
}

function mergePreinstalledHttpConfig(
  catalogConfig: McpHttpConfig | McpStdioConfig,
  existingConfig: unknown
): McpHttpConfig | McpStdioConfig {
  if (!("url" in catalogConfig)) {
    return catalogConfig;
  }

  const headers = { ...readHttpHeaders(existingConfig) };
  const legacyBearer = firecrawlLegacyBearer(readHttpUrl(existingConfig));

  if (legacyBearer && !headers.Authorization) {
    headers.Authorization = legacyBearer;
  }

  if (Object.keys(headers).length === 0) {
    return { url: catalogConfig.url };
  }

  return { headers, url: catalogConfig.url };
}

function readHttpUrl(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null) {
    return;
  }

  const url = (config as Record<string, unknown>).url;

  return typeof url === "string" && url.trim() ? url.trim() : undefined;
}

function readHttpHeaders(config: unknown): Record<string, string> {
  if (typeof config !== "object" || config === null) {
    return {};
  }

  const headers = (config as Record<string, unknown>).headers;

  if (typeof headers !== "object" || headers === null) {
    return {};
  }

  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string" && value.trim()) {
      result[key] = value;
    }
  }

  return result;
}

function firecrawlLegacyBearer(url: string | undefined): string | undefined {
  if (!url) {
    return;
  }

  const token = FIRECRAWL_LEGACY_KEY_URL.exec(url)?.[1]?.trim();

  return token ? `Bearer ${token}` : undefined;
}
