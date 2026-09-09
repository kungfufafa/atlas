import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AwaitingApprovalError,
  type ChatMessage,
  type GenerateChatInput,
  runWithUserConfigDir,
  type ToolCall,
} from "@atlas/core";
import {
  listSubscriptionSessionDeletionCandidates,
  readSubscriptionSession,
} from "../session-store";
import { CodexAppServer, type CodexDynamicToolCall } from "./app-server";
import { ChatgptSubscriptionRuntime } from "./runtime";

type TurnOptions = Parameters<CodexAppServer["startTurn"]>[0];
type TurnResult = Awaited<ReturnType<CodexAppServer["startTurn"]>>;

class StructuredCodexServer extends CodexAppServer {
  readonly started: Parameters<CodexAppServer["startThread"]>[0][] = [];
  readonly resumed: string[] = [];
  readonly deleted: string[] = [];
  readonly turns: TurnOptions[] = [];
  deleteFailure: Error | undefined;
  handleTurn: (options: TurnOptions) => Promise<TurnResult> = async () => ({
    text: "Done.",
    thinking: "",
  });

  override isConnected(): boolean {
    return true;
  }

  override async account() {
    return { type: "chatgpt" };
  }

  override async listModels() {
    return [{ id: "model-test", isDefault: true }];
  }

  override async startThread(
    options: Parameters<CodexAppServer["startThread"]>[0]
  ): Promise<string> {
    this.started.push(options);
    return `native-${this.started.length}`;
  }

  override async resumeThread(id: string): Promise<string> {
    this.resumed.push(id);
    return id;
  }

  override async deleteThread(id: string): Promise<void> {
    this.deleted.push(id);
    if (this.deleteFailure) {
      throw this.deleteFailure;
    }
  }

  override async startTurn(options: TurnOptions): Promise<TurnResult> {
    this.turns.push(options);
    return await this.handleTurn(options);
  }
}

