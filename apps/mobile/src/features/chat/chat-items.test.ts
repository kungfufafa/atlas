import { expect, test } from "bun:test";
import {
  artifactsFromToolResult,
  chatMessagesToListItems,
  formatToolLabel,
  userContentToText,
} from "./chat-items";

test("flattens user text parts", () => {
  expect(
    userContentToText([
      { text: "Hello", type: "text" },
      { data: "abc", mediaType: "image/png", type: "image" },
      { text: "world", type: "text" },
    ])
  ).toBe("Hello\nworld");
});

test("turns stored messages into list items including tools", () => {
  const items = chatMessagesToListItems([
    { content: "Hi", role: "user" },
    {
      content: "",
      role: "assistant",
      toolCalls: [
        { arguments: { path: "notes.md" }, id: "call_1", name: "read_file" },
      ],
    },
    {
      content: JSON.stringify({ bytesWritten: 12, path: "artifacts/notes.md" }),
      name: "write_file",
      role: "tool",
      toolCallId: "call_1",
    },
    { content: "Done.", role: "assistant" },
  ]);

  expect(items.map((item) => item.role)).toEqual(["user", "tool", "assistant"]);
  expect(items[1]?.tool).toBe("write_file");
  expect(items[0]?.historyIndex).toBe(0);
  expect(items[1]?.historyIndex).toBe(2);
  expect(items[1]?.artifacts?.[0]?.filename).toBe("notes.md");
  expect(items[2]?.historyIndex).toBe(3);
  expect(items[2]?.content).toBe("Done.");
});

test("builds an artifact card from a write result", () => {
  expect(
    artifactsFromToolResult({ bytesWritten: 2048, path: "artifacts/report.md" })
  ).toEqual([
    {
      filename: "report.md",
      id: "artifacts/report.md",
      mimeType: "application/octet-stream",
      path: "artifacts/report.md",
      size: 2048,
      type: "file",
    },
  ]);
});

test("labels tools with a path or query", () => {
  expect(formatToolLabel("read_file", { path: "SOUL.md" })).toBe(
    "read_file · SOUL.md"
  );
});

test("hydrates a pending approval on an assistant message", () => {
  const items = chatMessagesToListItems([
    {
      approval: {
        consequenceSummary: "Run bash",
        createdAt: "2026-01-01",
        id: "appr_1",
        status: "pending",
        title: "Allow bash",
        tool: "bash",
        toolCallId: "call_1",
      },
      content: "",
      role: "assistant",
      toolCalls: [{ arguments: {}, id: "call_1", name: "bash" }],
    },
  ]);

  expect(items).toHaveLength(1);
  expect(items[0]?.approval?.id).toBe("appr_1");
});
