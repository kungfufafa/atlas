import { describe, expect, test } from "bun:test";
import type { StoredMcpServerRecord } from "@atlas/db";
import { McpClientManager } from "./mcp-client-manager";
import {
  buildMcpToolDefinitions,
  isValidLlmToolName,
  namespacedMcpToolName,
  sanitizeLlmToolNamePart,
  shouldExposeMcpServerTools,
} from "./mcp-tool-bridge";

describe("mcp tool bridge", () => {
  test("namespaces tool names by server", () => {
    expect(namespacedMcpToolName("filesystem", "read_file")).toBe(
      "filesystem__read_file"
    );
  });

  test("sanitizes invalid characters in MCP tool names", () => {
    expect(sanitizeLlmToolNamePart("list/tools")).toBe("list_tools");
    expect(sanitizeLlmToolNamePart("my server")).toBe("my_server");
    expect(namespacedMcpToolName("user.tolaria", "tools.list")).toBe(
      "user_tolaria__tools_list"
    );
    expect(
      isValidLlmToolName(namespacedMcpToolName("user.tolaria", "tools.list"))
    ).toBe(true);
  });

  test("deduplicates sanitized tool names", () => {
    const manager = new McpClientManager();
    const servers: StoredMcpServerRecord[] = [
      {
        cachedTools: [
          { description: "List tools", name: "tools.list" },
          { description: "List tools again", name: "tools_list" },
        ],
        config: { url: "https://example.com/mcp" },
        createdAt: "2026-01-01T00:00:00.000Z",
        enabled: true,
        id: "mcp_1",
        lastError: null,
        name: "github",
        status: "disconnected",
        transport: "http",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const tools = buildMcpToolDefinitions(
      servers,
      manager,
      "org_test",
      "profile_test"
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "github__tools_list",
      "github__tools_list_2",
    ]);
    expect(tools.every((tool) => isValidLlmToolName(tool.name))).toBe(true);
  });

  test("builds tools only from attached servers", () => {
    const manager = new McpClientManager();
    const servers: StoredMcpServerRecord[] = [
      {
        cachedTools: [
          {
            description: "Read a file",
            inputSchema: {
              properties: { path: { type: "string" } },
              type: "object",
            },
            name: "read_file",
          },
        ],
        config: { url: "https://example.com/mcp" },
        createdAt: "2026-01-01T00:00:00.000Z",
        enabled: true,
        id: "mcp_1",
        lastError: null,
        name: "filesystem",
        status: "disconnected",
        transport: "http",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const tools = buildMcpToolDefinitions(
      servers,
      manager,
      "org_test",
      "profile_test"
    );

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("filesystem__read_file");
  });

  test("returns an error when the server is disconnected", async () => {
    const manager = new McpClientManager();
    const servers: StoredMcpServerRecord[] = [
      {
        cachedTools: [{ description: "Read a file", name: "read_file" }],
        config: { url: "https://example.com/mcp" },
        createdAt: "2026-01-01T00:00:00.000Z",
        enabled: true,
        id: "mcp_1",
        lastError: null,
        name: "filesystem",
        status: "disconnected",
        transport: "http",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const tools = buildMcpToolDefinitions(
      servers,
      manager,
      "org_test",
      "profile_test"
    );
    const result = await tools[0]!.run({}, {});

    expect(result).toEqual({
      error: 'MCP server "filesystem" is not connected.',
    });
  });

  test("exposes keyless Firecrawl tools when the assigned server is enabled", () => {
    const manager = new McpClientManager();
    const firecrawl: StoredMcpServerRecord = {
      cachedTools: [
        { description: "Search the web", name: "firecrawl_search" },
      ],
      config: { url: "https://mcp.firecrawl.dev/v2/mcp" },
      createdAt: "2026-01-01T00:00:00.000Z",
      enabled: true,
      id: "mcp_firecrawl",
      lastError: null,
      name: "firecrawl",
      status: "connected",
      transport: "http",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const exa: StoredMcpServerRecord = {
      cachedTools: [{ description: "Exa search", name: "web_search_exa" }],
      config: { url: "https://mcp.exa.ai/mcp" },
      createdAt: "2026-01-01T00:00:00.000Z",
      enabled: true,
      id: "mcp_exa",
      lastError: null,
      name: "exa",
      status: "connected",
      transport: "http",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(shouldExposeMcpServerTools(firecrawl)).toBe(true);
    expect(shouldExposeMcpServerTools(exa)).toBe(true);
    expect(
      shouldExposeMcpServerTools({
        ...firecrawl,
        enabled: false,
      })
    ).toBe(false);
    expect(
      buildMcpToolDefinitions(
        [firecrawl, exa],
        manager,
        "org_test",
        "profile_test"
      ).map((tool) => tool.name)
    ).toEqual(["firecrawl__firecrawl_search", "exa__web_search_exa"]);
  });
});
