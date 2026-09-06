import { afterEach, describe, expect, test } from "bun:test";
import type { GenerateChatInput, ProviderClient } from "@atlas/core";
import { createCerebrasProvider } from "./cerebras";
import { createFireworksProvider } from "./fireworks";
import { createOpenAIProvider } from "./openai";
import { createOpenAICompatibleProvider } from "./openai-compatible";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const input: GenerateChatInput = {
  messages: [{ content: "Read the file", role: "user" }],
  system: "Use the supplied tools.",
  tools: [
    {
      description: "Read a file",
      name: "read_file",
      parameters: { properties: { path: { type: "string" } }, type: "object" },
    },
  ],
};

const adapters: Array<{ name: string; create: () => ProviderClient }> = [
  {
    create: () => createOpenAIProvider({ apiKey: "fixture", model: "fixture" }),
    name: "OpenAI",
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
      createOpenAICompatibleProvider({
        apiKey: "fixture",
        baseUrl: "https://provider.invalid/v1",
        displayName: "Fixture",
        model: "fixture",
        supportsThinking: false,
      }),
    name: "OpenAI-compatible",
  },
];

function toolDelta(argumentsText: string) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              function: { arguments: argumentsText, name: "read_file" },
              id: "call_1",
              index: 0,
              type: "function",
            },
          ],
        },
      },
    ],
  };
}

function mockStream(events: unknown[]): void {
  const body = events
    .map(
      (event) =>
        `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`
    )
    .join("");
  globalThis.fetch = (async () =>
    new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
}

for (const adapter of adapters) {
  describe(`${adapter.name} completion integrity`, () => {
    test("rejects partial text or tool calls when the connection closes without completion", async () => {
      for (const event of [
        { choices: [{ delta: { content: "Partial answer" } }] },
        toolDelta('{"path":"a.txt"}'),
      ]) {
        mockStream([event]);
        await expect(
          adapter.create().streamChat(input, { onChunk: () => {} })
        ).rejects.toThrow();
      }
    });

    test("rejects invalid tool arguments even after the provider completes", async () => {
      for (const argumentsText of ['{"path":"a', "[]", "null"]) {
        mockStream([toolDelta(argumentsText), "[DONE]"]);
        await expect(
          adapter.create().streamChat(input, { onChunk: () => {} })
        ).rejects.toThrow();
      }
    });

    test("rejects explicit truncation and provider errors after partial output", async () => {
      for (const terminal of [
        { choices: [{ delta: {}, finish_reason: "length" }] },
        { choices: [{ delta: {}, finish_reason: "content_filter" }] },
        { error: { message: "Upstream failed" } },
      ]) {
        mockStream([toolDelta('{"path":"a.txt"}'), terminal, "[DONE]"]);
        await expect(
          adapter.create().streamChat(input, { onChunk: () => {} })
        ).rejects.toThrow();
      }
    });

    test("accepts explicit completion and retains trailing usage", async () => {
      mockStream([
        toolDelta('{"path":"a.txt"}'),
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        {
          choices: [],
          usage: { completion_tokens: 6, prompt_tokens: 10, total_tokens: 16 },
        },
      ]);
      const result = await adapter
        .create()
        .streamChat(input, { onChunk: () => {} });
      expect(result.toolCalls).toEqual([
        { arguments: { path: "a.txt" }, id: "call_1", name: "read_file" },
      ]);
      expect(result.usage).toEqual({
        inputTokens: 10,
        outputTokens: 6,
        totalTokens: 16,
      });
    });

    test("rejects malformed tool arguments in nonstreaming completions", async () => {
      globalThis.fetch = (async () =>
        Response.json({
          choices: [
            {
              message: {
                content: "",
                role: "assistant",
                tool_calls: [
                  {
                    function: { arguments: '{"path":', name: "read_file" },
                    id: "call_1",
                    type: "function",
                  },
                ],
              },
            },
          ],
        })) as typeof fetch;
      await expect(adapter.create().generateChat(input)).rejects.toThrow();
    });

    test("rejects tool calls missing correlation or a name instead of returning the preamble", async () => {
      for (const call of [
        { function: { arguments: "{}", name: "read_file" }, index: 0 },
        { function: { arguments: "{}" }, id: "call_1", index: 0 },
      ]) {
        mockStream([
          {
            choices: [
              { delta: { content: "I will read it.", tool_calls: [call] } },
            ],
          },
          "[DONE]",
        ]);
        await expect(
          adapter.create().streamChat(input, { onChunk: () => {} })
        ).rejects.toThrow();
      }
    });

    test("rejects explicitly truncated JSON completions", async () => {
      globalThis.fetch = (async () =>
        Response.json({
          choices: [
            {
              finish_reason: "length",
              message: { content: "Partial answer", role: "assistant" },
            },
          ],
        })) as typeof fetch;
      await expect(adapter.create().generateChat(input)).rejects.toThrow();
      await expect(
        adapter
          .create()
          .generateText({ format: "text", prompt: "Answer", system: "Answer" })
      ).rejects.toThrow();
    });
  });
}
