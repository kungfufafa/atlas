import { describe, expect, test } from "bun:test";
import type {
  ChatCompletionResult,
  ChatMessage,
  GenerateChatInput,
  ProviderClient,
} from "@atlas/core";
import { createAgentHarness } from "./index";

function completion(content: string): ChatCompletionResult {
  return {
    assistantMessage: { content, role: "assistant" },
    content,
    toolCalls: [],
  };
}

describe("failed turn history rollback", () => {
  test("restores exact pre-turn history after compaction and prompt setup failure", async () => {
    const initialHistory: ChatMessage[] = Array.from(
      { length: 4 },
      (_, index) => [
        { content: `user-${index}-${"u".repeat(300)}`, role: "user" as const },
        {
          content: `assistant-${index}-${"a".repeat(300)}`,
          role: "assistant" as const,
        },
      ]
    ).flat();
    let providerCalls = 0;
    const provider: ProviderClient = {
      async generateChat(_input: GenerateChatInput) {
        providerCalls += 1;
        return completion("compacted summary");
      },
      generateText: () => Promise.resolve({ content: "{}" }),
      name: "openai",
      streamChat: () => {
        throw new Error("main provider call must not start");
      },
    };
    const harness = createAgentHarness({ provider, tools: [] });
    const session = harness.createChatSession({
      compaction: { contextWindow: 200, maxOutputTokens: 0 },
      initialHistory,
      preprocessUserContent: async () => [
        {
          attachmentId: "att_failed_turn",
          filename: "report.pdf",
          mediaType: "application/pdf",
          size: 3,
          type: "document_ref" as const,
        },
      ],
      resolvePromptContext: async () => {
        throw new Error("prompt context unavailable");
      },
    });
    const revisionBefore = session.getHistoryRevision();

    await expect(session.send("summarize attachment")).rejects.toThrow(
      "prompt context unavailable"
    );

    expect(session.getHistory()).toEqual(initialHistory);
    expect(session.getHistoryRevision()).toBe(revisionBefore + 1);
    expect(providerCalls).toBe(1);
  });
});
