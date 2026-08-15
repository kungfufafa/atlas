import {
  builtinTools,
  type ToolContext,
  type ToolDefinition,
  type UserConfig,
} from "@atlas/core";
import {
  isEmailConfigComplete,
  loadEmailConfig,
} from "@atlas/core/email-config";
import { emailTool } from "@atlas/core/tools/email";
import type { DatabaseAdapter, StoredToolRecord } from "@atlas/db";
import { bashTool, runBash } from "../tools/bash";
import { createConversationTools } from "../tools/conversation-tools";
import { createMemoryTools } from "../tools/memory-tools";
import { pythonExecuteTool } from "../tools/python-execute-tool";
import { createToolSearchTool } from "../tools/tool-search-tool";
import { enrichCodingAgentBashInput } from "./coding-agent-bash-env";
import { loadJavascriptTool } from "./javascript-tool-loader";
import { MemoryService } from "./memory-service";

let registeredSubAgentTool: ToolDefinition | null = null;
let registeredGenerateImageTool: ToolDefinition | null = null;

export function registerSubAgentTool(tool: ToolDefinition): void {
  registeredSubAgentTool = tool;
}

export function registerGenerateImageTool(tool: ToolDefinition | null): void {
  registeredGenerateImageTool = tool;
}

export function omitUnavailableBuiltinTools(
  tools: ToolDefinition[],
  emailConfigured: boolean
): ToolDefinition[] {
  if (emailConfigured) {
    return tools;
  }

  return tools.filter((tool) => tool.name !== emailTool.name);
}

export async function resolveProfileStoredTools(
  records: StoredToolRecord[],
  db?: DatabaseAdapter,
  builtinOverrides: ToolDefinition[] = [],
  options: { userConfig?: UserConfig | null } = {}
): Promise<ToolDefinition[]> {
  const tools = await resolveToolsFromStorage(
    records,
    db,
    builtinOverrides,
    options
  );
  return omitUnavailableBuiltinTools(
    tools,
    isEmailConfigComplete(await loadEmailConfig())
  );
}

export async function resolveToolsFromStorage(
  records: StoredToolRecord[],
  db?: DatabaseAdapter,
  builtinOverrides: ToolDefinition[] = [],
  options: { userConfig?: UserConfig | null } = {}
): Promise<ToolDefinition[]> {
  const builtinMap = new Map(
    [...builtinTools, ...builtinOverrides].map((tool) => [tool.name, tool])
  );
  const serverTools = buildServerTools(db, options.userConfig);
  const resolved: ToolDefinition[] = [];

  for (const record of records) {
    const tool = await resolveStoredTool(record, builtinMap, serverTools);

    if (tool) {
      resolved.push(tool);
    }
  }

  return resolved;
}

async function resolveStoredTool(
  record: StoredToolRecord,
  builtinMap: Map<string, ToolDefinition>,
  serverTools: Map<string, ToolDefinition>
): Promise<ToolDefinition | null> {
  if (record.handlerType === "builtin") {
    return builtinMap.get(record.name) ?? null;
  }

  if (record.handlerType === "bash") {
    return serverTools.get(record.name) ?? null;
  }

  if (record.handlerType === "sub_agent") {
    return serverTools.get(record.name) ?? null;
  }

  if (record.handlerType === "generate_image") {
    return serverTools.get(record.name) ?? null;
  }

  if (
    record.handlerType === "python_execute" ||
    record.name === "python_execute"
  ) {
    return serverTools.get(record.name) ?? pythonExecuteTool;
  }

  if (record.handlerType === "memory" || record.name.startsWith("memory_")) {
    return serverTools.get(record.name) ?? null;
  }

  if (record.handlerType === "tool_search" || record.name === "tool_search") {
    return serverTools.get(record.name) ?? null;
  }

  if (record.handlerType === "javascript") {
    return loadJavascriptTool(record);
  }

  return null;
}

function buildServerTools(
  db?: DatabaseAdapter,
  userConfig?: UserConfig | null
): Map<string, ToolDefinition> {
  const bash = db ? createCodingAgentAwareBashTool(db, userConfig) : bashTool;
  const map = new Map<string, ToolDefinition>([[bash.name, bash]]);
  map.set(pythonExecuteTool.name, pythonExecuteTool);

  if (db) {
    const memoryService = new MemoryService(db);
    const memoryTools = createMemoryTools(memoryService);
    for (const tool of memoryTools) {
      map.set(tool.name, tool);
    }
    const conversationTools = createConversationTools(db);
    for (const tool of conversationTools) {
      map.set(tool.name, tool);
    }
  }

  const toolSearch = createToolSearchTool(async (_context) => [
    ...builtinTools,
    pythonExecuteTool,
    bashTool,
  ]);
  map.set(toolSearch.name, toolSearch);

  if (registeredSubAgentTool) {
    map.set(registeredSubAgentTool.name, registeredSubAgentTool);
  }

  if (registeredGenerateImageTool) {
    map.set(registeredGenerateImageTool.name, registeredGenerateImageTool);
  }

  return map;
}

function createCodingAgentAwareBashTool(
  db: DatabaseAdapter,
  userConfig?: UserConfig | null
): ToolDefinition {
  return {
    ...bashTool,
    run: async (input, context: ToolContext) => {
      const enriched = await enrichCodingAgentBashInput(
        db,
        input,
        context,
        userConfig
      );
      return runBash(enriched, context);
    },
  };
}
