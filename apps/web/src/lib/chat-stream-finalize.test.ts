import { describe, expect, test } from "bun:test";
import type { FileUIPart } from "ai";
import type { ChatListItem } from "@/lib/chat-history";
import {
  appendOutgoingMessages,
  finalizeStreamingMessages,
  removeUnacceptedOutgoingMessages,
} from "./chat-stream";

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

describe("removeUnacceptedOutgoingMessages", () => {
  test("removes only the optimistic user and assistant pair", () => {
    const messages: ChatListItem[] = [
      { content: "stored", id: "stored", role: "assistant" },
      { content: "retry me", id: "user", role: "user" },
      {
        content: "",
        id: "assistant",
        role: "assistant",
        streaming: true,
      },
    ];

    expect(removeUnacceptedOutgoingMessages(messages)).toEqual([
      { content: "stored", id: "stored", role: "assistant" },
    ]);
  });

  test("keeps accepted or unrelated message tails intact", () => {
    const acceptedMessages: ChatListItem[] = [
      { content: "sent", id: "user", role: "user" },
      {
        content: "failed after acceptance",
        id: "assistant",
        role: "assistant",
        streaming: false,
      },
    ];

    expect(removeUnacceptedOutgoingMessages(acceptedMessages)).toBe(
      acceptedMessages
    );
  });
});

describe("appendOutgoingMessages retry snapshot", () => {
  test("copies attachment parts onto only the optimistic user message", () => {
    const files: FileUIPart[] = [
      {
        filename: "notes.md",
        mediaType: "text/markdown",
        type: "file",
        url: "data:text/markdown;base64,IyBOb3Rlcw==",
      },
    ];
    let messages: ChatListItem[] = [];

    appendOutgoingMessages(
      (update) => {
        messages = typeof update === "function" ? update(messages) : update;
      },
      "summarize",
      [],
      [{ filename: "notes.md", mediaType: "text/markdown" }],
      { retryFiles: files }
    );

    expect(messages[0]?.retryFiles).toEqual(files);
    expect(messages[0]?.retryFiles).not.toBe(files);
    expect(messages[0]?.retryFiles?.[0]).not.toBe(files[0]);
    expect(messages[1]?.retryFiles).toBeUndefined();
  });
});
