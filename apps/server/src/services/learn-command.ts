import type { AgentChannel, ToolDefinition } from "@atlas/core";

export function shouldExpandLearnCommand(
  channel: AgentChannel,
  tools: ReadonlyArray<Pick<ToolDefinition, "name">>
): boolean {
  const isInteractiveChat = channel === "web" || channel === "cli";
  return (
    isInteractiveChat && tools.some((tool) => tool.name === "skill_manage")
  );
}
