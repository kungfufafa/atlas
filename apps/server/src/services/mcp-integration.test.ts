import { describe, expect, test } from "bun:test";
import type { StoredMcpServerRecord } from "@atlas/db";
import {
  buildMcpToolDefinitions,
  namespacedMcpToolName,
  sanitizeLlmToolNamePart,
} from "./mcp-tool-bridge";

describe("MCP Extension Layer", () => {
  test("sanitizes and namespaces MCP tool names accurately", () => {
    expect(sanitizeLlmToolNamePart("weather-api")).toBe("weather-api");
    expect(sanitizeLlmToolNamePart("service$$$name")).toBe("service_name");

    const namespaced = namespacedMcpToolName("weather_server", "get_forecast");
    expect(namespaced).toBe("weather_server__get_forecast");
  });

  test("builds valid ToolDefinitions from cached MCP tools with collision defense", () => {
    const mockManager: any = {
      callTool: async () => ({
        content: [{ text: "Sunny, 22°C", type: "text" }],
      }),
      ensureConnected: async () => {},
      isConnected: () => true,
    };

    const mockServer1: StoredMcpServerRecord = {
      cachedTools: [
        {
          description: "Get weather forecast for a city",
          inputSchema: {
            properties: { city: { type: "string" } },
            required: ["city"],
            type: "object",
          },
          name: "get_forecast",
        },
      ],
      config: { command: "weather-cli" },
      createdAt: new Date().toISOString(),
      enabled: true,
      id: "mcp_weather",
      lastError: null,
      name: "weather",
      status: "connected",
      transport: "stdio",
      updatedAt: new Date().toISOString(),
    };

    const mockServer2: StoredMcpServerRecord = {
      cachedTools: [
        {
          description: "Duplicate server tool",
          inputSchema: { type: "object" },
          name: "get_forecast",
        },
      ],
      config: { command: "weather-cli-2" },
      createdAt: new Date().toISOString(),
      enabled: true,
      id: "mcp_weather_2",
      lastError: null,
      name: "weather",
      status: "connected",
      transport: "stdio",
      updatedAt: new Date().toISOString(),
    };

    const tools = buildMcpToolDefinitions(
      [mockServer1, mockServer2],
      mockManager,
      "org-1",
      "prof-1"
    );

    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe("weather__get_forecast");
    expect(tools[1].name).toBe("weather__get_forecast_2");
    expect(tools[0].description).toBe("Get weather forecast for a city");
  });

  test("executes bridged MCP tool run function", async () => {
    let calledWith: any = null;

    const mockManager: any = {
      callTool: async (
        serverId: string,
        transport: string,
        toolName: string,
        input: any
      ) => {
        calledWith = { input, serverId, toolName, transport };
        return {
          content: [{ text: "Weather in Tokyo is Sunny, 24°C", type: "text" }],
        };
      },
      ensureConnected: async () => {},
      isConnected: () => true,
    };

    const server: StoredMcpServerRecord = {
      cachedTools: [
        {
          description: "Get weather forecast",
          inputSchema: { type: "object" },
          name: "get_forecast",
        },
      ],
      config: { command: "weather-mcp" },
      createdAt: new Date().toISOString(),
      enabled: true,
      id: "mcp_weather",
      lastError: null,
      name: "weather",
      status: "connected",
      transport: "stdio",
      updatedAt: new Date().toISOString(),
    };

    const tools = buildMcpToolDefinitions(
      [server],
      mockManager,
      "org-1",
      "prof-1"
    );
    const result = await tools[0].run({ city: "Tokyo" }, {} as any);

    expect(calledWith.toolName).toBe("get_forecast");
    expect(calledWith.input).toEqual({ city: "Tokyo" });
    expect((result as any).content[0].text).toContain("Tokyo is Sunny, 24°C");
  });
});
