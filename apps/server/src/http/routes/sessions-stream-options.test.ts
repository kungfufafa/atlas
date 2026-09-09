import { expect, test } from "bun:test";
import { type AgentChatSession, createAgentHarness } from "@atlas/agent";
import type { ProviderClient } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { wrapPersistedSession } from "../../services/session-persistence";
import { sessionTurnRegistry } from "../../services/session-turn-registry";
import { streamMessage } from "../shared";

type SendStreamOptions = NonNullable<Parameters<AgentChatSession["send"]>[1]>;

for (const inherited of [false, true]) {
  test(`HTTP stream preserves ${inherited ? "inherited" : "own"} checkpoint receiver and captured host options while persistence defers`, async () => {
    const db = createInMemoryDatabaseAdapter();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const id = crypto.randomUUID();
    let requests = 0;
    let effects = 0;
    let originalCheckpoints = 0;
    let replacementCheckpoints = 0;
    let originalGuards = 0;
    let inheritedLifecycleBegins = 0;
    const provider: ProviderClient = {
      name: "openai_compatible",
      async generateChat() {
        throw new Error("Stream only fixture");
      },
      async generateText() {
        throw new Error("No provider text calls");
      },
      async streamChat(_input, handlers) {
        requests += 1;
        const toolCalls =
          requests === 1
            ? [{ arguments: {}, id: "effect-call", name: "effect" }]
            : [];
        handlers.onChunk("Fixture");
        return {
          content: "Fixture",
          assistantMessage: {
            role: "assistant",
            content: "Fixture",
            toolCalls,
          },
          toolCalls,
        };
      },
    };
    const inner = createAgentHarness({
      provider,
      tools: [
        {
          name: "effect",
          description: "Fixture",
          parameters: { type: "object", properties: {} },
          async run() {
            effects += 1;
            return { effects };
          },
        },
      ],
    }).createChatSession({
      toolExecutionLifecycle: {
        begin() {
          inheritedLifecycleBegins += 1;
          return { async complete() {} };
        },
      },
      toolContext: {
        userId: "owner",
        orgId: "org",
        profileId: "profile",
        sessionId: id,
      },
    });
    const persisted = wrapPersistedSession(id, inner, db, {
      async runTurn(_turn, operation) {
        entered.resolve();
        await release.promise;
        return operation();
      },
    });
    const checkpoint = async function (this: SendStreamOptions) {
      expect(this).toBe(options);
      expect(
        (await db.listMessagesForSession(id)).some(
          (message) => (message.payload as { role?: string }).role === "tool"
        )
      ).toBe(true);
      originalCheckpoints += 1;
    };
    const options: SendStreamOptions = inherited
      ? Object.create({ onToolCheckpoint: checkpoint })
      : { onToolCheckpoint: checkpoint };
    options.toolExecutionGuard = async () => {
      originalGuards += 1;
      throw new Error("Host denies fixture effect");
    };
    options.toolExecutionLifecycle = null;
    const requestAbort = new AbortController();
    const ignoredHostSignal = AbortSignal.abort();
    options.signal = ignoredHostSignal;
    sessionTurnRegistry.beginTurn(id);
    const response = streamMessage(
      id,
      persisted,
      { message: "Run fixture" },
      undefined,
      requestAbort.signal,
      1000,
      0,
      options
    );
    await entered.promise;
    options.onToolCheckpoint = async () => {
      replacementCheckpoints += 1;
    };
    options.toolExecutionGuard = async () => {};
    options.toolExecutionLifecycle = undefined;
    release.resolve();
    await response.text();
    expect(originalGuards).toBe(1);
    expect(effects).toBe(0);
    expect(inheritedLifecycleBegins).toBe(0);
    expect(originalCheckpoints).toBeGreaterThan(0);
    expect(replacementCheckpoints).toBe(0);
    expect(sessionTurnRegistry.isActive(id)).toBe(false);
  });
}
