import { describe, expect, test } from "bun:test";
import type { ChatListItem } from "@/lib/chat-history";
import { finalizeStreamingMessages } from "./chat-stream";

describe("finalizeStreamingMessages", () => {
  test("clears every affected assistant and running tool", () => {
    const messages: ChatListItem[] = [
      { content: "hi", id: "u1", role: "user" },
      {
        content: "partial",
        id: "a1",
        role: "assistant",
        streaming: true,
        thinkingStreaming: true,
      },
      {
        content: "search_files stopped",
        id: "t1",
        role: "tool",
        tool: "search_files",
        toolStatus: "done",
      },
      {
        content: "still open",
        id: "a2",
        role: "assistant",
        streaming: true,
        thinkingStreaming: true,
      },
      {
        content: "bash",
        id: "t2",
        role: "tool",
        tool: "bash",
        toolStatus: "running",
      },
    ];

    const next = finalizeStreamingMessages(messages);

    expect(next[1]).toMatchObject({
      id: "a1",
      streaming: false,
      thinkingStreaming: false,
    });
    expect(next[3]).toMatchObject({
      id: "a2",
      streaming: false,
      thinkingStreaming: false,
    });
    expect(next[4]).toMatchObject({
      artifactStreaming: false,
      content: "bash stopped",
      id: "t2",
      toolStatus: "done",
    });
  });
});
