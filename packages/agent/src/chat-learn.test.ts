import { describe, expect, test } from "bun:test";
import type {
  ChatCompletionResult,
  GenerateChatInput,
  ProviderClient,
} from "@atlas/core";
import { createAgentHarness } from "./index";
import { expandLearnInLastUserMessage } from "./learn-prompt";

function capturingProvider(
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
      handlers.onChunk(response.content);
      return Promise.resolve(response);
    },
  };
  return provider;
}

describe("/learn chat history", () => {
  test("sends an expanded provider copy while persisting the short command", async () => {
    const provider = capturingProvider({
      assistantMessage: { content: "Saved.", role: "assistant" },
      content: "Saved.",
      toolCalls: [],
    });
    const session = createAgentHarness({ provider }).createChatSession({
      rehydrateMessagesForProvider: async (messages) =>
        expandLearnInLastUserMessage(messages),
    });
    await session.send("/learn filing an expense");

    expect(session.getHistory()[0]?.content).toBe("/learn filing an expense");
    const sent = provider.lastInput?.messages.find(
      (message) => message.role === "user"
    );
    expect(typeof sent?.content === "string" ? sent.content : "").toContain(
      "[/learn]"
    );
  });
});
