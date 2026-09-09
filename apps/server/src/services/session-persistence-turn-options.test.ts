import { expect, test } from "bun:test";
import {
  type AgentChatSession,
  createAgentHarness,
  type ToolExecutionLifecycle,
} from "@atlas/agent";
import type { GenerateChatInput, ProviderClient } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { wrapPersistedSession } from "./session-persistence";

for (const native of [false, true]) {
  for (const streaming of [false, true]) {
    test(`${native ? "native" : "API"} ${streaming ? "stream" : "send"} preserves host turn options across deferred persistence execution`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const db = createInMemoryDatabaseAdapter();
      let effects = 0;
      let requests = 0;
      let originalCheckpoints = 0;
      let replacedCheckpoints = 0;
      const begun: string[] = [];
      const completed: string[] = [];
      const lifecycle = (name: string): ToolExecutionLifecycle => ({
        begin() {
          begun.push(name);
          return {
            async complete() {
              completed.push(name);
            },
          };
        },
      });
      const call = { arguments: {}, id: "effect-call", name: "effect" };
      const generate = async (input: GenerateChatInput) => {
        requests += 1;
        if (native) {
          await input.executeToolCall!(call);
        }
        const toolCalls = native || requests % 2 === 0 ? [] : [call];
        return {
          assistantMessage: {
            content: "Fixture finished.",
            role: "assistant" as const,
            toolCalls,
          },
          content: "Fixture finished.",
          toolCalls,
        };
      };
      const provider: ProviderClient = {
        generateChat: generate,
        async generateText() {
          return { content: "unused" };
        },
        name: "openai_compatible",
        async streamChat(input, handlers) {
          const reply = await generate(input);
          handlers.onChunk(reply.content);
          return reply;
        },
      };
      const inner = createAgentHarness({
        provider,
        tools: [
          {
            description: "Record a fixture effect",
            name: "effect",
            parameters: { properties: {}, type: "object" },
            async run() {
              effects += 1;
              return { effects };
            },
          },
        ],
      }).createChatSession({
        toolContext: {
          orgId: "org",
          profileId: "profile",
          sessionId: "session",
          userId: "human",
        },
      });
      const session = wrapPersistedSession("session", inner, db, {
        async runTurn(_id, operation) {
          entered.resolve();
          await release.promise;
          return operation();
        },
      });
      const options: NonNullable<Parameters<AgentChatSession["send"]>[1]> = {
        async onToolCheckpoint() {
          originalCheckpoints += 1;
        },
        async toolExecutionGuard() {
          throw new Error("Original admission denies the effect");
        },
        toolExecutionLifecycle: lifecycle("original"),
      };
      const pending = streaming
        ? session.sendStream("Run the fixture", { onChunk() {} }, options)
        : session.send("Run the fixture", options);
      await entered.promise;
      options.toolExecutionGuard = async () => {};
      options.toolExecutionLifecycle = lifecycle("replaced");
      options.onToolCheckpoint = async () => {
        replacedCheckpoints += 1;
      };
      release.resolve();
      await pending;
      expect(effects).toBe(0);
      expect(begun).toEqual(["original"]);
      expect(completed).toEqual(["original"]);
      expect(originalCheckpoints).toBeGreaterThan(0);
      expect(replacedCheckpoints).toBe(0);
      expect(
        (await db.listMessagesForSession("session")).length
      ).toBeGreaterThan(0);
      if (streaming) {
        await session.sendStream("Next fixture", { onChunk() {} });
      } else {
        await session.send("Next fixture");
      }
      expect(effects).toBe(1);
      expect(begun).toEqual(["original"]);
    });
  }
}
