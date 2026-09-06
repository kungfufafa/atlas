import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@atlas/core";
import {
  formatHttpErrorBody,
  normalizeThinkingEffort,
  parseJsonRecord,
  parseToolArguments,
  readRecord,
  readSseEvents,
  resolveThinkingEffort,
  sanitizeToolCallHistory,
} from "./shared";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      controller.close();
    },
  });
}

describe("provider shared helpers", () => {
  test("readSseEvents parses event names and skips done markers", async () => {
    const events: Array<{ event: string; data: string }> = [];

    await readSseEvents(
      streamFromChunks([
        'event: message\ndata: {"chunk":1}\n\n',
        'event: custom\ndata: {"chunk":2}\n\n',
        "data: [DONE]\n\n",
      ]),
      (event) => {
        events.push(event);
      }
    );

    expect(events).toEqual([
      { data: '{"chunk":1}', event: "message" },
      { data: '{"chunk":2}', event: "custom" },
    ]);
  });

  test("readSseEvents supports CRLF and data lines without a space", async () => {
    const events: Array<{ event: string; data: string }> = [];

    await readSseEvents(
      streamFromChunks([
        'event: custom\r\ndata:{"chunk":',
        '1}\r\n\r\ndata:{"chunk":2}\r\n\r\n',
      ]),
      (event) => {
        events.push(event);
      }
    );

    expect(events).toEqual([
      { data: '{"chunk":1}', event: "custom" },
      { data: '{"chunk":2}', event: "message" },
    ]);
  });

  test("parseJsonRecord returns empty objects for invalid JSON", () => {
    expect(parseJsonRecord('{"ok":true}')).toEqual({ ok: true });
    expect(parseJsonRecord("[]")).toEqual({});
    expect(parseJsonRecord("")).toEqual({});
    expect(parseJsonRecord("{bad json")).toEqual({});
  });

  test("tool arguments preserve valid objects and reject malformed inputs", () => {
    expect(
      parseToolArguments('{"path":"a.txt","nested":{"value":null}}')
    ).toEqual({
      nested: { value: null },
      path: "a.txt",
    });
    expect(parseToolArguments("{}")).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
    for (const raw of [
      '{"path":"a',
      "[]",
      "null",
      "true",
      '"text"',
      null,
      {},
    ]) {
      expect(() => parseToolArguments(raw)).toThrow();
    }
  });

  test("SSE parsing cancels the body and releases its lock after a callback fails", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"chunk":1}\n\n'));
      },
    });
    await expect(
      readSseEvents(body, () => {
        throw new Error("Invalid event");
      })
    ).rejects.toThrow();
    expect(canceled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("readRecord only accepts plain records", () => {
    expect(readRecord({ ok: true })).toEqual({ ok: true });
    expect(readRecord(null)).toEqual({});
    expect(readRecord([])).toEqual({});
    expect(readRecord("text")).toEqual({});
  });

  test("does not invent provider effort support or defaults", () => {
    expect(normalizeThinkingEffort("high")).toBeUndefined();
    expect(resolveThinkingEffort("high")).toBeUndefined();
    expect(resolveThinkingEffort("high", [])).toBeUndefined();
    expect(resolveThinkingEffort("high", ["low", "xhigh"])).toBeUndefined();
    expect(resolveThinkingEffort(undefined, ["low", "high"])).toBeUndefined();
    expect(resolveThinkingEffort("max", ["low", "high"], "low")).toBe("low");
    expect(resolveThinkingEffort("high", ["low", "high"], "low")).toBe("high");
    expect(
      resolveThinkingEffort("max", ["low", "high"], "medium")
    ).toBeUndefined();
  });

  test("formatHttpErrorBody extracts OpenCode-style JSON errors", () => {
    expect(
      formatHttpErrorBody(
        "OpenCode Zen",
        429,
        JSON.stringify({
          error: {
            message: "Rate limit exceeded. Please try again later.",
            type: "FreeUsageLimitError",
          },
          type: "error",
        })
      )
    ).toBe(
      "OpenCode Zen request failed (429 FreeUsageLimitError): Rate limit exceeded. Please try again later."
    );
  });

  const user = (content: string): ChatMessage => ({ content, role: "user" });
  const toolResult = (toolCallId: string, content = "ok"): ChatMessage => ({
    content,
    name: "lookup",
    role: "tool",
    toolCallId,
  });
  const assistantTools = (
    id: string,
    args: Record<string, unknown> = {},
    thinking?: string
  ): ChatMessage => ({
    content: "",
    role: "assistant",
    ...(thinking ? { thinking } : {}),
    toolCalls: [{ arguments: args, id, name: "lookup" }],
  });

  test("sanitizeToolCallHistory drops orphaned tool_calls assistants", () => {
    expect(
      sanitizeToolCallHistory([
        user("Use the tool"),
        assistantTools("call_missing"),
        user("Thanks"),
      ])
    ).toEqual([user("Use the tool"), user("Thanks")]);
  });

  test("sanitizeToolCallHistory drops orphaned tool messages", () => {
    expect(
      sanitizeToolCallHistory([user("Hi"), toolResult("call_orphan", "result")])
    ).toEqual([user("Hi")]);
  });

  test("sanitizeToolCallHistory drops empty assistant messages", () => {
    expect(
      sanitizeToolCallHistory([
        user("Hi"),
        { content: "", role: "assistant" },
        user("Again"),
      ])
    ).toEqual([user("Hi"), user("Again")]);
  });

  test("sanitizeToolCallHistory keeps thinking-only assistants", () => {
    const thinkingOnly: ChatMessage = {
      content: "",
      role: "assistant",
      thinking: "plan the answer",
    };
    expect(sanitizeToolCallHistory([user("Hi"), thinkingOnly])).toEqual([
      user("Hi"),
      thinkingOnly,
    ]);
  });

  test("sanitizeToolCallHistory leaves intact tool pairs untouched", () => {
    const messages: ChatMessage[] = [
      user("Use the tool"),
      assistantTools("call_1", { q: "x" }, "plan"),
      toolResult("call_1"),
      { content: "Done", role: "assistant" },
    ];
    expect(sanitizeToolCallHistory(messages)).toEqual(messages);
  });
});
