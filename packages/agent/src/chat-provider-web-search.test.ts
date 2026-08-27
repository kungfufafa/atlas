import { describe, expect, test } from "bun:test";
import {
  type ChatCompletionResult,
  type GenerateChatInput,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityConstraints,
  type ProviderClient,
  type ToolDefinition,
  webSearchTool,
} from "@atlas/core";
import { type ChatCapabilityPolicy, createAgentHarness } from "./index";

function createCapturingProvider(
  response: ChatCompletionResult,
  name: ProviderClient["name"] = "anthropic"
): ProviderClient & { lastInput?: GenerateChatInput } {
  const provider: ProviderClient & { lastInput?: GenerateChatInput } = {
    generateChat(input) {
      provider.lastInput = input;
      return Promise.resolve(response);
    },
    generateText() {
      return Promise.resolve({ content: "{}" });
    },
    name,
    streamChat(input, handlers) {
      provider.lastInput = input;
      if (response.content) {
        handlers.onChunk(response.content);
      }
      return Promise.resolve(response);
    },
  };

  return provider;
}

function policy(options?: {
  nativeSearch?: "supported" | "unknown" | "unsupported";
  nativeSearchConstraints?: ProviderCapabilityConstraints;
}): ChatCapabilityPolicy {
  const supported = { selectable: true, status: "supported" } as const;
  const nativeSearchStatus = options?.nativeSearch ?? "supported";
  return {
    capabilities: {
      [PROVIDER_CAPABILITY_IDS.chatCompletion]: supported,
      [PROVIDER_CAPABILITY_IDS.chatNativeWebSearch]: {
        ...(options?.nativeSearchConstraints
          ? { constraints: options.nativeSearchConstraints }
          : {}),
        selectable: nativeSearchStatus === "supported",
        status: nativeSearchStatus,
      },
      [PROVIDER_CAPABILITY_IDS.chatStreaming]: supported,
      [PROVIDER_CAPABILITY_IDS.chatToolUse]: supported,
    },
  };
}

describe("provider-native web search", () => {
  test("passes webSearch provider option when web_search is assigned", async () => {
    const provider = createCapturingProvider({
      assistantMessage: {
        content: "Latest news summary.",
        role: "assistant",
      },
      content: "Latest news summary.",
      toolCalls: [],
    });

    const harness = createAgentHarness({
      chatCapabilityPolicy: policy(),
      provider,
      tools: [webSearchTool],
    });
    const session = harness.createChatSession({ tools: [webSearchTool] });
    const reply = await session.send("What's new in AI?");

    expect(reply).toBe("Latest news summary.");
    expect(provider.lastInput?.providerOptions).toEqual({ webSearch: true });
    expect(provider.lastInput?.tools).toBeUndefined();
  });

  test("keeps local tools while enabling provider web search", async () => {
    const localTool: ToolDefinition = {
      description: "Sample tool",
      name: "sample",
      run(input) {
        return Promise.resolve(input);
      },
    };

    const provider = createCapturingProvider({
      assistantMessage: {
        content: "Done",
        role: "assistant",
      },
      content: "Done",
      toolCalls: [],
    });

    const harness = createAgentHarness({
      chatCapabilityPolicy: policy(),
      provider,
      tools: [localTool, webSearchTool],
    });
    const session = harness.createChatSession({
      tools: [localTool, webSearchTool],
    });
    await session.send("hello");

    expect(provider.lastInput?.providerOptions).toEqual({ webSearch: true });
    expect(provider.lastInput?.tools?.map((tool) => tool.name)).toEqual([
      "sample",
    ]);
  });

  test("uses capability evidence rather than the provider name", async () => {
    const provider = createCapturingProvider(
      {
        assistantMessage: {
          content: "Latest news summary.",
          role: "assistant",
        },
        content: "Latest news summary.",
        toolCalls: [],
      },
      "openrouter"
    );

    const harness = createAgentHarness({
      chatCapabilityPolicy: policy(),
      provider,
      tools: [webSearchTool],
    });
    const session = harness.createChatSession({ tools: [webSearchTool] });
    await session.send("What's new in AI?");

    expect(provider.lastInput?.providerOptions).toEqual({ webSearch: true });
    expect(provider.lastInput?.tools).toBeUndefined();
  });

  test("falls back to local search when request constraints reject native search", async () => {
    const localTool: ToolDefinition = {
      description: "Sample tool",
      name: "sample",
      run(input) {
        return Promise.resolve(input);
      },
    };

    const provider = createCapturingProvider({
      assistantMessage: {
        content: "Done",
        role: "assistant",
      },
      content: "Done",
      toolCalls: [],
    });

    const harness = createAgentHarness({
      chatCapabilityPolicy: policy({
        nativeSearchConstraints: {
          supportedValues: { "request.local-tools": [false] },
        },
      }),
      provider,
      tools: [localTool, webSearchTool],
    });
    const session = harness.createChatSession({
      tools: [localTool, webSearchTool],
    });
    await session.send("hello");

    expect(provider.lastInput?.providerOptions).toBeUndefined();
    expect(provider.lastInput?.tools?.map((tool) => tool.name)).toEqual([
      "sample",
      "web_search",
    ]);
  });

  test("falls back to local search when native support is unknown", async () => {
    const provider = createCapturingProvider({
      assistantMessage: { content: "Searched locally", role: "assistant" },
      content: "Searched locally",
      toolCalls: [],
    });
    const harness = createAgentHarness({
      chatCapabilityPolicy: policy({ nativeSearch: "unknown" }),
      provider,
      tools: [webSearchTool],
    });

    await harness
      .createChatSession({ tools: [webSearchTool] })
      .send("Search safely");

    expect(provider.lastInput?.providerOptions).toBeUndefined();
    expect(provider.lastInput?.tools?.map((tool) => tool.name)).toEqual([
      "web_search",
    ]);
  });

  test("preserves local search when native support is unsupported", async () => {
    const provider = createCapturingProvider({
      assistantMessage: { content: "Searched locally", role: "assistant" },
      content: "Searched locally",
      toolCalls: [],
    });
    const harness = createAgentHarness({
      chatCapabilityPolicy: policy({ nativeSearch: "unsupported" }),
      provider,
      tools: [webSearchTool],
    });

    await harness
      .createChatSession({ tools: [webSearchTool] })
      .send("Search safely");

    expect(provider.lastInput?.providerOptions).toBeUndefined();
    expect(provider.lastInput?.tools?.map((tool) => tool.name)).toEqual([
      "web_search",
    ]);
  });
});
