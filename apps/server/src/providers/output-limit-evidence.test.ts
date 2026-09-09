import { afterEach, expect, test } from "bun:test";
import {
  type GenerateChatInput,
  IncompleteCompletionError,
  type ProviderClient,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { LlmUsageTracker } from "../services/llm-usage-tracker";
import { createCerebrasProvider } from "./cerebras";
import { createFireworksProvider } from "./fireworks";
import { createOpenAIProvider } from "./openai";
import { createOpenAICompatibleProvider } from "./openai-compatible";
import { createOpenRouterProvider } from "./openrouter";
import { wrapProviderWithUsageTracking } from "./usage-tracking";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const input: GenerateChatInput = {
  messages: [{ content: "Write", role: "user" }],
  system: "Use tools",
};
const wireUsage = {
  completion_tokens: 19,
  completion_tokens_details: { reasoning_tokens: 17 },
  prompt_tokens: 13,
  total_tokens: 32,
};
const expectedUsage = { inputTokens: 13, outputTokens: 19, totalTokens: 32 };
const adapters: { name: string; create: () => ProviderClient }[] = [
  {
    create: () => createOpenAIProvider({ apiKey: "fixture", model: "fixture" }),
    name: "OpenAI",
  },
  {
    create: () =>
      createOpenAICompatibleProvider({
        apiKey: "fixture",
        baseUrl: "https://provider.invalid/v1",
        displayName: "Fixture",
        model: "fixture",
        supportsThinking: false,
      }),
    name: "Compatible",
  },
  {
    create: () =>
      createCerebrasProvider({ apiKey: "fixture", model: "fixture" }),
    name: "Cerebras",
  },
  {
    create: () =>
      createFireworksProvider({ apiKey: "fixture", model: "fixture" }),
    name: "Fireworks",
  },
  {
    create: () =>
      createOpenRouterProvider({
        apiKey: "fixture",
        fetcher: globalThis.fetch,
        model: "fixture",
      }),
    name: "OpenRouter",
  },
];
function jsonCompletion(finish = "length", usage: unknown = wireUsage) {
  return {
    choices: [
      {
        finish_reason: finish,
        index: 0,
        message: {
          content: "partial",
          reasoning: "diagnostic reasoning",
          reasoning_content: "diagnostic reasoning",
          role: "assistant",
          tool_calls: [
            {
              function: { arguments: '{"value":', name: "write" },
              id: "partial-tool",
              type: "function",
            },
          ],
        },
      },
    ],
    created: 1,
    id: "completion",
    model: "fixture",
    object: "chat.completion",
    system_fingerprint: null,
    usage,
  };
}
function event(delta: unknown, finish: string | null = null, usage?: unknown) {
  return {
    choices: [{ delta, finish_reason: finish, index: 0 }],
    created: 1,
    id: "completion",
    model: "fixture",
    object: "chat.completion.chunk",
    ...(usage ? { usage } : {}),
  };
}
function stream(events: unknown[]) {
  return new Response(
    events
      .map(
        (value) =>
          `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
}
async function failureOf(
  request: Promise<unknown>
): Promise<IncompleteCompletionError> {
  let failure: unknown;
  try {
    await request;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(IncompleteCompletionError);
  if (!(failure instanceof IncompleteCompletionError)) {
    throw new Error("Expected typed incomplete completion");
  }
  return failure;
}
for (const adapter of adapters) {
  test(`${adapter.name} JSON truncation retains raw malformed arguments and total usage including reasoning`, async () => {
    globalThis.fetch = (async () =>
      Response.json(jsonCompletion())) as unknown as typeof fetch;
    const error = await failureOf(adapter.create().generateChat(input));
    expect(error.evidence).toEqual({
      content: "partial",
      thinking: "diagnostic reasoning",
      toolInputFragments: [
        { arguments: '{"value":', id: "partial-tool", name: "write" },
      ],
      usage: expectedUsage,
    });
    expect(error.reason).toBe("output_limit");
    expect(error.finishReason).toBe("length");
  });
  test(`${adapter.name} stream retains terminal deltas and trailing usage without parsing incomplete arguments`, async () => {
    globalThis.fetch = (async () =>
      stream([
        event({
          tool_calls: [
            {
              function: { arguments: '{"value":', name: "write" },
              id: "partial-tool",
              index: 0,
              type: "function",
            },
          ],
        }),
        event(
          {
            content: "partial",
            reasoning: "diagnostic reasoning",
            reasoning_content: "diagnostic reasoning",
          },
          "length",
          { completion_tokens: 18, prompt_tokens: 13, total_tokens: 31 }
        ),
        {
          choices: [],
          created: 1,
          id: "completion",
          model: "fixture",
          object: "chat.completion.chunk",
          usage: wireUsage,
        },
        "[DONE]",
      ])) as unknown as typeof fetch;
    const emitted: string[] = [];
    const error = await failureOf(
      adapter
        .create()
        .streamChat(input, { onChunk: (delta) => emitted.push(delta) })
    );
    expect(error.evidence).toEqual({
      content: "partial",
      thinking: "diagnostic reasoning",
      toolInputFragments: [
        { arguments: '{"value":', id: "partial-tool", name: "write" },
      ],
      usage: expectedUsage,
    });
    expect(emitted).toEqual(["partial"]);
  });
  test(`${adapter.name} generateText retains failure usage without retrying`, async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return Response.json(jsonCompletion());
    }) as unknown as typeof fetch;
    const tracker = await LlmUsageTracker.create(
      createInMemoryDatabaseAdapter()
    );
    const provider = wrapProviderWithUsageTracking(
      adapter.create(),
      tracker,
      "fixture"
    );
    const error = await failureOf(
      provider.generateText({
        format: "text",
        prompt: "Question",
        system: "Answer",
      })
    );
    expect(error.evidence.usage).toEqual(expectedUsage);
    expect(requests).toBe(1);
    expect(tracker.getStats()).toMatchObject({
      inputTokens: 13,
      outputTokens: 19,
      requestCount: 1,
    });
  });
}

test.each(["generateChat", "streamChat"] as const)(
  "%s usage wrapper charges failed and successful requests exactly once, preserving error identity and native context flag",
  async (method) => {
    const error = new IncompleteCompletionError("Fixture", {
      content: "",
      toolInputFragments: [],
      usage: expectedUsage,
    });
    let requests = 0;
    const run = async () => {
      if (++requests === 1) {
        throw error;
      }
      return {
        assistantMessage: { content: "done", role: "assistant" as const },
        content: "done",
        toolCalls: [],
        usage: expectedUsage,
      };
    };
    const tracker = await LlmUsageTracker.create(
      createInMemoryDatabaseAdapter()
    );
    const provider = wrapProviderWithUsageTracking(
      {
        generateChat: run,
        async generateText() {
          return { content: "unused" };
        },
        managesContext: true,
        name: "openai_compatible",
        streamChat: run,
      },
      tracker,
      "fixture"
    );
    const request = () =>
      method === "generateChat"
        ? provider.generateChat(input)
        : provider.streamChat(input, { onChunk: () => {} });
    await expect(request()).rejects.toBe(error);
    await request();
    expect(provider.managesContext).toBe(true);
    expect(tracker.getStats()).toMatchObject({
      inputTokens: 26,
      outputTokens: 38,
      requestCount: 2,
    });
  }
);

test("missing failure usage stays unknown rather than a fabricated zero or partial text estimate", async () => {
  const tracker = await LlmUsageTracker.create(createInMemoryDatabaseAdapter());
  globalThis.fetch = (async () =>
    Response.json(jsonCompletion("length", null))) as unknown as typeof fetch;
  const provider = wrapProviderWithUsageTracking(
    adapters[1]!.create(),
    tracker,
    "fixture"
  );
  const error = await failureOf(provider.generateChat(input));
  expect(error.evidence.usage).toBeUndefined();
  expect(tracker.getStats().requestCount).toBe(1);
  expect(tracker.getStats().provenance?.unknownInvocations).toBe(1);
});

test("SSE transport failure following length is not converted into a recoverable output limit", async () => {
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("transport interrupted"));
        },
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(event({}, "length", wireUsage))}\n\n`
            )
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    )) as unknown as typeof fetch;
  let failure: unknown;
  try {
    await adapters[1]!.create().streamChat(input, { onChunk: () => {} });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toBeInstanceOf(IncompleteCompletionError);
  if (failure instanceof IncompleteCompletionError) {
    expect(failure.recoveryAllowed).toBe(false);
    expect(failure.evidence.usage).toEqual(expectedUsage);
    expect(failure.cause).toBeInstanceOf(Error);
  }
});
