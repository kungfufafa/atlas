import { isChannelGuestUserId, type ToolDefinition } from "@atlas/core";

import { channelWorkFileTools } from "./channel-work-file-tools";

/** Authorized channel guests receive only the confined work-file capability. */
export async function resolveExecutableToolsForPrincipal(
  userId: string | null | undefined,
  loadTools: () => Promise<ToolDefinition[]>,
  options: { channel?: string } = {}
): Promise<ToolDefinition[]> {
  const messaging = ["telegram", "whatsapp", "discord"].includes(
    options.channel ?? ""
  );
  if (isChannelGuestUserId(userId)) {
    return messaging ? channelWorkFileTools(true) : [];
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
