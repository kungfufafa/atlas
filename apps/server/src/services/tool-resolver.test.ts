import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@atlas/core";
import { emailTool } from "@atlas/core/tools/email";
import type { StoredToolRecord } from "@atlas/db";
import {
  omitUnavailableBuiltinTools,
  resolveProfileStoredTools,
} from "./tool-resolver";

const webSearchTool: ToolDefinition = {
  description: "Search the web",
  name: "web_search",
  parameters: { additionalProperties: false, properties: {}, type: "object" },
  async run() {
    return { ok: true };
  },
};

describe("tool-resolver", () => {
  test("drops email when mailbox is not configured", () => {
    const tools = [webSearchTool, emailTool];

    expect(
      omitUnavailableBuiltinTools(tools, false).map((tool) => tool.name)
    ).toEqual(["web_search"]);
    expect(
      omitUnavailableBuiltinTools(tools, true).map((tool) => tool.name)
    ).toEqual(["web_search", "email"]);
  });

  test("resolves builtin and server tools from stored records", async () => {
    const records: StoredToolRecord[] = [
      {
        createdAt: new Date().toISOString(),
        description: "Calculator",
        handlerConfig: {},
        handlerType: "builtin",
        id: "tool_calculator",
        name: "calculator",
        updatedAt: new Date().toISOString(),
      },
      {
        createdAt: new Date().toISOString(),
        description: "List directory",
        handlerConfig: {},
        handlerType: "builtin",
        id: "tool_list_directory",
        name: "list_directory",
        updatedAt: new Date().toISOString(),
      },
      {
        createdAt: new Date().toISOString(),
        description: "Python execute",
        handlerConfig: {},
        handlerType: "python_execute",
        id: "tool_python_execute",
        name: "python_execute",
        updatedAt: new Date().toISOString(),
      },
      {
        createdAt: new Date().toISOString(),
        description: "Tool search",
        handlerConfig: {},
        handlerType: "tool_search",
        id: "tool_tool_search",
        name: "tool_search",
        updatedAt: new Date().toISOString(),
      },
    ];

    const resolved = await resolveProfileStoredTools(records);
    const names = resolved.map((t) => t.name);
    expect(names).toContain("calculator");
    expect(names).toContain("list_directory");
    expect(names).toContain("python_execute");
    expect(names).toContain("tool_search");
  });
});
