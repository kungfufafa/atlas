import { describe, expect, test } from "bun:test";
import type {
  ChatCompletionResult,
  ChatMessage,
  GenerateChatInput,
  ProviderClient,
  ToolDefinition,
} from "@atlas/core";
import { PROVIDER_CAPABILITY_IDS } from "@atlas/core";
import { createAgentHarness } from "./index";

const nativeContext = { contextWindow: 258_400, usedTokens: 12_040 };
const fallbackCompaction = {
  contextWindow: 128_000,
  maxOutputTokens: 8192,
};

function completion(
  contextUsage?: ChatCompletionResult["contextUsage"]
): ChatCompletionResult {
  return {
    assistantMessage: { content: "Hello", role: "assistant" },
    content: "Hello",
    contextUsage,
    toolCalls: [],
    usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 },
  };
}

function nativeProvider(responses: Array<ChatCompletionResult | Error>): {
  provider: ProviderClient;
  requests: GenerateChatInput[];
} {
  const requests: GenerateChatInput[] = [];
  const take = (input: GenerateChatInput): ChatCompletionResult => {
    requests.push({ ...input, messages: [...input.messages] });
    const result = responses.shift();
    if (!result) {
      throw new Error("Unexpected provider call");
    }
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  return {
    provider: {
      async generateChat(input) {
        return take(input);
      },
      async generateText() {
        return { content: "unused" };
      },
      managesContext: true,
      name: "chatgpt",
      async streamChat(input, handlers) {
        const result = take(input);
        handlers.onChunk(result.content);
        return result;
      },
    },
    requests,
  };
}

const sampleTool: ToolDefinition = {
  description: "Read sample data",
  name: "sample",
  parameters: { properties: {}, type: "object" },
  async run() {
    return { data: "sample" };
  },
};

function toolCompletion(): ChatCompletionResult {
  const toolCalls = [{ arguments: {}, id: "call_1", name: "sample" }];
  return {
    ...completion(nativeContext),
    assistantMessage: { content: "", role: "assistant", toolCalls },
    content: "",
    toolCalls,
  };
}

function initialHistory(): ChatMessage[] {
  return Array.from({ length: 4 }, (_, index): ChatMessage[] => [
    { content: `turn ${index}`, role: "user" },
    {
      content: "a".repeat(4000),
      name: "sample",
      role: "tool",
      toolCallId: `call_${index}`,
    },
    { content: `reply ${index}`, role: "assistant" },
  ]).flat();
}

describe("provider-managed chat context", () => {
  test.each(["send", "stream"] as const)(
    "%s uses the native window and occupancy without subtracting output twice",
    async (mode) => {
      const { provider } = nativeProvider([completion(nativeContext)]);
      const session = createAgentHarness({ provider }).createChatSession({
        compaction: fallbackCompaction,
        enableToolLoop: false,
      });

      expect(session.getContextUsage()).toBeNull();
      if (mode === "send") {
        await session.send("hi");
      } else {
        await session.sendStream("hi", { onChunk: () => {} });
      }

      expect(session.getContextUsage()).toEqual({
        ...nativeContext,
        source: "provider",
        usableContextTokens: nativeContext.contextWindow,
      });
    }
  );

  test("reports native context without Atlas compaction configured", async () => {
    const { provider } = nativeProvider([completion(nativeContext)]);
    const session = createAgentHarness({ provider }).createChatSession({});

    await session.send("hi");

    expect(session.getContextUsage()).toMatchObject({
      ...nativeContext,
      source: "provider",
    });
  });

  test.each([true, false])(
    "manual compaction works without a guessed window (native=%s)",
    async (managesContext) => {
      const { provider, requests } = nativeProvider([completion()]);
      provider.managesContext = managesContext;
      const history = initialHistory();
      const session = createAgentHarness({ provider }).createChatSession({
        initialHistory: history,
      });
      expect(session.getContextUsage()).toBeNull();
      expect(await session.compact()).toMatchObject({ action: "none" });
      expect(requests).toHaveLength(0);
      expect(session.getHistory()).toEqual(history);
      expect(await session.compact({ force: true })).toMatchObject({
        action: "summarized",
      });
      expect(requests).toHaveLength(1);
      expect(session.getContextUsage()).toBeNull();
      expect(session.getHistory()[0]).toMatchObject({ summary: true });
    }
  );

  test("does not mistake billable usage or local history for native context", async () => {
    const { provider } = nativeProvider([completion()]);
    const session = createAgentHarness({ provider }).createChatSession({
      compaction: fallbackCompaction,
      initialHistory: [{ content: "old turn", role: "user" }],
    });

    expect(session.getContextUsage()).toBeNull();
    await session.send("hi");
    expect(session.getContextUsage()).toBeNull();
  });

  test("preserves native context management through capability policy enforcement", async () => {
    const { provider, requests } = nativeProvider([completion(nativeContext)]);
    const history = initialHistory();
    const session = createAgentHarness({
      chatCapabilityPolicy: {
        capabilities: {
          [PROVIDER_CAPABILITY_IDS.chatCompletion]: {
            selectable: true,
            status: "supported",
          },
        },
      },
      provider,
    }).createChatSession({
      compaction: { contextWindow: 200, maxOutputTokens: 0 },
      initialHistory: history,
    });

    expect(session.getContextUsage()).toBeNull();
    await session.send("continue");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.slice(0, history.length)).toEqual(history);
    expect(session.getHistory().slice(0, history.length)).toEqual(history);
    expect(session.getContextUsage()).toMatchObject(nativeContext);
    expect(await session.compact()).toMatchObject({ action: "none" });
  });

  test("explicit compaction invalidates native context until the next runtime turn", async () => {
    const compactedContext = { ...nativeContext, usedTokens: 1000 };
    const { provider } = nativeProvider([
      completion(nativeContext),
      completion(),
      completion(compactedContext),
    ]);
    const session = createAgentHarness({ provider }).createChatSession({
      compaction: fallbackCompaction,
      initialHistory: initialHistory(),
    });

    await session.send("continue");
    expect(session.getContextUsage()?.usedTokens).toBe(
      nativeContext.usedTokens
    );

    expect(await session.compact({ force: true })).toMatchObject({
      action: "summarized",
    });
    expect(session.getContextUsage()).toBeNull();
    expect(session.getHistory()[0]).toMatchObject({ summary: true });

    await session.send("continue again");
    expect(session.getContextUsage()?.usedTokens).toBe(1000);
  });

  test("uses the latest runtime snapshot across tool iterations, including native compaction", async () => {
    const compactedContext = { ...nativeContext, usedTokens: 2000 };
    const { provider, requests } = nativeProvider([
      toolCompletion(),
      completion(compactedContext),
    ]);
    const session = createAgentHarness({ provider }).createChatSession({
      compaction: fallbackCompaction,
      tools: [sampleTool],
    });

    await session.sendStream("read the sample", { onChunk: () => {} });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool" });
    expect(session.getContextUsage()).toMatchObject(compactedContext);
  });

  test("invalidates a previous native snapshot when a later turn omits context metadata", async () => {
    const { provider } = nativeProvider([
      completion(nativeContext),
      completion(),
    ]);
    const session = createAgentHarness({ provider }).createChatSession({
      compaction: fallbackCompaction,
    });

    await session.send("first");
    await session.send("second");

    expect(session.getContextUsage()).toBeNull();
  });

  test("invalidates native context while retaining a failed turn's completed tool evidence", async () => {
    const { provider } = nativeProvider([
      toolCompletion(),
      new Error("runtime unavailable"),
    ]);
    const session = createAgentHarness({ provider }).createChatSession({
      compaction: fallbackCompaction,
      tools: [sampleTool],
    });

    await expect(session.send("read the sample")).rejects.toThrow();

    expect(session.getHistory().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(session.getContextUsage()).toBeNull();
  });
});
