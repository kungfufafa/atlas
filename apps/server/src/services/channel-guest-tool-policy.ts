import { isChannelGuestUserId, type ToolDefinition } from "@atlas/core";

/**
 * Open/allowlisted channel guests may use plain LLM chat only. Resolve no
 * profile, MCP, skill, filesystem, or outbound tools for these principals.
 */
export async function resolveExecutableToolsForPrincipal(
  userId: string | null | undefined,
  loadTools: () => Promise<ToolDefinition[]>
): Promise<ToolDefinition[]> {
  if (isChannelGuestUserId(userId)) {
    return [];
  }
  return loadTools();
}
