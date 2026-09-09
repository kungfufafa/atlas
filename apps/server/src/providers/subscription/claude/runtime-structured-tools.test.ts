import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  AwaitingApprovalError,
  type ChatMessage,
  type GenerateChatInput,
  runWithUserConfigDir,
  type SubscriptionAuthState,
  type ToolCall,
  validateToolArguments,
} from "@atlas/core";
import { readSubscriptionSession } from "../session-store";
import type { ClaudeInferenceClock } from "./inference-deadline";
import { type ClaudeAgentSdk, ClaudeSubscriptionRuntime } from "./runtime";
import type { ClaudeAtlasToolBridge } from "./structured-tool-bridge";

class AuthenticatedRuntime extends ClaudeSubscriptionRuntime {
  override async getAuthState(): Promise<SubscriptionAuthState> {
    return { authenticated: true, provider: "claude", status: "authenticated" };
  }
}

/** Drives the real installed SDK MCP server without launching a CLI or inference. */
async function connectMcp(server: ClaudeAtlasToolBridge["server"]) {
  const responses = new Map<
    string | number,
    (response: Record<string, unknown>) => void
  >();
  const transport = {
    async close() {},
    onmessage: undefined as ((message: unknown) => void) | undefined,
    async send(message: unknown) {
      const value = message as Record<string, unknown>;
      if (typeof value.id === "string" || typeof value.id === "number") {
        responses.get(value.id)?.(value);
      }
    },
    async start() {},
  };
  await server.instance.connect(
    transport as Parameters<typeof server.instance.connect>[0]
  );
  const request = (
    id: number | string,
    method: string,
    params: Record<string, unknown>
  ) =>
    new Promise<Record<string, unknown>>((resolve) => {
      responses.set(id, resolve);
      transport.onmessage?.({ id, jsonrpc: "2.0", method, params });
    });
  await request("initialize", "initialize", {
    capabilities: {},
    clientInfo: { name: "atlas-offline-test", version: "1.0.0" },
    protocolVersion: "2025-11-25",
  });
  return {
    async call(id: number | string, name: string, args: unknown) {
      const response = await request(id, "tools/call", {
        arguments: args,
        name,
      });
      if (response.error) {
        throw new Error(JSON.stringify(response.error));
      }
      return response.result as {
        content: Array<{ text: string; type: string }>;
        isError: boolean;
      };
    },
    async list() {
      const response = await request("list", "tools/list", {});
      return response.result as { tools: unknown[] };
    },
  };
}

type McpClient = Awaited<ReturnType<typeof connectMcp>>;
function createSdk(
  script: (
    client: McpClient,
    options: Record<string, unknown>
  ) => Promise<void | string>
) {
  const queries: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const prompts: string[] = [];
  const sdk: ClaudeAgentSdk = {
    createSdkMcpServer,
    deleteSession: async (id) => {
      deleted.push(id);
    },
    query: ({ options = {}, prompt }) => {
      queries.push(options);
      const sessionId =
        typeof options.resume === "string"
          ? options.resume
          : `session-${queries.length}`;
      return {
        async *[Symbol.asyncIterator]() {
          const item =
            typeof prompt === "string"
              ? prompt
              : (await prompt[Symbol.asyncIterator]().next()).value?.message
                  .content;
          prompts.push(String(item));
          yield { session_id: sessionId, subtype: "init", type: "system" };
          const server = (
            options.mcpServers as { atlas: ClaudeAtlasToolBridge["server"] }
          ).atlas;
          const result = await script(await connectMcp(server), options);
          yield {
            is_error: false,
            result: result ?? "Finished.",
            session_id: sessionId,
            subtype: "success",
            type: "result",
            usage: { input_tokens: 3, output_tokens: 4 },
          };
        },
        close() {},
        async interrupt() {},
      };
    },
  };
  return { deleted, prompts, queries, sdk };
}

