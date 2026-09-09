import {
  distillToolResult,
  evaluateActionRisk,
  executeProtectedTool,
  metrics,
  serializeToolOutput,
  standardizeToolError,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
  withSpan,
} from "@atlas/core";
import {
  reportToolLifecycleError,
  type ToolExecutionLifecycle,
  type ToolInvocationLifecycle,
} from "./tool-execution-lifecycle";
import { toolResultError } from "./tool-progress";

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
    (call) =>
      findTool(tools, call.name)?.parallelSafe === true &&
      !evaluateActionRisk(call.name, call.arguments).requiresApproval
  );
}

export async function executeToolCall(
  tools: ToolDefinition[],
  call: ToolCall,
  context: ToolContext = {},
  lifecycle?: ToolExecutionLifecycle
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
      let invocation: ToolInvocationLifecycle | undefined;
      if (lifecycle) {
        try {
          invocation = await lifecycle.begin(call, context);
        } catch (error) {
          reportToolLifecycleError(lifecycle, error, "begin");
        }
      }
      const execution = await executeProtectedTool(tool, call.arguments, {
        ...context,
        artifactPublisher: invocation?.publisher,
      });

      if (invocation && lifecycle) {
        try {
          // Observe the actual protected result before any history distillation.
          await invocation.complete(execution);
        } catch (error) {
          reportToolLifecycleError(lifecycle, error, "complete");
        }
      }

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

      const rawData = execution.data;
      const reportedError = toolResultError(rawData);
      metrics.toolCallsTotal.inc({
        status: reportedError ? "error" : "success",
        tool: call.name,
      });
      if (reportedError) {
        metrics.toolFailuresTotal.inc({ tool: call.name });
      }
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
  return serializeToolOutput(result).text;
}
