import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@atlas/core";
import { formatSubscriptionPrompt, parseSubscriptionResponse } from "./prompt";

function fence(body: string, newline = "\n"): string {
  return ["```atlas-tool-call", body, "```"].join(newline);
}

describe("subscription tool protocol integrity", () => {
  test.each([
    "invalid JSON",
    '{"name":"read_file","arguments":"path.txt"}',
    '{"name":"read_file","arguments":[]}',
    '{"name":"read_file","arguments":null}',
    '{"arguments":{"path":"file.txt"}}',
    "null",
  ])(
    "rejects malformed calls without converting %s to empty success or empty arguments",
    (body) => {
      expect(() => parseSubscriptionResponse(fence(body))).toThrow();
    }
  );

  test("rejects truncated calls and duplicate call IDs before any tools can run", () => {
    expect(() =>
      parseSubscriptionResponse('```atlas-tool-call\n{"name":"read_file"')
    ).toThrow();
    const call = fence('{"id":"same","name":"read_file","arguments":{}}');
    expect(() => parseSubscriptionResponse(`${call}\n${call}`)).toThrow();
  });

  test.each(["\n", "\r\n"])(
    "preserves literal markdown fences in tool arguments with %j line endings",
    (newline) => {
      const arguments_ = { content: "```typescript\nconst n = 1;\n```" };
      const result = parseSubscriptionResponse(
        fence(
          JSON.stringify({ arguments: arguments_, name: "write_file" }),
          newline
        )
      );
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.arguments).toEqual(arguments_);
      expect(result.content).toBe("");
    }
  );

  test("correlates parallel same-name tool results with their actual arguments on continuation", async () => {
    const messages: ChatMessage[] = [
      { content: "Compare both files", role: "user" },
      {
        content: "",
        role: "assistant",
        toolCalls: [
          { arguments: { path: "a.txt" }, id: "call-a", name: "read_file" },
          { arguments: { path: "b.txt" }, id: "call-b", name: "read_file" },
        ],
      },
      {
        content: "Contents B",
        name: "read_file",
        role: "tool",
        toolCallId: "call-b",
      },
      {
        content: "Contents A",
        name: "read_file",
        role: "tool",
        toolCallId: "call-a",
      },
    ];
    const result = await formatSubscriptionPrompt(
      { messages, system: "Atlas" },
      "chatgpt",
      1
    );
    expect(result.continuationInput).toHaveLength(2);
    const texts = result.continuationInput.flatMap((part) =>
      part.type === "text" ? [part.text] : []
    );
    expect(texts[0]).toContain('"path":"b.txt"');
    expect(texts[0]).toContain("Contents B");
    expect(texts[1]).toContain('"path":"a.txt"');
    expect(texts[1]).toContain("Contents A");
    const changedMessages = messages.map((message) =>
      message.role === "tool"
        ? {
            ...message,
            toolCallId: message.toolCallId === "call-a" ? "call-b" : "call-a",
          }
        : message
    );
    const changed = await formatSubscriptionPrompt(
      { messages: changedMessages, system: "Atlas" },
      "chatgpt",
      1
    );
    expect(changed.historyFingerprint).not.toBe(result.historyFingerprint);
  });
});
