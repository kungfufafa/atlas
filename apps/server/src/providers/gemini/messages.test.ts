import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@atlas/core";
import {
  extractTextAndThinkingFromParts,
  parseGeminiFunctionCalls,
  toGeminiContents,
} from "./messages";

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("toGeminiContents", () => {
  test("maps user text and assistant tool calls", async () => {
    const messages: ChatMessage[] = [
      { content: "Hello", role: "user" },
      {
        content: "",
        role: "assistant",
        toolCalls: [
          { arguments: { path: "a.txt" }, id: "call_1", name: "write_file" },
        ],
      },
      {
        content: '{"ok":true}',
        name: "write_file",
        role: "tool",
        toolCallId: "call_1",
      },
    ];

    const contents = await toGeminiContents(messages);

    expect(contents).toHaveLength(3);
    expect(contents[0]?.role).toBe("user");
    expect(contents[0]?.parts?.[0]?.text).toBe("Hello");
    expect(contents[1]?.role).toBe("model");
    expect(contents[1]?.parts?.[0]?.functionCall).toEqual({
      args: { path: "a.txt" },
      id: "call_1",
      name: "write_file",
    });
    expect(contents[2]?.parts?.[0]?.functionResponse?.name).toBe("write_file");
    expect(contents[2]?.parts?.[0]?.functionResponse?.id).toBe("call_1");
  });

  test("preserves thinking parts in assistant message before function call", async () => {
    const messages: ChatMessage[] = [
      { content: "Search KB", role: "user" },
      {
        content: "",
        role: "assistant",
        thinking: "Searching knowledge base for query",
        toolCalls: [
          {
            arguments: { query: "test" },
            id: "call_kb",
            name: "knowledge_base_search",
          },
        ],
      },
      {
        content: '{"hits":[]}',
        name: "knowledge_base_search",
        role: "tool",
        toolCallId: "call_kb",
      },
    ];

    const contents = await toGeminiContents(messages);

    expect(contents[1]?.role).toBe("model");
    expect(contents[1]?.parts).toHaveLength(2);
    expect(contents[1]?.parts?.[0]).toEqual({
      text: "Searching knowledge base for query",
      thought: true,
    });
    expect(contents[1]?.parts?.[1]?.functionCall).toEqual({
      args: { query: "test" },
      id: "call_kb",
      name: "knowledge_base_search",
    });
  });

  test("uses raw providerContent with thoughtSignature when present", async () => {
    const rawPartWithSig = {
      functionCall: {
        args: { path: "demo.txt" },
        id: "call_sig",
        name: "write_file",
      },
      thoughtSignature: "sig_abc_123",
    };

    const messages: ChatMessage[] = [
      { content: "Write file", role: "user" },
      {
        content: "",
        providerContent: [rawPartWithSig],
        role: "assistant",
        toolCalls: [
          {
            arguments: { path: "demo.txt" },
            id: "call_sig",
            name: "write_file",
          },
        ],
      },
      {
        content: '{"ok":true}',
        name: "write_file",
        role: "tool",
        toolCallId: "call_sig",
      },
    ];

    const contents = await toGeminiContents(messages);

    expect(contents[1]?.role).toBe("model");
    expect(contents[1]?.parts).toEqual([rawPartWithSig]);
  });

  test("keeps synthetic ids internal when replaying id-less provider content", async () => {
    const messages: ChatMessage[] = [
      { content: "Write file", role: "user" },
      {
        content: "",
        providerContent: [
          {
            functionCall: {
              args: { ignored: true },
            },
          },
          {
            functionCall: {
              args: { path: "demo.txt" },
              name: "write_file",
            },
            thoughtSignature: "sig_abc_123",
          },
        ],
        role: "assistant",
        toolCalls: [
          {
            arguments: { path: "demo.txt" },
            id: "gemini_call_saved",
            name: "write_file",
          },
        ],
      },
      {
        content: '{"ok":true}',
        name: "write_file",
        role: "tool",
        toolCallId: "gemini_call_saved",
      },
    ];

    const contents = await toGeminiContents(messages);

    expect(contents[1]?.parts?.[1]).toEqual({
      functionCall: {
        args: { path: "demo.txt" },
        name: "write_file",
      },
      thoughtSignature: "sig_abc_123",
    });
    expect(contents[2]?.parts?.[0]?.functionResponse).toEqual({
      name: "write_file",
      response: { ok: true },
    });
  });

  test("maps image parts to inlineData", async () => {
    const messages: ChatMessage[] = [
      {
        content: [
          { text: "What is this?", type: "text" },
          { data: tinyPngBase64, mediaType: "image/png", type: "image" },
        ],
        role: "user",
      },
    ];

    const contents = await toGeminiContents(messages);

    expect(contents[0]?.parts?.[0]?.text).toBe("What is this?");
    expect(contents[0]?.parts?.[1]?.inlineData).toEqual({
      data: tinyPngBase64,
      mimeType: "image/png",
    });
  });

  test("keeps a result only next to its call and drops duplicate or orphan outputs", async () => {
    const result: ChatMessage = {
      content: '{"ok":true}',
      name: "lookup",
      role: "tool",
      toolCallId: "call_1",
    };
    const contents = await toGeminiContents([
      result,
      {
        content: "",
        role: "assistant",
        toolCalls: [{ arguments: {}, id: "call_1", name: "lookup" }],
      },
      result,
      result,
      { content: "Continue", role: "user" },
      result,
    ]);

    expect(contents).toEqual([
      {
        parts: [{ functionCall: { args: {}, id: "call_1", name: "lookup" } }],
        role: "model",
      },
      {
        parts: [
          {
            functionResponse: {
              id: "call_1",
              name: "lookup",
              response: { ok: true },
            },
          },
        ],
        role: "user",
      },
      { parts: [{ text: "Continue" }], role: "user" },
    ]);
  });

  test("filters partial id-less calls without losing the retained signature", async () => {
    const retained = {
      functionCall: { args: { path: "keep.txt" }, name: "read_file" },
      thoughtSignature: "signature-keep",
    };
    const contents = await toGeminiContents([
      {
        content: "",
        providerContent: [
          {
            functionCall: { args: { path: "drop.txt" }, name: "read_file" },
            thoughtSignature: "signature-drop",
          },
          retained,
        ],
        role: "assistant",
        toolCalls: [
          {
            arguments: { path: "drop.txt" },
            id: "gemini_call_drop",
            name: "read_file",
          },
          {
            arguments: { path: "keep.txt" },
            id: "gemini_call_keep",
            name: "read_file",
          },
        ],
      },
      {
        content: "kept contents",
        name: "read_file",
        role: "tool",
        toolCallId: "gemini_call_keep",
      },
    ]);

    expect(contents).toEqual([
      { parts: [retained], role: "model" },
      {
        parts: [
          {
            functionResponse: {
              name: "read_file",
              response: { output: "kept contents" },
            },
          },
        ],
        role: "user",
      },
    ]);
  });

  test("preserves assistant text and thinking when its calls have no result", async () => {
    const contents = await toGeminiContents([
      {
        content: "I can continue from here.",
        providerContent: [
          { text: "A useful thought", thought: true },
          { text: "I can continue from here." },
          { functionCall: { args: {}, id: "orphan", name: "lookup" } },
        ],
        role: "assistant",
        thinking: "A useful thought",
        toolCalls: [{ arguments: {}, id: "orphan", name: "lookup" }],
      },
      { content: "Continue", role: "user" },
    ]);

    expect(contents).toEqual([
      {
        parts: [
          { text: "A useful thought", thought: true },
          { text: "I can continue from here." },
        ],
        role: "model",
      },
      { parts: [{ text: "Continue" }], role: "user" },
    ]);
  });
});

describe("parseGeminiFunctionCalls", () => {
  test("parses function calls with ids", () => {
    expect(
      parseGeminiFunctionCalls([
        { args: { path: "a.txt" }, id: "fc1", name: "write_file" },
      ])
    ).toEqual([
      { arguments: { path: "a.txt" }, id: "fc1", name: "write_file" },
    ]);
  });

  test("synthesizes distinct ids when Gemini omits optional function-call ids", () => {
    const calls = parseGeminiFunctionCalls([
      { args: { path: "a.txt" }, name: "write_file" },
      { args: { path: "b.txt" }, name: "write_file" },
    ]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      arguments: { path: "a.txt" },
      name: "write_file",
    });
    expect(calls[0]?.id).toStartWith("gemini_call_");
    expect(calls[1]?.id).toStartWith("gemini_call_");
    expect(calls[0]?.id).not.toBe(calls[1]?.id);
  });
});

describe("extractTextAndThinkingFromParts", () => {
  test("separates thought parts from response text", () => {
    expect(
      extractTextAndThinkingFromParts([
        { text: "Plan", thought: true },
        { text: "Answer" },
      ])
    ).toEqual({ content: "Answer", thinking: "Plan" });
  });
});
