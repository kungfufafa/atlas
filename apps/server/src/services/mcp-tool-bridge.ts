import type { JsonSchema, ToolDefinition } from "@atlas/core";
import { emptyObjectSchema } from "@atlas/core";
import type { StoredMcpServerRecord } from "@atlas/db";
import type { McpClientManager } from "./mcp-client-manager";

const LLM_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function buildMcpToolDefinitions(
  servers: StoredMcpServerRecord[],
  manager: McpClientManager,
  orgId: string,
  profileId: string,
  loadCurrentServers?: () => Promise<StoredMcpServerRecord[]>
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const usedNames = new Set<string>();

  for (const server of servers) {
    if (
      !shouldExposeMcpServerTools(server) ||
      (server.orgId != null && server.orgId !== orgId)
    ) {
      continue;
    }

    for (const cachedTool of server.cachedTools) {
      const name = uniqueLlmToolName(
        namespacedMcpToolName(server.name, cachedTool.name),
        usedNames
      );
      usedNames.add(name);

      tools.push({
        description: cachedTool.description,
        name,
        parameters: toJsonSchema(cachedTool.inputSchema),
        async run(input) {
          try {
            if (loadCurrentServers) {
              const current = (await loadCurrentServers()).find(
                (entry) => entry.id === server.id && entry.orgId === orgId
              );
              const currentTool = current?.cachedTools.find(
                (entry) => entry.name === cachedTool.name
              );
              if (
                !(
                  current &&
                  shouldExposeMcpServerTools(current) &&
                  currentTool
                ) ||
                current.transport !== server.transport ||
                JSON.stringify(current.config) !==
                  JSON.stringify(server.config) ||
                JSON.stringify(currentTool.inputSchema) !==
                  JSON.stringify(cachedTool.inputSchema)
              ) {
                return {
                  error: "MCP tool access changed. Retry the request.",
                  errorCode: "PERMISSION_DENIED",
                };
              }
            }
            if (server.transport === "stdio") {
              await manager.ensureConnected(server, orgId, profileId);
            } else if (!manager.isConnected(server.id, server.transport)) {
              return {
                error: `MCP server "${server.name}" is not connected.`,
              };
            }

            return await manager.callTool(
              server.id,
              server.transport,
              cachedTool.name,
              input,
              server.transport === "stdio" ? profileId : undefined,
              server.transport === "stdio" ? orgId : undefined
            );
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      });
    }
  }

  return tools;
}

export function shouldExposeMcpServerTools(
  server: StoredMcpServerRecord
): boolean {
  return server.enabled !== false;
}

export function sanitizeLlmToolNamePart(name: string): string {
  const sanitized = name
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return sanitized || "tool";
}

export function namespacedMcpToolName(
  serverName: string,
  toolName: string
): string {
  return `${sanitizeLlmToolNamePart(serverName)}__${sanitizeLlmToolNamePart(toolName)}`;
}

export function isValidLlmToolName(name: string): boolean {
  return LLM_TOOL_NAME_PATTERN.test(name);
}

function uniqueLlmToolName(base: string, usedNames: Set<string>): string {
  if (!usedNames.has(base)) {
    return base;
  }

  let suffix = 2;

  while (usedNames.has(`${base}_${suffix}`)) {
    suffix += 1;
  }

  return `${base}_${suffix}`;
}

function toJsonSchema(inputSchema: unknown): JsonSchema {
  if (typeof inputSchema === "object" && inputSchema !== null) {
    return inputSchema as JsonSchema;
  }

  return emptyObjectSchema();
}
