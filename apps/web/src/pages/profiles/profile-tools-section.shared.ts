import type { ToolSummary } from "@atlas/core/contract";

export interface ProfileToolAssignmentRow {
  assigned: boolean;
  tool: ToolSummary;
}

export function buildProfileToolAssignmentRows(
  tools: ToolSummary[],
  assignedTools: ToolSummary[],
  query: string
): ProfileToolAssignmentRow[] {
  const assignedToolIds = new Set(assignedTools.map((tool) => tool.id));
  const toolsById = new Map(
    assignedTools.map((tool) => [tool.id, tool] as const)
  );

  for (const tool of tools) {
    toolsById.set(tool.id, tool);
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();

  return [...toolsById.values()]
    .filter((tool) => {
      if (!normalizedQuery) {
        return true;
      }

      return `${tool.id} ${tool.name} ${tool.description}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    })
    .toSorted((first, second) => first.name.localeCompare(second.name))
    .map((tool) => ({
      assigned: assignedToolIds.has(tool.id),
      tool,
    }));
}
