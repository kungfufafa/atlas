import {
  distillToolResult,
  executeProtectedTool,
  standardizeToolError,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
} from "@atlas/core";

export function findTool(
  tools: ToolDefinition[],
  name: string
): ToolDefinition | undefined {
  return tools.find((tool) => tool.name === name);
}

export function canRunToolCallsInParallel(
  tools: ToolDefinition[],
  toolCalls: ToolCall[]
): boolean {
  if (toolCalls.length <= 1) {
    return false;
  }

  return toolCalls.every(
    (call) => findTool(tools, call.name)?.parallelSafe === true
  );
}

export async function executeToolCall(
  tools: ToolDefinition[],
  call: ToolCall,
  context: ToolContext = {}
): Promise<unknown> {
  const tool = findTool(tools, call.name);

  if (!tool) {
    return {
      error: `Unknown tool: ${call.name}`,
    };
  }

  try {
    const execution = await executeProtectedTool(tool, call.arguments, context);

    if (!execution.success && execution.error) {
      return {
        error: execution.error.message,
        errorCode: execution.error.code,
      };
    }

    const rawData = execution.data;
    // The single place every tool result passes through, so the optimiser is
    // wired once rather than per tool. It returns `result` untouched unless it
    // is enabled, recognises the tool, and produces something strictly shorter.
    const distilled = await distillToolResult(call.name, rawData, context);

    if (
      execution.artifacts &&
      execution.artifacts.length > 0 &&
      typeof distilled === "object" &&
      distilled !== null
    ) {
      return {
        ...(distilled as Record<string, unknown>),
        artifacts: execution.artifacts,
      };
    }

    return distilled;
  } catch (error) {
    const standardized = standardizeToolError(error);
    return {
      error: standardized.message,
      errorCode: standardized.code,
    };
  }
}

export function serializeToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  return JSON.stringify(result);
}
