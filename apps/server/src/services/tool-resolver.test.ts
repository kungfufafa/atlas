import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@atlas/core";
import { emailTool } from "@atlas/core/tools/email";
import {
  BUILTIN_TOOL_IDS,
  PROTECTED_TOOL_IDS,
} from "@atlas/core/tools/protected";
import {
  createInMemoryDatabaseAdapter,
  type StoredToolRecord,
  seedDatabase,
} from "@atlas/db";
import {
  omitUnavailableBuiltinTools,
  resolveProfileStoredTools,
  resolveToolsFromStorage,
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
  test("standalone stored-tool search only discovers the resolved assignment set", async () => {
    const records = ["tool_search", "calculator"].map((name) => ({
      createdAt: "2026-09-06T00:00:00.000Z",
      description: name,
      handlerConfig: {},
      handlerType: "builtin",
      id: `assigned_${name}`,
      name,
      updatedAt: "2026-09-06T00:00:00.000Z",
    }));
    const tools = await resolveToolsFromStorage(records);
    const search = tools.find((tool) => tool.name === "tool_search");
    expect(search).toBeDefined();
    expect(await search?.run({ query: "python_execute" }, {})).toMatchObject({
      totalMatches: 0,
    });
    expect(await search?.run({ query: "calculator" }, {})).toMatchObject({
      totalMatches: 1,
    });
    expect(search?.parallelSafe).not.toBe(true);
  });
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

  test("resolves memory_search and search_chats even when seeded as builtin", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    const records: StoredToolRecord[] = [
      {
        createdAt: now,
        description: "Search memories",
        handlerConfig: {},
        handlerType: "builtin",
        id: BUILTIN_TOOL_IDS.memory_search,
        name: "memory_search",
        updatedAt: now,
      },
      {
        createdAt: now,
        description: "Search chats",
        handlerConfig: {},
        handlerType: "builtin",
        id: BUILTIN_TOOL_IDS.search_chats,
        name: "search_chats",
        updatedAt: now,
      },
    ];

    const resolved = await resolveToolsFromStorage(records, db);
    expect(resolved.map((tool) => tool.name).sort()).toEqual([
      "memory_search",
      "search_chats",
    ]);
  });

  test("resolves every protected tool after seed", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedDatabase(db);
    const stored = await db.listTools();
    const protectedRecords = stored.filter((record) =>
      PROTECTED_TOOL_IDS.has(record.id)
    );
    const resolved = await resolveToolsFromStorage(protectedRecords, db);
    const resolvedNames = new Set(resolved.map((tool) => tool.name));

    const expectedNames = [
      ...Object.keys(BUILTIN_TOOL_IDS),
      "python_execute",
      "tool_search",
    ];

    for (const name of expectedNames) {
      expect(resolvedNames.has(name)).toBe(true);
    }
  });
});
