import { afterEach, describe, expect, test } from "bun:test";
import type { GenerateChatInput, ProviderClient } from "@atlas/core";
import { createAnthropicProvider } from "./anthropic";
import { createGeminiProvider } from "./gemini";
import { createOpenRouterProvider } from "./openrouter";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const input: GenerateChatInput = {
  messages: [{ content: "Answer", role: "user" }],
  system: "Answer",
};

function event(data: unknown, name?: string): string {
  return `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function openRouterChunk(
  content: string,
  finishReason: string | null = null
): string {
  return event({
    choices: [{ delta: { content }, finish_reason: finishReason, index: 0 }],
    created: 1,
    id: "chunk_1",
    model: "fixture",
    object: "chat.completion.chunk",
  });
}

const adapters: Array<{
  name: string;
  create: () => ProviderClient;
  partial: string;
  terminal: string;
  truncated: string;
  truncatedJson: unknown;
}> = [
  {
    create: () =>
      createAnthropicProvider({
        apiKey: "fixture",
        fetch: globalThis.fetch,
        model: "fixture",
      }),
    name: "Anthropic",
    partial:
      event(
        {
          message: { usage: { input_tokens: 2, output_tokens: 0 } },
          type: "message_start",
        },
        "message_start"
      ) +
      event(
        {
          content_block: { text: "", type: "text" },
          index: 0,
          type: "content_block_start",
        },
        "content_block_start"
      ) +
      event(
        {
          delta: { text: "Partial", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        "content_block_delta"
      ),
    terminal: event(
      {
        delta: { stop_reason: "end_turn" },
        type: "message_delta",
        usage: { output_tokens: 1 },
      },
      "message_delta"
    ),
    truncated: event(
      {
        delta: { stop_reason: "max_tokens" },
        type: "message_delta",
        usage: { output_tokens: 1 },
      },
      "message_delta"
    ),
    truncatedJson: {
      content: [{ text: "Partial", type: "text" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 2, output_tokens: 1 },
    },
  },
  {
    create: () => createGeminiProvider({ apiKey: "fixture", model: "fixture" }),
    name: "Gemini",
    partial: event({
      candidates: [
        { content: { parts: [{ text: "Partial" }], role: "model" } },
      ],
    }),
    terminal: event({ candidates: [{ finishReason: "STOP" }] }),
    truncated: event({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
    truncatedJson: {
      candidates: [
        {
          content: { parts: [{ text: "Partial" }], role: "model" },
          finishReason: "MAX_TOKENS",
        },
      ],
    },
  },
  {
    create: () =>
      createOpenRouterProvider({
        apiKey: "fixture",
        fetcher: globalThis.fetch,
        model: "fixture",
      }),
    name: "OpenRouter",
    partial: openRouterChunk("Partial"),
    terminal: openRouterChunk("", "stop"),
    truncated: openRouterChunk("", "length"),
    truncatedJson: {
      choices: [
        {
          finish_reason: "length",
          index: 0,
          message: { content: "Partial", role: "assistant" },
        },
      ],
      created: 1,
      id: "completion_1",
      model: "fixture",
      object: "chat.completion",
    },
  },
];

for (const adapter of adapters) {
  describe(`${adapter.name} native completion integrity`, () => {
    test("rejects SDK iterator EOF without a provider terminal status", async () => {
      globalThis.fetch = (async () =>
        new Response(adapter.partial, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch;
      await expect(
        adapter.create().streamChat(input, { onChunk: () => {} })
      ).rejects.toThrow();
    });

    test("rejects explicit truncation after streamed text", async () => {
      globalThis.fetch = (async () =>
        new Response(adapter.partial + adapter.truncated, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch;
      await expect(
        adapter.create().streamChat(input, { onChunk: () => {} })
      ).rejects.toThrow();
    });

    test("accepts a completed native stream and preserves emitted text", async () => {
      globalThis.fetch = (async () =>
        new Response(adapter.partial + adapter.terminal, {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch;
      const chunks: string[] = [];
      const result = await adapter
        .create()
        .streamChat(input, { onChunk: (chunk) => chunks.push(chunk) });
      expect(result.content).toBe("Partial");
      expect(chunks.join("")).toBe("Partial");
    });

    test("rejects explicitly truncated nonstreaming chat and text responses", async () => {
      globalThis.fetch = (async () =>
        Response.json(adapter.truncatedJson)) as typeof fetch;
      await expect(adapter.create().generateChat(input)).rejects.toThrow();
      await expect(
        adapter
          .create()
          .generateText({ format: "text", prompt: "Answer", system: "Answer" })
      ).rejects.toThrow();
    });
  });
}
