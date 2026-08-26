import {
  distillToolResult,
  executeProtectedTool,
  metrics,
  standardizeToolError,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
  withSpan,
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
    metrics.toolCallsTotal.inc({ status: "error", tool: call.name });
    metrics.toolFailuresTotal.inc({ tool: call.name });
    return {
      error: `Unknown tool: ${call.name}`,
    };
  }

  const startMs = Date.now();
  try {
    return await withSpan(`tool.${call.name}`, async () => {
      const guardedTool: ToolDefinition = context.beforeToolCall
        ? {
            ...tool,
            async run(input, runContext) {
              await runContext.beforeToolCall?.();
              return tool.run(input, runContext);
            },
          }
        : tool;
      const execution = await executeProtectedTool(
        guardedTool,
        call.arguments,
        context
      );

      const durationMs = Date.now() - startMs;
      metrics.toolLatencyMs.observe(durationMs, { tool: call.name });

      if (!execution.success && execution.error) {
        metrics.toolCallsTotal.inc({ status: "error", tool: call.name });
        metrics.toolFailuresTotal.inc({ tool: call.name });
        return {
          error: execution.error.message,
          errorCode: execution.error.code,
        };
      }

      metrics.toolCallsTotal.inc({ status: "success", tool: call.name });

      const rawData = execution.data;
      // The single place every tool result passes through, so the optimiser is
      // wired once rather than per tool. It returns `result` untouched unless it
      // is enabled, recognises the tool, and produces something strictly shorter.
      const distilled = await distillToolResult(call.name, rawData, context);

      if (execution.artifacts && execution.artifacts.length > 0) {
        if (
          typeof distilled !== "object" ||
          distilled === null ||
          Array.isArray(distilled)
        ) {
          return {
            artifacts: execution.artifacts,
            result: distilled,
          };
        }

        return {
          ...(distilled as Record<string, unknown>),
          artifacts: execution.artifacts,
        };
      }

      return distilled;
    });
  } catch (error) {
    const durationMs = Date.now() - startMs;
    metrics.toolLatencyMs.observe(durationMs, { tool: call.name });
    metrics.toolCallsTotal.inc({ status: "error", tool: call.name });
    metrics.toolFailuresTotal.inc({ tool: call.name });

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
