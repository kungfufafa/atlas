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
import { bashTool, createBashRunner, runBash } from "../tools/bash";
import { createConversationTools } from "../tools/conversation-tools";
import { createMemoryTools } from "../tools/memory-tools";
import {
  createPythonExecutor,
  pythonExecuteTool,
} from "../tools/python-execute-tool";
import { createToolSearchTool } from "../tools/tool-search-tool";
import { enrichCodingAgentBashInput } from "./coding-agent-bash-env";
import { loadJavascriptTool } from "./javascript-tool-loader";
import { MemoryService } from "./memory-service";
import type { ProcessToolAdmissionPolicy } from "./process-tool-admission";

export interface ToolResolutionOptions {
  processAdmission?: ProcessToolAdmissionPolicy;
  userConfig?: UserConfig | null;
}

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
  options: ToolResolutionOptions = {}
): Promise<ToolDefinition[]> {
  const tools = await resolveToolsFromStorage(
    records,
    db,
    builtinOverrides,
    options
  );
  return withToolSearchCatalog(
    omitUnavailableBuiltinTools(
      tools,
      isEmailConfigComplete(await loadEmailConfig())
    )
  );
}

export async function resolveToolsFromStorage(
  records: StoredToolRecord[],
  db?: DatabaseAdapter,
  builtinOverrides: ToolDefinition[] = [],
  options: ToolResolutionOptions = {}
): Promise<ToolDefinition[]> {
  const builtinMap = new Map(
    [...builtinTools, ...builtinOverrides].map((tool) => [tool.name, tool])
  );
  const serverTools = buildServerTools(db, options);
  const resolved: ToolDefinition[] = [];

  for (const record of records) {
    const tool = await resolveStoredTool(record, builtinMap, serverTools);

    if (tool) {
      resolved.push(tool);
    }
  }

  return withToolSearchCatalog(resolved);
}

async function resolveStoredTool(
  record: StoredToolRecord,
  builtinMap: Map<string, ToolDefinition>,
  serverTools: Map<string, ToolDefinition>
): Promise<ToolDefinition | null> {
  if (record.handlerType === "javascript") {
    return loadJavascriptTool(record);
  }

  const serverTool = serverTools.get(record.name);
  if (
    record.handlerType === "memory" ||
    record.handlerType === "conversation" ||
    record.handlerType === "bash" ||
    record.handlerType === "sub_agent" ||
    record.handlerType === "generate_image" ||
    record.handlerType === "python_execute" ||
    record.handlerType === "tool_search" ||
    record.name.startsWith("memory_") ||
    record.name === "search_chats" ||
    record.name === "get_conversation" ||
    record.name === "python_execute" ||
    record.name === "tool_search"
  ) {
    if (record.name === "python_execute") {
      return serverTool ?? pythonExecuteTool;
    }
    return serverTool ?? null;
  }

  if (record.handlerType === "builtin") {
    return builtinMap.get(record.name) ?? serverTool ?? null;
  }

  return serverTool ?? builtinMap.get(record.name) ?? null;
}

function buildServerTools(
  db?: DatabaseAdapter,
  options: ToolResolutionOptions = {}
): Map<string, ToolDefinition> {
  const { processAdmission, userConfig } = options;
  const bashRunner = processAdmission
    ? createBashRunner(processAdmission)
    : runBash;
  const baseBash = processAdmission
    ? { ...bashTool, run: bashRunner }
    : bashTool;
  const bash = db
    ? createCodingAgentAwareBashTool(db, userConfig, bashRunner)
    : baseBash;
  const python = processAdmission
    ? { ...pythonExecuteTool, run: createPythonExecutor(processAdmission) }
    : pythonExecuteTool;
  const map = new Map<string, ToolDefinition>([[bash.name, bash]]);
  map.set(python.name, python);

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

  // The final resolved assignment set supplies this tool's catalog.
  const toolSearch = createToolSearchTool(async () => []);
  map.set(toolSearch.name, toolSearch);

  if (registeredSubAgentTool) {
    map.set(registeredSubAgentTool.name, registeredSubAgentTool);
  }

  if (registeredGenerateImageTool) {
    map.set(registeredGenerateImageTool.name, registeredGenerateImageTool);
  }

  return map;
}

export function withToolSearchCatalog(
  tools: ToolDefinition[]
): ToolDefinition[] {
  const catalog = tools.filter((tool) => tool.name !== "tool_search");
  const search = createToolSearchTool(async () => catalog);
  return tools.map((tool) => (tool.name === "tool_search" ? search : tool));
}

function createCodingAgentAwareBashTool(
  db: DatabaseAdapter,
  userConfig: UserConfig | null | undefined,
  run: typeof runBash
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
      return run(enriched, context);
    },
  };
}
