import { describe, expect, test } from "bun:test";
import type {
  ChatCompletionResult,
  GenerateChatInput,
  ProviderClient,
} from "@atlas/core";
import { generateRelatedQuestions, parseRelatedQuestions } from "./chat";
import { createAgentHarness } from "./index";

function createMockProvider(
  responses: ChatCompletionResult[]
): ProviderClient & {
  generateTextCalls: () => number;
} {
  let chatIndex = 0;
  let textCalls = 0;

  return {
    generateChat(input: GenerateChatInput) {
      const response = responses[chatIndex++];
      if (!response) {
        throw new Error(`Unexpected provider call ${chatIndex}`);
      }
      return Promise.resolve(response);
    },
    generateText() {
      textCalls += 1;
      return Promise.resolve({
        content:
          '{"questions": ["Apa itu HNSW?", "Bagaimana memilih index database?", "Berapa biayanya?"]}',
      });
    },
    generateTextCalls: () => textCalls,
    name: "openai",
    streamChat(input: GenerateChatInput, handlers) {
      const response = responses[chatIndex++];
      if (!response) {
        throw new Error(`Unexpected provider call ${chatIndex}`);
      }
      if (response.content) {
        handlers.onChunk(response.content);
      }
      return Promise.resolve(response);
    },
  };
}

const longReply = "Detailed answer. ".repeat(30);

describe("parseRelatedQuestions", () => {
  test("parses a plain JSON payload", () => {
    expect(parseRelatedQuestions('{"questions": ["a?", "b?", "c?"]}')).toEqual([
      "a?",
      "b?",
      "c?",
    ]);
  });

  test("extracts JSON from surrounding prose", () => {
    expect(
      parseRelatedQuestions('Sure! {"questions": ["a?"]} hope that helps')
    ).toEqual(["a?"]);
  });

  test("caps at three questions and drops empty or oversized entries", () => {
    expect(
      parseRelatedQuestions(
        '{"questions": ["a?", "", "b?", "c?", "d?", "' + "x".repeat(130) + '"]}'
      )
    ).toEqual(["a?", "b?", "c?"]);
  });

  test("returns null for non-JSON or non-array payloads", () => {
    expect(parseRelatedQuestions("no json here")).toBeNull();
    expect(parseRelatedQuestions('{"questions": "not-an-array"}')).toBeNull();
    expect(parseRelatedQuestions('{"questions": []}')).toBeNull();
  });
});

describe("generateRelatedQuestions", () => {
  test("cancellation settles even when a provider ignores its abort signal", async () => {
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const provider = createMockProvider([]);
    provider.generateText = (input) => {
      providerSignal = input.signal;
      controller.abort();
      return new Promise(() => {});
    };
    expect(
      await generateRelatedQuestions(
        provider,
        "explain",
        longReply,
        controller.signal
      )
    ).toBeNull();
    expect(providerSignal?.aborted).toBe(true);
  });

  test("skips short replies", async () => {
    expect(await generateRelatedQuestions(undefined, "hi", "short")).toBeNull();
  });

  test("skips when no provider is configured", async () => {
    expect(
      await generateRelatedQuestions(undefined, "hi", longReply)
    ).toBeNull();
  });

  test("returns parsed questions from the provider", async () => {
    const provider = createMockProvider([]);
    expect(
      await generateRelatedQuestions(provider, "explain", longReply)
    ).toEqual([
      "Apa itu HNSW?",
      "Bagaimana memilih index database?",
      "Berapa biayanya?",
    ]);
  });

  test("returns null when the provider throws", async () => {
    const provider: ProviderClient = {
      generateChat: () => {
        throw new Error("unused");
      },
      generateText: () => Promise.reject(new Error("down")),
      name: "openai",
      streamChat: () => {
        throw new Error("unused");
      },
    };
    expect(
      await generateRelatedQuestions(provider, "explain", longReply)
    ).toBeNull();
  });
});

describe("chat session related questions", () => {
  test("a failed suggestion observer does not discard the completed reply", async () => {
    const provider = createMockProvider([
      {
        assistantMessage: { content: longReply, role: "assistant" },
        content: longReply,
        toolCalls: [],
      },
    ]);
    const session = createAgentHarness({ provider }).createChatSession();
    expect(
      await session.sendStream(
        { message: "Explain the result", relatedQuestions: true },
        {
          onChunk: () => {},
          onRelatedQuestions: () => {
            throw new Error("Stream disconnected");
          },
        }
      )
    ).toBe(longReply);
    expect(session.getHistory().at(-1)).toMatchObject({
      content: longReply,
      role: "assistant",
    });
  });

  test("emits and persists suggestions after a streamed reply", async () => {
    const provider = createMockProvider([
      {
        assistantMessage: { content: longReply, role: "assistant" },
        content: longReply,
        toolCalls: [],
      },
    ]);
    const harness = createAgentHarness({ provider });
    const session = harness.createChatSession({});

    const received: string[][] = [];
    const historyBefore: number = session.getHistory().length;

    await session.sendStream(
      { message: "explain vector databases", relatedQuestions: true },
      {
        onChunk: () => undefined,
        onRelatedQuestions: (questions) => {
          received.push(questions);
        },
      }
    );

    expect(received).toEqual([
      [
        "Apa itu HNSW?",
        "Bagaimana memilih index database?",
        "Berapa biayanya?",
      ],
    ]);
    expect(provider.generateTextCalls()).toBe(1);

    const history = session.getHistory();
    const assistant = history
      .slice(historyBefore)
      .find((message) => message.role === "assistant");
    expect(
      assistant && assistant.role === "assistant"
        ? assistant.relatedQuestions
        : undefined
    ).toEqual([
      "Apa itu HNSW?",
      "Bagaimana memilih index database?",
      "Berapa biayanya?",
    ]);
  });

  test("does not generate suggestions when not requested", async () => {
    const provider = createMockProvider([
      {
        assistantMessage: { content: longReply, role: "assistant" },
        content: longReply,
        toolCalls: [],
      },
    ]);
    const harness = createAgentHarness({ provider });
    const session = harness.createChatSession({});

    const received: string[][] = [];
    await session.sendStream(
      { message: "explain vector databases" },
      {
        onChunk: () => undefined,
        onRelatedQuestions: (questions) => {
          received.push(questions);
        },
      }
    );

    expect(received).toEqual([]);
    expect(provider.generateTextCalls()).toBe(0);
  });
});
