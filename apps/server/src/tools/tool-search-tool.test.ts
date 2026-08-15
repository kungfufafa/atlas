import { describe, expect, test } from "bun:test";
import type { ToolContext, ToolDefinition } from "@atlas/core";
import { createToolSearchTool, searchToolCatalog } from "./tool-search-tool";

describe("tool_search tool", () => {
  const dummyTools: ToolDefinition[] = [
    {
      description: "Perform mathematical calculations and evaluations",
      name: "calculator",
      run: async () => ({}),
    },
    {
      description: "Execute Python code for data analysis and charts",
      name: "python_execute",
      run: async () => ({}),
    },
    {
      description: "Read file contents from workspace",
      name: "read_file",
      run: async () => ({}),
    },
    {
      description: "Super agent profile creation",
      name: "create_profile",
      run: async () => ({}),
    },
  ];

  test("searches tools by keyword accurately", () => {
    const mathResults = searchToolCatalog(dummyTools, "math");
    expect(mathResults.length).toBe(1);
    expect(mathResults[0]?.name).toBe("calculator");

    const pythonResults = searchToolCatalog(dummyTools, "python analysis");
    expect(pythonResults.length).toBe(1);
    expect(pythonResults[0]?.name).toBe("python_execute");
  });

  test("hides Super Agent tools from non-super profiles", () => {
    const results = searchToolCatalog(dummyTools, "profile", {
      isSuperAgent: false,
    });
    expect(results.length).toBe(0);

    const superResults = searchToolCatalog(dummyTools, "profile", {
      isSuperAgent: true,
    });
    expect(superResults.length).toBe(1);
    expect(superResults[0]?.name).toBe("create_profile");
  });

  test("createToolSearchTool executes and returns structured search results and activates tools", async () => {
    const toolSearch = createToolSearchTool(async () => dummyTools);
    const context: ToolContext = {
      orgId: "org_test",
      profileId: "profile_test",
      sessionId: "session_dynamic_test",
    };

    const output = await toolSearch.run({ query: "analysis" }, context);
    expect(output.query).toBe("analysis");
    expect(output.totalMatches).toBe(1);
    expect(output.tools[0]?.name).toBe("python_execute");
    expect(output.tools[0]?.activated).toBe(true);
    expect(output.activatedTools).toContain("python_execute");
  });
});