async function inTemporaryConfig(
  operation: () => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "atlas-codex-structured-"));
  try {
    await runWithUserConfigDir(directory, operation);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function makeInput(
  executeToolCall: NonNullable<GenerateChatInput["executeToolCall"]>
): GenerateChatInput {
  return {
    conversationId: "conversation-test",
    executeToolCall,
    messages: [{ content: "Look up the record.", role: "user" }],
    system: "You are Atlas.",
    tools: [
      {
        description: "Look up a record",
        name: "lookup",
        parameters: {
          properties: { query: { type: "string" } },
          required: ["query"],
          type: "object",
        },
      },
    ],
  };
}

function nativeCall(
  options: TurnOptions,
  id: string,
  argumentsValue: unknown = { query: id }
): CodexDynamicToolCall {
  return {
    arguments: argumentsValue,
    callId: id,
    threadId: options.threadId,
    tool: "lookup",
    turnId: `turn-${options.threadId}`,
  };
}

async function invokeTool(options: TurnOptions, call: CodexDynamicToolCall) {
  if (!options.onToolCall) {
    throw new Error("Expected a structured Atlas tool handler.");
  }
  return await options.onToolCall(
    call,
    options.signal ?? new AbortController().signal
  );
}

function appendReceipt(
  history: ChatMessage[],
  call: ToolCall,
  content: string
) {
  history.push(
    { content: "", role: "assistant", toolCalls: [structuredClone(call)] },
    { content, name: call.name, role: "tool", toolCallId: call.id }
  );
}

describe("Codex structured Atlas tools", () => {
  test("dispatches multiple native calls once and resumes after their canonical receipts", async () => {
    await inTemporaryConfig(async () => {
      const server = new StructuredCodexServer();
      const runtime = new ChatgptSubscriptionRuntime(server);
      const calls: ToolCall[] = [];
      const receipts: ChatMessage[] = [];
      const input = makeInput(async (call) => {
        calls.push(structuredClone(call));
        const content = `result:${call.id}`;
        appendReceipt(receipts, call, content);
        return { content, success: call.id !== "second" };
      });
      server.handleTurn = async (options) => {
        const first = nativeCall(options, "first");
        const result = await invokeTool(options, first);
        expect(await invokeTool(options, first)).toEqual(result);
        expect(result).toEqual({
          contentItems: [{ text: "result:first", type: "inputText" }],
          success: true,
        });
        expect(
          await invokeTool(options, nativeCall(options, "second"))
        ).toEqual({
          contentItems: [{ text: "result:second", type: "inputText" }],
          success: false,
        });
        options.onDelta?.("Done.");
        return {
          contextUsage: { contextWindow: 100, usedTokens: 20 },
          text: "Done.",
          thinking: "",
        };
      };
      const chunks: string[] = [];
      const result = await runtime.streamChat(input, {
        onChunk: (value) => chunks.push(value),
      });
      expect(calls.map((call) => call.id)).toEqual(["first", "second"]);
      expect(result.toolCalls).toEqual([]);
      expect(result.contextUsage).toEqual({
        contextWindow: 100,
        usedTokens: 20,
      });
      expect(chunks).toEqual(["Done."]);
      expect(server.started[0]?.dynamicTools).toEqual([
        {
          description: "Look up a record",
          inputSchema: input.tools?.[0]?.parameters,
          name: "lookup",
          type: "function",
        },
      ]);
      expect(server.started[0]?.developerInstructions).toBe(input.system);
      const binding = await readSubscriptionSession(
        "chatgpt",
        input.conversationId!
      );
      expect(binding?.lastMessageCount).toBe(5);
      expect(binding?.toolCatalogFingerprint).toBeString();

      server.handleTurn = async () => ({ text: "Continued.", thinking: "" });
      await runtime.generateChat({
        ...input,
        messages: [
          ...input.messages,
          ...receipts,
          result.assistantMessage,
          { content: "Continue.", role: "user" },
        ],
      });
      expect(server.resumed).toEqual(["native-1"]);
      expect(server.turns[1]?.input).toEqual([
        { text: "User:\nContinue.", text_elements: [], type: "text" },
      ]);
    });
  });

  test("replaces native sessions when tool declarations or bridge mode change", async () => {
    await inTemporaryConfig(async () => {
      const server = new StructuredCodexServer();
      const runtime = new ChatgptSubscriptionRuntime(server);
      const input = makeInput(async () => ({
        content: "result",
        success: true,
      }));
      const first = await runtime.generateChat(input);
      const changed: GenerateChatInput = {
        ...input,
        messages: [
          ...input.messages,
          first.assistantMessage,
          { content: "Continue.", role: "user" },
        ],
        tools: input.tools?.map((tool) => ({
          ...tool,
          parameters: { type: "object" },
        })),
      };
      const second = await runtime.generateChat(changed);
      await runtime.generateChat({
        ...changed,
        executeToolCall: undefined,
        messages: [
          ...changed.messages,
          second.assistantMessage,
          { content: "Continue again.", role: "user" },
        ],
      });
      expect(server.resumed).toEqual([]);
      expect(server.started).toHaveLength(3);
      expect(server.deleted).toEqual(["native-1", "native-2"]);
      expect(server.started[2]?.dynamicTools).toBeUndefined();
    });
  });

  test("preserves approval suspension after completed tools and clears the native continuation", async () => {
    await inTemporaryConfig(async () => {
      const server = new StructuredCodexServer();
      const runtime = new ChatgptSubscriptionRuntime(server);
      const suspension = new AwaitingApprovalError("approval-test", {
        args: {},
        runId: "run-test",
        stepIndex: 1,
        toolCallId: "pending",
        toolName: "lookup",
      });
      const calls: string[] = [];
      const input = makeInput(async (call) => {
        calls.push(call.id);
        if (call.id === "pending") {
          throw suspension;
        }
        return { content: "completed", success: true };
      });
      server.handleTurn = async (options) => {
        await invokeTool(options, nativeCall(options, "completed"));
        await invokeTool(options, nativeCall(options, "pending"));
        return { text: "Unexpected completion", thinking: "" };
      };
      let caught: unknown;
      try {
        await runtime.generateChat(input);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(suspension);
      expect(calls).toEqual(["completed", "pending"]);
      expect(
        await readSubscriptionSession("chatgpt", input.conversationId!)
      ).toBeNull();
      expect(server.deleted).toEqual(["native-1"]);
      expect(server.started).toHaveLength(1);
    });
  });

  test.each(["unknown", "invalid-arguments", "conflicting-id"])(
    "rejects %s without dispatching an extra action",
    async (failure) => {
      await inTemporaryConfig(async () => {
        const server = new StructuredCodexServer();
        const runtime = new ChatgptSubscriptionRuntime(server);
        const calls: string[] = [];
        const input = makeInput(async (call) => {
          calls.push(call.id);
          return { content: "result", success: true };
        });
        server.handleTurn = async (options) => {
          if (failure === "conflicting-id") {
            await invokeTool(
              options,
              nativeCall(options, "same", { query: "original" })
            );
          }
          const call = nativeCall(
            options,
            "same",
            failure === "invalid-arguments" ? [] : { query: "changed" }
          );
          if (failure === "unknown") {
            call.tool = "unregistered";
          }
          await invokeTool(options, call);
          return { text: "Unexpected completion", thinking: "" };
        };
        await expect(runtime.generateChat(input)).rejects.toBeInstanceOf(Error);
        expect(calls).toEqual(failure === "conflicting-id" ? ["same"] : []);
        expect(server.deleted).toEqual(["native-1"]);
      });
    }
  );

  test("keeps a resumed approval suspension when native deletion needs retry", async () => {
    await inTemporaryConfig(async () => {
      const server = new StructuredCodexServer();
      const runtime = new ChatgptSubscriptionRuntime(server);
      const suspension = new AwaitingApprovalError("approval-test", {
        args: {},
        runId: "run-test",
        stepIndex: 0,
        toolCallId: "pending",
        toolName: "lookup",
      });
      const input = makeInput(async () => {
        throw suspension;
      });
      const first = await runtime.generateChat(input);
      server.deleteFailure = new Error("Native deletion unavailable");
      server.handleTurn = async (options) => {
        await invokeTool(options, nativeCall(options, "pending"));
        return { text: "Unexpected completion", thinking: "" };
      };
      await expect(
        runtime.generateChat({
          ...input,
          messages: [
            ...input.messages,
            first.assistantMessage,
            { content: "Continue.", role: "user" },
          ],
        })
      ).rejects.toBe(suspension);
      expect(server.resumed).toEqual(["native-1"]);
      expect(
        await readSubscriptionSession("chatgpt", input.conversationId!)
      ).toBeNull();
      expect(
        await listSubscriptionSessionDeletionCandidates(input.conversationId!)
      ).toMatchObject([{ runtimeSessionId: "native-1" }]);
    });
  });

  test("does not retry a failed structured turn through the text bridge", async () => {
    await inTemporaryConfig(async () => {
      const server = new StructuredCodexServer();
      const runtime = new ChatgptSubscriptionRuntime(server);
      server.handleTurn = async () => {
        throw new Error("Structured tool protocol unavailable");
      };
      let calls = 0;
      const input = makeInput(async () => {
        calls += 1;
        return { content: "result", success: true };
      });
      await expect(runtime.generateChat(input)).rejects.toBeInstanceOf(Error);
      expect(server.turns).toHaveLength(1);
      expect(server.started).toHaveLength(1);
      expect(server.started[0]?.dynamicTools).toHaveLength(1);
      expect(server.started[0]?.developerInstructions).toBe(input.system);
      expect(calls).toBe(0);
      expect(server.deleted).toEqual(["native-1"]);
    });
  });

  test("passes cancellation to the Atlas callback without retaining a native session", async () => {
    await inTemporaryConfig(async () => {
      const server = new StructuredCodexServer();
      const runtime = new ChatgptSubscriptionRuntime(server);
      const controller = new AbortController();
      const cancellation = new Error("Cancelled by caller");
      const input = makeInput(async (_call, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort(cancellation);
        signal?.throwIfAborted();
        return { content: "Unexpected completion", success: true };
      });
      input.signal = controller.signal;
      server.handleTurn = async (options) => {
        await invokeTool(options, nativeCall(options, "cancelled"));
        return { text: "Unexpected completion", thinking: "" };
      };
      await expect(runtime.generateChat(input)).rejects.toBe(cancellation);
      expect(server.deleted).toEqual(["native-1"]);
    });
  });

  test("never parses text tool syntax in structured mode", async () => {
    await inTemporaryConfig(async () => {
      const server = new StructuredCodexServer();
      const runtime = new ChatgptSubscriptionRuntime(server);
      const text = '```atlas-tool-call\n{"name":"lookup","arguments":{}}\n```';
      server.handleTurn = async () => ({ text, thinking: "" });
      let calls = 0;
      const input = makeInput(async () => {
        calls += 1;
        return { content: "result", success: true };
      });
      const result = await runtime.generateChat(input);
      expect(result.content).toBe(text);
      expect(result.toolCalls).toEqual([]);
      expect(calls).toBe(0);
    });
  });
});
