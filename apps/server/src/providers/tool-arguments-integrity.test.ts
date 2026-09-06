import { afterEach, describe, expect, test } from "bun:test";
import type { GenerateChatInput } from "@atlas/core";
import { parseAnthropicContent } from "./anthropic/web-search";
import { parseGeminiFunctionCalls } from "./gemini/messages";
import { generateOpenAIResponsesChat } from "./openai/responses";
import { createOpenRouterProvider } from "./openrouter";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const input: GenerateChatInput = {
  messages: [{ content: "Read a file", role: "user" }],
  system: "Use tools.",
};

describe("provider tool argument integrity", () => {
  test("Anthropic rejects non-object tool inputs instead of replacing them", () => {
    for (const value of [null, [], "text", 1]) {
      expect(() =>
        parseAnthropicContent([
          { id: "tool_1", input: value, name: "read_file", type: "tool_use" },
        ])
      ).toThrow();
    }
    const result = parseAnthropicContent([
      {
        id: "tool_1",
        input: { path: "a.txt" },
        name: "read_file",
        type: "tool_use",
      },
    ]);
    expect(result.toolCalls[0]?.arguments).toEqual({ path: "a.txt" });
  });

  test("Gemini rejects non-object function arguments and accepts omitted no-argument input", () => {
    for (const args of [null, [], "text", 1]) {
      expect(() =>
        parseGeminiFunctionCalls([
          { args: args as never, id: "call_1", name: "read_file" },
        ])
      ).toThrow();
    }
    expect(
      parseGeminiFunctionCalls([{ id: "call_1", name: "list_files" }])[0]
        ?.arguments
    ).toEqual({});
  });

  test("Responses rejects incomplete tool arguments in completed streaming and JSON responses", async () => {
    const output = [
      {
        arguments: '{"path":',
        call_id: "call_1",
        id: "fc_1",
        name: "read_file",
        type: "function_call",
      },
    ];
    for (const stream of [false, true]) {
      globalThis.fetch = (async () =>
        stream
          ? new Response(
              `data: ${JSON.stringify({ response: { output, status: "completed" }, type: "response.completed" })}\n\n`,
              { headers: { "content-type": "text/event-stream" } }
            )
          : Response.json({ output, status: "completed" })) as typeof fetch;
      await expect(
        generateOpenAIResponsesChat({
          apiKey: "fixture",
          input,
          model: "fixture",
          stream,
        })
      ).rejects.toThrow();
    }
  });

  test("OpenRouter rejects malformed tool arguments from its SDK response", async () => {
    const fetcher = (async () =>
      Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            index: 0,
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
        created: 1,
        id: "completion_1",
        model: "fixture",
        object: "chat.completion",
      })) as typeof fetch;
    const provider = createOpenRouterProvider({
      apiKey: "fixture",
      fetcher,
      model: "fixture",
    });
    await expect(provider.generateChat(input)).rejects.toThrow();
  });
});