function makeInput(
  executeToolCall: NonNullable<GenerateChatInput["executeToolCall"]>
): GenerateChatInput {
  return {
    conversationId: "atlas-session",
    executeToolCall,
    messages: [{ content: "Find both records.", role: "user" }],
    system: "You are Atlas.",
    tools: [
      {
        description: "Read a record",
        name: "lookup",
        parameters: {
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"],
          type: "object",
        },
      },
    ],
  };
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

async function isolated(run: () => Promise<void>) {
  const directory = await mkdtemp("/tmp/atlas-claude-structured-");
  try {
    await runWithUserConfigDir(directory, run);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe("Claude structured Atlas bridge", () => {
  test("registers unchanged JSON schemas, executes multiple native calls, and isolates host capabilities", async () => {
    await isolated(async () => {
      const calls: ToolCall[] = [];
      const input = makeInput(async (call) => {
        calls.push(call);
        return { content: JSON.stringify(call.arguments), success: true };
      });
      const captured = createSdk(async (client, options) => {
        expect((await client.list()).tools).toEqual([
          {
            _meta: { "anthropic/alwaysLoad": true },
            description: "Read a record",
            inputSchema: input.tools![0]!.parameters,
            name: "lookup",
          },
        ]);
        expect(options.tools).toEqual([]);
        expect(options.allowedTools).toEqual(["mcp__atlas__lookup"]);
        expect(options.settingSources).toEqual([]);
        expect(options.skills).toEqual([]);
        expect(options.strictMcpConfig).toBe(true);
        expect(options.maxTurns).toBeUndefined();
        expect(String(options.systemPrompt)).not.toContain("atlas-tool-call");
        expect(
          (await client.call(1, "lookup", { query: "first" })).isError
        ).toBe(false);
        expect(
          (await client.call(2, "lookup", { query: "second" })).content
        ).toEqual([{ text: '{"query":"second"}', type: "text" }]);
      });
      const result = await new AuthenticatedRuntime({
        sdk: captured.sdk,
      }).generateChat(input);
      expect(result.content).toBe("Finished.");
      expect(result.toolCalls).toEqual([]);
      expect(calls.map((call) => call.arguments)).toEqual([
        { query: "first" },
        { query: "second" },
      ]);
      expect(calls[0]!.id).not.toBe(calls[1]!.id);
      expect(
        (await readSubscriptionSession("claude", "atlas-session"))
          ?.lastMessageCount
      ).toBe(5);
    });
  });

  test("reuses native sessions only when callback receipts and catalog match", async () => {
    await isolated(async () => {
      const history: ChatMessage[] = [
        { content: "Find both records.", role: "user" },
      ];
      let callbackCount = 0;
      const input = makeInput(async (call) => {
        callbackCount++;
        appendReceipt(history, call, "found");
        return { content: "found", success: true };
      });
      let turn = 0;
      const captured = createSdk(async (client) => {
        if (turn++ === 0) {
          await client.call(1, "lookup", { query: "first" });
        }
      });
      const runtime = new AuthenticatedRuntime({ sdk: captured.sdk });
      await runtime.generateChat(input);
      history.push(
        { content: "Finished.", role: "assistant" },
        { content: "Continue", role: "user" }
      );
      await runtime.generateChat({ ...input, messages: [...history] });
      expect(captured.queries[1]!.resume).toBe("session-1");
      expect(callbackCount).toBe(1);
      expect(captured.prompts[1]).not.toContain("found");
      history.push(
        { content: "Finished.", role: "assistant" },
        { content: "Continue again", role: "user" }
      );
      await runtime.generateChat({
        ...input,
        messages: history,
        tools: [{ ...input.tools![0]!, description: "Changed catalog" }],
      });
      expect(captured.queries[2]!.resume).toBeUndefined();
      expect(captured.deleted).toContain("session-1");
    });
  });

  test("replays duplicate MCP IDs without executing twice and rejects conflicting reuse", async () => {
    await isolated(async () => {
      let executions = 0;
      const captured = createSdk(async (client) => {
        const first = await client.call(5, "lookup", { query: "first" });
        expect(await client.call(5, "lookup", { query: "first" })).toEqual(
          first
        );
        await client.call(5, "lookup", { query: "other" });
      });
      const runtime = new AuthenticatedRuntime({ sdk: captured.sdk });
      await expect(
        runtime.generateChat(
          makeInput(async () => {
            executions++;
            return { content: "found", success: true };
          })
        )
      ).rejects.toThrow("reused");
      expect(executions).toBe(1);
      expect(
        await readSubscriptionSession("claude", "atlas-session")
      ).toBeNull();
    });
  });

  test("preserves suspension identity and never converts it to a completed native result", async () => {
    await isolated(async () => {
      const suspension = new AwaitingApprovalError("approval", {
        args: {},
        runId: "run",
        stepIndex: 1,
        toolCallId: "pending",
        toolName: "lookup",
      });
      const history: ChatMessage[] = [];
      const captured = createSdk(async (client) => {
        await client.call(1, "lookup", { query: "first" });
        await client.call(2, "lookup", { query: "pending" });
      });
      const runtime = new AuthenticatedRuntime({ sdk: captured.sdk });
      await expect(
        runtime.generateChat(
          makeInput(async (call) => {
            if (call.arguments.query === "pending") {
              throw suspension;
            }
            appendReceipt(history, call, "completed first action");
            return { content: "completed first action", success: true };
          })
        )
      ).rejects.toBe(suspension);
      expect(
        await readSubscriptionSession("claude", "atlas-session")
      ).toBeNull();
      expect(captured.deleted).toContain("session-1");
      expect(history).toHaveLength(2);
      expect(history.at(-1)?.content).toBe("completed first action");
    });
  });

  test("returns failed Atlas results as MCP tool errors while preserving receipts", async () => {
    await isolated(async () => {
      const captured = createSdk(async (client) => {
        expect(await client.call(1, "lookup", { query: "missing" })).toEqual({
          content: [{ text: "Record missing", type: "text" }],
          isError: true,
        });
      });
      const result = await new AuthenticatedRuntime({
        sdk: captured.sdk,
      }).generateChat(
        makeInput(async () => ({ content: "Record missing", success: false }))
      );
      expect(result.content).toBe("Finished.");
      expect(
        (await readSubscriptionSession("claude", "atlas-session"))
          ?.lastMessageCount
      ).toBe(3);
    });
  });

  test("rejects unknown tool names before dispatch", async () => {
    await isolated(async () => {
      let executions = 0;
      const captured = createSdk(async (client) => {
        await client.call(1, "Bash", {});
      });
      await expect(
        new AuthenticatedRuntime({ sdk: captured.sdk }).generateChat(
          makeInput(async () => {
            executions++;
            return { content: "should not execute", success: true };
          })
        )
      ).rejects.toThrow("unregistered");
      expect(executions).toBe(0);
    });
  });
  test("passes raw arguments to Atlas schema validation before any effect", async () => {
    await isolated(async () => {
      let effects = 0;
      const input = makeInput(async (call) => {
        validateToolArguments(input.tools![0]!.parameters, call.arguments);
        effects++;
        return { content: "found", success: true };
      });
      const captured = createSdk(async (client) => {
        await client.call(1, "lookup", { extra: true, query: 42 });
      });
      await expect(
        new AuthenticatedRuntime({ sdk: captured.sdk }).generateChat(input)
      ).rejects.toThrow();
      expect(effects).toBe(0);
    });
  });

  test("does not fall back to textual tools when structured SDK registration is missing", async () => {
    await isolated(async () => {
      let queries = 0;
      const sdk: ClaudeAgentSdk = {
        query() {
          queries++;
          throw new Error("must not start inference");
        },
      };
      await expect(
        new AuthenticatedRuntime({ sdk }).generateChat(
          makeInput(async () => ({ content: "unused", success: true }))
        )
      ).rejects.toThrow("registration");
      expect(queries).toBe(0);
    });
  });

  test("cancellation aborts the accepted callback and invalidates native continuation", async () => {
    await isolated(async () => {
      const controller = new AbortController();
      let announceStart = () => {};
      const started = new Promise<void>((resolve) => {
        announceStart = resolve;
      });
      let callbackAborted = false;
      const captured = createSdk(async (client) => {
        await client.call(1, "lookup", { query: "first" });
      });
      const input = makeInput(async (_call, signal) => {
        announceStart();
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => {
              callbackAborted = true;
              reject(signal!.reason);
            },
            { once: true }
          );
        });
        return { content: "unused", success: true };
      });
      const pending = new AuthenticatedRuntime({
        sdk: captured.sdk,
      }).generateChat({ ...input, signal: controller.signal });
      void pending.catch(() => undefined);
      await started;
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(callbackAborted).toBe(true);
      expect(
        await readSubscriptionSession("claude", "atlas-session")
      ).toBeNull();
    });
  });

  test("rejects premature native completion while preserving completed callback evidence", async () => {
    await isolated(async () => {
      let announceStart = () => {};
      let release = () => {};
      let announceCompletion = () => {};
      const started = new Promise<void>((resolve) => {
        announceStart = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const completed = new Promise<void>((resolve) => {
        announceCompletion = resolve;
      });
      const history: ChatMessage[] = [];
      let acceptedSignal: AbortSignal | undefined;
      const input = makeInput(async (call, signal) => {
        acceptedSignal = signal;
        announceStart();
        await released;
        appendReceipt(history, call, "completed effect");
        announceCompletion();
        return { content: "completed effect", success: true };
      });
      const captured = createSdk(async (client) => {
        void client
          .call(1, "lookup", { query: "first" })
          .catch(() => undefined);
        await started;
      });
      await expect(
        new AuthenticatedRuntime({ sdk: captured.sdk }).generateChat(input)
      ).rejects.toThrow("completed before");
      expect(acceptedSignal?.aborted).toBe(true);
      release();
      await completed;
      expect(history.at(-1)?.content).toBe("completed effect");
      expect(
        await readSubscriptionSession("claude", "atlas-session")
      ).toBeNull();
    });
  });
  test("never executes a textual tool fence in structured mode", async () => {
    await isolated(async () => {
      let calls = 0;
      const text =
        '```atlas-tool-call\n{"name":"lookup","arguments":{"query":"ignored"}}\n```';
      const captured = createSdk(async () => text);
      const result = await new AuthenticatedRuntime({
        sdk: captured.sdk,
      }).generateChat(
        makeInput(async () => {
          calls++;
          return { content: "unused", success: true };
        })
      );
      expect(result.content).toBe(text);
      expect(result.toolCalls).toEqual([]);
      expect(calls).toBe(0);
    });
  });
});

class ManualInferenceClock implements ClaudeInferenceClock {
  private current = 0;
  private readonly timers = new Set<{ at: number; callback: () => void }>();
  now() {
    return this.current;
  }
  schedule(callback: () => void, milliseconds: number) {
    const timer = { at: this.current + milliseconds, callback };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  }
  advance(milliseconds: number) {
    const target = this.current + milliseconds;
    while (true) {
      const next = [...this.timers]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (!next) {
        break;
      }
      this.current = next.at;
      this.timers.delete(next);
      next.callback();
    }
    this.current = target;
  }
}

describe("Claude active inference deadline", () => {
  test("a long pending approval does not time out and overlapping host calls keep inference paused", async () => {
    await isolated(async () => {
      const clock = new ManualInferenceClock();
      const firstStarted = Promise.withResolvers<void>();
      const secondStarted = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      const releaseSecond = Promise.withResolvers<void>();
      const firstReplied = Promise.withResolvers<void>();
      const signals: AbortSignal[] = [];
      try {
        const captured = createSdk(async (client) => {
          const first = client
            .call(1, "lookup", { query: "first" })
            .then(() => firstReplied.resolve());
          const second = client.call(2, "lookup", { query: "second" });
          await Promise.all([first, second]);
          return "Approved tools completed.";
        });
        const input = makeInput(async (call, signal) => {
          signals.push(signal!);
          if (call.arguments.query === "first") {
            firstStarted.resolve();
            await releaseFirst.promise;
          } else {
            secondStarted.resolve();
            await releaseSecond.promise;
          }
          return { content: "approved", success: true };
        });
        const pending = new AuthenticatedRuntime({
          inferenceClock: clock,
          sdk: captured.sdk,
          turnTimeoutMs: 100,
        }).generateChat(input);
        void pending.catch(() => undefined);
        await Promise.all([firstStarted.promise, secondStarted.promise]);
        clock.advance(1000);
        expect(signals.every((signal) => !signal.aborted)).toBe(true);
        releaseFirst.resolve();
        await firstReplied.promise;
        clock.advance(1000);
        expect(signals.every((signal) => !signal.aborted)).toBe(true);
        releaseSecond.resolve();
        await expect(pending).resolves.toMatchObject({
          content: "Approved tools completed.",
        });
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
      }
    });
  });

  test("the remaining inference budget resumes after a tool result instead of resetting", async () => {
    await isolated(async () => {
      const clock = new ManualInferenceClock();
      const inferenceStarted = Promise.withResolvers<void>();
      const startTool = Promise.withResolvers<void>();
      const toolStarted = Promise.withResolvers<void>();
      const releaseTool = Promise.withResolvers<void>();
      const toolReplied = Promise.withResolvers<void>();
      let runtimeSignal: AbortSignal | undefined;
      try {
        const captured = createSdk(async (client, options) => {
          runtimeSignal = (options.abortController as AbortController).signal;
          inferenceStarted.resolve();
          await startTool.promise;
          await client.call(1, "lookup", { query: "approval" });
          toolReplied.resolve();
          await new Promise<void>(() => undefined);
        });
        const input = makeInput(async () => {
          toolStarted.resolve();
          await releaseTool.promise;
          return { content: "approved", success: true };
        });
        const pending = new AuthenticatedRuntime({
          inferenceClock: clock,
          sdk: captured.sdk,
          turnTimeoutMs: 100,
        }).generateChat(input);
        void pending.catch(() => undefined);
        await inferenceStarted.promise;
        clock.advance(40);
        startTool.resolve();
        await toolStarted.promise;
        clock.advance(1000);
        expect(runtimeSignal?.aborted).toBe(false);
        releaseTool.resolve();
        await toolReplied.promise;
        clock.advance(59);
        expect(runtimeSignal?.aborted).toBe(false);
        clock.advance(1);
        expect(runtimeSignal?.aborted).toBe(true);
        await expect(pending).rejects.toThrow("timed out");
        expect(
          await readSubscriptionSession("claude", "atlas-session")
        ).toBeNull();
      } finally {
        startTool.resolve();
        releaseTool.resolve();
      }
    });
  });

  test("an explicit caller deadline still cancels the host callback while inference is paused", async () => {
    await isolated(async () => {
      const clock = new ManualInferenceClock();
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      let hostAborted = false;
      try {
        const captured = createSdk(async (client) => {
          await client.call(1, "lookup", { query: "approval" });
        });
        const input = makeInput(async (_call, signal) => {
          started.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal!.addEventListener(
              "abort",
              () => {
                hostAborted = true;
                reject(signal!.reason);
              },
              { once: true }
            );
          });
          return { content: "unreachable", success: true };
        });
        const pending = new AuthenticatedRuntime({
          inferenceClock: clock,
          sdk: captured.sdk,
          turnTimeoutMs: 100,
        }).generateChat({ ...input, signal: controller.signal });
        void pending.catch(() => undefined);
        await started.promise;
        clock.schedule(
          () => controller.abort(new Error("caller total deadline")),
          1000
        );
        clock.advance(999);
        expect(hostAborted).toBe(false);
        clock.advance(1);
        await expect(pending).rejects.toThrow();
        expect(hostAborted).toBe(true);
        expect(
          await readSubscriptionSession("claude", "atlas-session")
        ).toBeNull();
      } finally {
        controller.abort();
      }
    });
  });
});
