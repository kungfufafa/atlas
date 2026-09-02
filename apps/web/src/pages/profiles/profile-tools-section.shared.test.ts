import { describe, expect, test } from "bun:test";
import type { ToolSummary } from "@atlas/core/contract";
import { buildProfileToolAssignmentRows } from "@/pages/profiles/profile-tools-section.shared";

const tools: ToolSummary[] = [
  {
    description: "Create a presentation",
    handlerType: "builtin",
    id: "tool_write_pptx",
    name: "write_pptx",
  },
  {
    description: "Read workspace files",
    handlerType: "builtin",
    id: "tool_read_file",
    name: "read_file",
  },
  {
    description: "Search the public web",
    handlerType: "builtin",
    id: "tool_web_search",
    name: "web_search",
  },
];

describe("buildProfileToolAssignmentRows", () => {
  test("includes every registered tool with its assignment state", () => {
    const rows = buildProfileToolAssignmentRows(tools, [tools[1]!], "");

    expect(
      rows.map(({ assigned, tool }) => ({ assigned, name: tool.name }))
    ).toEqual([
      { assigned: true, name: "read_file" },
      { assigned: false, name: "web_search" },
      { assigned: false, name: "write_pptx" },
    ]);
  });

  test("searches tool identifiers and descriptions without losing state", () => {
    expect(
      buildProfileToolAssignmentRows(tools, [tools[0]!], "presentation").map(
        ({ assigned, tool }) => ({ assigned, id: tool.id })
      )
    ).toEqual([{ assigned: true, id: "tool_write_pptx" }]);
  });

  test("keeps assigned tools visible while the catalog is unavailable", () => {
    expect(buildProfileToolAssignmentRows([], [tools[0]!], "")).toEqual([
      { assigned: true, tool: tools[0] },
    ]);
  });

  test("prefers current catalog metadata for assigned tools", () => {
    const staleAssignedTool = {
      ...tools[0]!,
      description: "Old description",
      name: "old_write_pptx",
    };

    expect(
      buildProfileToolAssignmentRows(tools, [staleAssignedTool], "")[2]?.tool
    ).toEqual(tools[0]);
  });
});
