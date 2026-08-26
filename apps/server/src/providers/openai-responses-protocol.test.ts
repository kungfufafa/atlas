import { afterEach, describe, expect, mock, test } from "bun:test";
import { generateOpenAIResponsesChat } from "./openai";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const INPUT = {
  messages: [{ content: "hi", role: "user" as const }],
  system: "system",
};

function messageOutput(text: string) {
  return {
    content: [{ text, type: "output_text" }],
    id: "msg_1",
    role: "assistant",
    type: "message",
  };
}

function stubJson(payload: unknown): void {
  globalThis.fetch = mock(async () =>
    Response.json(payload)
  ) as unknown as typeof fetch;
}

function stubSse(events: Array<Record<string, unknown> | "[DONE]">): void {
  const data = events
    .map((event) =>
      event === "[DONE]"
        ? "data: [DONE]\n\n"
        : `data: ${JSON.stringify(event)}\n\n`
    )
    .join("");
  globalThis.fetch = mock(
    async () =>
      new Response(data, {
        headers: { "Content-Type": "text/event-stream" },
      })
  ) as unknown as typeof fetch;
}

function generate(
  stream: boolean,
  handlers?: Parameters<typeof generateOpenAIResponsesChat>[0]["handlers"]
) {
  return generateOpenAIResponsesChat({
    apiKey: "test-key",
    handlers,
    input: INPUT,
    model: "gpt-test",
    stream,
  });
}

describe("OpenAI Responses terminal integrity", () => {
  test("rejects a failed non-stream response even when it contains partial output", async () => {
    stubJson({
      error: { message: "reasoning failed" },
      output: [messageOutput("partial")],
      status: "failed",
    });

    await expect(generate(false)).rejects.toThrow("reasoning failed");
  });

  test("rejects a failed stream after partial text", async () => {
    stubSse([
      { delta: "partial", type: "response.output_text.delta" },
      {
        response: {
          error: { message: "stream failed" },
          status: "failed",
        },
        type: "response.failed",
      },
    ]);

    await expect(generate(true, { onChunk: () => undefined })).rejects.toThrow(
      "stream failed"
    );
  });

  test("rejects an abrupt EOF without a successful terminal", async () => {
    stubSse([
      { delta: "partial", type: "response.output_text.delta" },
      { item: messageOutput("partial"), type: "response.output_item.done" },
    ]);

    await expect(generate(true, { onChunk: () => undefined })).rejects.toThrow(
      "before response.completed"
    );
  });

  test("prefers authoritative completed output over partial deltas", async () => {
    stubSse([
      { delta: "partial", type: "response.output_text.delta" },
      {
        response: {
          output: [messageOutput("complete answer")],
          status: "completed",
        },
        type: "response.completed",
      },
    ]);

    const result = await generate(true, { onChunk: () => undefined });

    expect(result.content).toBe("complete answer");
  });

  test("uses streamed text with an explicit DONE sentinel when no final message exists", async () => {
    stubSse([
      { delta: "proxy answer", type: "response.output_text.delta" },
      "[DONE]",
    ]);

    const result = await generate(true, { onChunk: () => undefined });

    expect(result.content).toBe("proxy answer");
  });
});

describe("OpenAI Responses refusals and tool events", () => {
  test("surfaces non-stream refusal content", async () => {
    stubJson({
      output: [
        {
          content: [{ refusal: "I cannot help with that.", type: "refusal" }],
          role: "assistant",
          type: "message",
        },
      ],
      status: "completed",
    });

    expect((await generate(false)).content).toBe("I cannot help with that.");
  });

  test("surfaces streamed refusal deltas", async () => {
    stubSse([
      { delta: "I cannot", type: "response.refusal.delta" },
      {
        response: {
          output: [
            {
              content: [{ refusal: "I cannot", type: "refusal" }],
              role: "assistant",
              type: "message",
            },
          ],
          status: "completed",
        },
        type: "response.completed",
      },
    ]);

    expect((await generate(true, { onChunk: () => undefined })).content).toBe(
      "I cannot"
    );
  });

  test("emits web search start and end once", async () => {
    const webSearch = {
      action: { query: "Atlas" },
      id: "ws_1",
      type: "web_search_call",
    };
    stubSse([
      { item: webSearch, type: "response.output_item.done" },
      {
        response: {
          output: [webSearch, messageOutput("done")],
          status: "completed",
        },
        type: "response.completed",
      },
    ]);
    const starts: unknown[] = [];
    const ends: unknown[] = [];

    await generate(true, {
      onChunk: () => undefined,
      onToolEnd: (event) => ends.push(event),
      onToolStart: (event) => starts.push(event),
    });

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
  });

  test("emits function argument deltas and keeps final arguments", async () => {
    const finalCall = {
      arguments: '{"query":"atlas"}',
      call_id: "call_1",
      id: "fc_1",
      name: "search",
      type: "function_call",
    };
    stubSse([
      {
        item: { ...finalCall, arguments: "" },
        type: "response.output_item.added",
      },
      {
        delta: '{"query":"atlas"}',
        item_id: "fc_1",
        type: "response.function_call_arguments.delta",
      },
      { item: finalCall, type: "response.output_item.done" },
      {
        response: { output: [finalCall], status: "completed" },
        type: "response.completed",
      },
    ]);
    const deltas: unknown[] = [];

    const result = await generate(true, {
      onChunk: () => undefined,
      onToolInputDelta: (event) => deltas.push(event),
    });

    expect(deltas).toEqual([
      {
        accumulatedArguments: '{"query":"atlas"}',
        delta: '{"query":"atlas"}',
        tool: "search",
        toolCallId: "call_1",
      },
    ]);
    expect(result.toolCalls[0]?.arguments).toEqual({ query: "atlas" });
  });
});
