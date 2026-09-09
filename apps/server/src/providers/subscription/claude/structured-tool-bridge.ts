import { createHash } from "node:crypto";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ChatMessage, GenerateChatInput, ToolCall } from "@atlas/core";
import { computeActionHash } from "@atlas/core";
import { z } from "zod/v3";
import type { ClaudeAgentSdk } from "./runtime";

const listToolsRequest = z.object({ method: z.literal("tools/list") });
const callToolRequest = z.object({
  method: z.literal("tools/call"),
  params: z.object({
    arguments: z.record(z.string(), z.unknown()).optional(),
    name: z.string(),
  }),
});

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

export interface ClaudeAtlasToolBridge {
  allowedTools: string[];
  assertComplete(): void;
  assertHealthy(): void;
  close(): Promise<void>;
  failed: boolean;
  failure: unknown;
  fingerprint: string;
  history: ChatMessage[];
  server: McpSdkServerConfigWithInstance;
}

export function createClaudeToolBridge(
  input: GenerateChatInput,
  sdk: ClaudeAgentSdk,
  controller: AbortController
): ClaudeAtlasToolBridge | undefined {
  const executeToolCall = input.executeToolCall;
  if (!(executeToolCall && input.tools?.length)) {
    return;
  }
  if (!sdk.createSdkMcpServer) {
    throw new Error(
      "Claude SDK structured tool registration is unavailable. Reinstall Atlas dependencies before retrying."
    );
  }
  const catalog = input.tools.map((tool) => ({
    _meta: { "anthropic/alwaysLoad": true },
    description: tool.description,
    inputSchema: structuredClone(tool.parameters),
    name: tool.name,
  }));
  const names = new Set(catalog.map((tool) => tool.name));
  if (
    names.size !== catalog.length ||
    catalog.some((tool) => !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name))
  ) {
    throw new Error(
      "Atlas tools must have unique valid names for Claude registration."
    );
  }
  // Use public low-level MCP request handlers so the advertised JSON schemas
  // retain refs, unions, additionalProperties, and every other Atlas constraint.
  // Converting them to the SDK's Zod raw-shape shorthand would lose root rules.
  const server = sdk.createSdkMcpServer({ name: "atlas", tools: [] });
  const history = [...input.messages];
  const turnId = crypto.randomUUID();
  const executions = new Map<
    string,
    { fingerprint: string; result: Promise<McpToolResult> }
  >();
  let failed = false;
  let failure: unknown;
  let closed = false;
  let pending = 0;

  const fail = (error: unknown): never => {
    if (!failed) {
      failed = true;
      failure = error;
    }
    controller.abort(failure);
    throw failure;
  };
  const assertHealthy = (): void => {
    if (failed) {
      throw failure;
    }
    if (closed) {
      throw new Error("Claude Atlas tool bridge is closed.");
    }
    controller.signal.throwIfAborted();
    input.signal?.throwIfAborted();
  };
  const run = async (
    call: ToolCall,
    signal: AbortSignal
  ): Promise<McpToolResult> => {
    pending++;
    try {
      const canonicalCall = structuredClone(call);
      const result = await executeToolCall(call, signal);
      history.push(
        { content: "", role: "assistant", toolCalls: [canonicalCall] },
        {
          content: result.content,
          name: canonicalCall.name,
          role: "tool",
          toolCallId: canonicalCall.id,
        }
      );
      return {
        content: [{ text: result.content, type: "text" }],
        isError: !result.success,
      };
    } catch (error) {
      return fail(error);
    } finally {
      pending--;
    }
  };

  // Keep the public protocol boundary shallow: the SDK bundles a newer MCP
  // implementation than its externally resolved generic declaration graph.
  const register = server.instance.server.setRequestHandler as unknown as (
    schema: z.ZodTypeAny,
    handler: (
      request: unknown,
      extra: { requestId: unknown; signal: AbortSignal }
    ) => Promise<unknown>
  ) => void;
  register.call(server.instance.server, listToolsRequest, async () => ({
    tools: catalog,
  }));
  register.call(
    server.instance.server,
    callToolRequest,
    async (rawRequest, extra) => {
      const request = callToolRequest.parse(rawRequest);
      try {
        assertHealthy();
        const requestId = extra.requestId;
        if (
          !(
            (typeof requestId === "string" && requestId.trim()) ||
            (typeof requestId === "number" && Number.isSafeInteger(requestId))
          )
        ) {
          return fail(
            new Error(
              "Claude requested an Atlas tool without a valid MCP request ID."
            )
          );
        }
        if (!names.has(request.params.name)) {
          return fail(
            new Error("Claude requested an unregistered Atlas tool.")
          );
        }
        const call = {
          arguments: structuredClone(request.params.arguments ?? {}),
          id: `claude-mcp:${turnId}:${typeof requestId}:${requestId}`,
          name: request.params.name,
        };
        const fingerprint = computeActionHash({
          args: call.arguments,
          tool: call.name,
        });
        const previous = executions.get(call.id);
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            return fail(
              new Error(
                "Claude reused an MCP request ID for a different Atlas action."
              )
            );
          }
          return await previous.result;
        }
        const signal = AbortSignal.any([controller.signal, extra.signal]);
        signal.throwIfAborted();
        const result = run(call, signal);
        executions.set(call.id, { fingerprint, result });
        return await result;
      } catch (error) {
        return fail(error);
      }
    }
  );

  return {
    allowedTools: catalog.map((tool) => `mcp__atlas__${tool.name}`),
    assertComplete() {
      assertHealthy();
      if (pending > 0) {
        fail(
          new Error(
            "Claude completed before Atlas tool results were acknowledged."
          )
        );
      }
    },
    assertHealthy,
    async close() {
      closed = true;
      await server.instance.close();
    },
    get failed() {
      return failed;
    },
    get failure() {
      return failure;
    },
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ mode: "claude-sdk-mcp-v1", tools: catalog }))
      .digest("base64url"),
    history,
    server,
  };
}
