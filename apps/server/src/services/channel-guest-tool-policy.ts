import {
  builtinTools,
  isChannelGuestUserId,
  type ToolDefinition,
} from "@atlas/core";

import { channelWorkFileTools } from "./channel-work-file-tools";

/** Guest exceptions use known builtins without loading profile/MCP runtimes. */
export async function resolveExecutableToolsForPrincipal(
  userId: string | null | undefined,
  loadTools: () => Promise<ToolDefinition[]>,
  options: { channel?: string; allowKnowledgeBaseSearch?: boolean } = {}
): Promise<ToolDefinition[]> {
  const messaging = ["telegram", "whatsapp", "discord"].includes(
    options.channel ?? ""
  );
  if (isChannelGuestUserId(userId)) {
    if (!messaging) {
      return [];
    }
    const files = channelWorkFileTools(true);
    if (options.channel !== "whatsapp" || !options.allowKnowledgeBaseSearch) {
      return files;
    }
    return [
      ...files,
      ...builtinTools
        .filter((tool) => tool.name === "knowledge_base_search")
        .map((tool) => ({ ...tool, channelGuestKnowledgeBaseSafe: true })),
    ];
  }
  const assigned = await loadTools();
  if (!messaging) {
    return assigned;
  }
  const names = new Set(assigned.map((tool) => tool.name));
  return [
    ...assigned,
    ...channelWorkFileTools(false).filter((tool) => !names.has(tool.name)),
  ];
}
