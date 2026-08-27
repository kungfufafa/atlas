import { describe, expect, test } from "bun:test";
import type {
  ChatCompletionResult,
  GenerateChatInput,
  ProviderClient,
} from "@atlas/core";
import { createAgentHarness } from "./index";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function createCapturingProvider(
  response: ChatCompletionResult
): ProviderClient & { lastInput?: GenerateChatInput } {
  const provider: ProviderClient & { lastInput?: GenerateChatInput } = {
    generateChat(input) {
      provider.lastInput = input;
      return Promise.resolve(response);
    },
    generateText() {
      return Promise.resolve({ content: "{}" });
    },
    name: "anthropic",
    streamChat(input, handlers) {
      provider.lastInput = input;
      handlers.onThinking?.("trace ");
      handlers.onChunk(response.content);
      return Promise.resolve(response);
    },
  };

  return provider;
}

describe("thinking provider options", () => {
  test("merges thinking with web search options", async () => {
    const provider = createCapturingProvider({
      assistantMessage: { content: "Answer", role: "assistant" },
      content: "Answer",
      toolCalls: [],
    });

    const harness = createAgentHarness({
      chatOptions: { thinking: { effort: "high", enabled: true } },
      provider,
    });
    const session = harness.createChatSession({
      enableToolLoop: false,
    });

    const events: string[] = [];
    await session.sendStream("hello", {
      onChunk: (delta) => events.push(`chunk:${delta}`),
      onThinking: (delta) => events.push(`thinking:${delta}`),
    });

    expect(provider.lastInput?.providerOptions).toEqual({
      thinking: { effort: "high", enabled: true },
    });
    expect(events).toEqual(["thinking:trace ", "chunk:Answer"]);
  });

  test("preserves thinking for image turns and later text turns", async () => {
    const provider = createCapturingProvider({
      assistantMessage: { content: "Seen", role: "assistant" },
      content: "Seen",
      toolCalls: [],
    });

    const harness = createAgentHarness({
      chatOptions: { thinking: { effort: "medium", enabled: true } },
      provider,
    });
    const session = harness.createChatSession({ enableToolLoop: false });

    await session.send({
      images: [{ data: TINY_PNG_BASE64, mediaType: "image/png" }],
      message: "describe",
    });

    expect(provider.lastInput?.providerOptions).toEqual({
      thinking: { effort: "medium", enabled: true },
    });

    await session.send("now reason about the previous image");

    expect(provider.lastInput?.providerOptions).toEqual({
      thinking: { effort: "medium", enabled: true },
    });
  });
});
