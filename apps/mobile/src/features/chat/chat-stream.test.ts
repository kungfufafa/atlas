import { expect, test } from "bun:test";
import type { ChatListItem } from "./chat-items";
import {
  appendFailedTurnIfNeeded,
  appendOutgoingMessages,
  buildStreamHandlers,
  createReplayAwareHandlers,
  finalizeStreamingMessages,
  findFailedRetryPrompt,
  markStreamingTurnFailed,
  materializedToolCallIds,
  messagesWithoutFailedTurn,
  resolveFailedRetryInput,
  seedStreamingStateForActiveTurn,
} from "./chat-stream";

test("appends a user message and a streaming assistant placeholder", () => {
  const next = appendOutgoingMessages([], "Hello");
  expect(next).toHaveLength(2);
  expect(next[0]?.role).toBe("user");
  expect(next[0]?.content).toBe("Hello");
  expect(next[1]?.role).toBe("assistant");
  expect(next[1]?.streaming).toBe(true);
});

test("retains attachment payloads for an in-memory retry", () => {
  const documents = [
    {
      data: "document-data",
      filename: "brief.pdf",
      mediaType: "application/pdf",
    },
  ];
  const images = [{ data: "image-data", mediaType: "image/png" }];
  const next = appendOutgoingMessages([], "Review this", 2, {
    documents,
    images,
  });
  const prompt = next[0];

  expect(resolveFailedRetryInput(prompt)).toEqual({
    input: {
      documents: [
        {
          data: "document-data",
          filename: "brief.pdf",
          mediaType: "application/pdf",
        },
      ],
      images: [{ data: "image-data", mediaType: "image/png" }],
      message: "Review this",
    },
    status: "ready",
  });
  expect(prompt?.retryAttachments?.documents).not.toBe(documents);
  expect(prompt?.retryAttachments?.documents?.[0]).not.toBe(documents[0]);
  expect(prompt?.retryAttachments?.images).not.toBe(images);
  expect(prompt?.retryAttachments?.images?.[0]).not.toBe(images[0]);
});

test("marks the last streaming assistant failed and settles pending work", () => {
  const next = markStreamingTurnFailed(
    [
      { content: "Try", id: "user", role: "user" },
      {
        content: "Partial",
        id: "assistant-one",
        role: "assistant",
        streaming: true,
      },
      {
        content: "bash",
        id: "tool",
        role: "tool",
        tool: "bash",
        toolStatus: "running",
      },
      {
        content: "",
        id: "assistant-two",
        role: "assistant",
        streaming: true,
        thinkingStreaming: true,
      },
    ],
    "Rate limited"
  );

  expect(next[1]).toMatchObject({
    content: "Partial",
    streaming: false,
  });
  expect(next[1]?.failed).toBeUndefined();
  expect(next[2]).toMatchObject({
    content: "bash stopped",
    toolStatus: "done",
  });
  expect(next[3]).toMatchObject({
    content: "Rate limited",
    failed: true,
    streaming: false,
    thinkingStreaming: false,
  });
});

test("appends a failure after a pending tool has replaced the stream shell", () => {
  const next = markStreamingTurnFailed(
    [
      { content: "Try", id: "user", role: "user" },
      { content: "", id: "assistant", role: "assistant" },
      {
        content: "bash",
        id: "tool",
        role: "tool",
        tool: "bash",
        toolStatus: "running",
      },
    ],
    "Connection failed"
  );

  expect(next[2]).toMatchObject({
    content: "bash stopped",
    toolStatus: "done",
  });
  expect(next[3]).toMatchObject({
    content: "Connection failed",
    failed: true,
    role: "assistant",
  });
});

test("restores a failed turn after reload without duplicating its prompt", () => {
  const next = appendFailedTurnIfNeeded(
    [{ content: "Retry me", historyIndex: 2, id: "user", role: "user" }],
    { error: "429", text: "Retry me" }
  );

  expect(next).toHaveLength(2);
  expect(next[0]?.id).toBe("user");
  expect(next[1]).toMatchObject({
    content: "429",
    failed: true,
    role: "assistant",
  });
});

test("finds and removes only the optimistic failed turn before retry", () => {
  const kept = {
    content: "Earlier",
    historyIndex: 0,
    id: "kept",
    role: "user" as const,
  };
  const prompt = { content: "Retry me", id: "prompt", role: "user" as const };
  const failed = {
    content: "429",
    failed: true,
    id: "failed",
    role: "assistant" as const,
  };
  const messages = [kept, prompt, failed];

  expect(findFailedRetryPrompt(messages, failed)).toBe(prompt);
  expect(messagesWithoutFailedTurn(messages, failed)).toEqual([kept]);
});

test("keeps a persisted prompt while removing its failed marker", () => {
  const prompt = {
    content: "Retry me",
    historyIndex: 2,
    id: "prompt",
    role: "user" as const,
  };
  const failed = {
    content: "429",
    failed: true,
    id: "failed",
    role: "assistant" as const,
  };

  expect(messagesWithoutFailedTurn([prompt, failed], failed)).toEqual([prompt]);
});

test("reports when original retry attachments are no longer available", () => {
  expect(
    resolveFailedRetryInput({
      attachmentCount: 1,
      content: "Review this",
      id: "prompt",
      role: "user",
    })
  ).toEqual({ status: "attachments_unavailable" });
});

test("streams assistant text onto the placeholder", () => {
  let messages = appendOutgoingMessages([], "Hi");
  const handlers = buildStreamHandlers((updater) => {
    messages = updater(messages);
  });

  handlers.onChunk("Hel");
  handlers.onChunk("lo");

  expect(messages[1]?.content).toBe("Hello");
  expect(messages[1]?.streaming).toBe(true);
});

test("ignores stream events after the active server changes", () => {
  let messages = appendOutgoingMessages([], "Hi");
  let current = true;
  const handlers = buildStreamHandlers(
    (updater) => {
      messages = updater(messages);
    },
    { isCurrent: () => current }
  );

  current = false;
  handlers.onChunk("This must not be shown.");
  handlers.onToolStart?.({
    input: {},
    tool: "read_file",
    toolCallId: "call_stale",
  });

  expect(messages).toHaveLength(2);
  expect(messages[1]?.content).toBe("");
});

test("records running then completed tool calls", () => {
  let messages: ChatListItem[] = [
    { content: "", id: "a", role: "assistant", streaming: true },
  ];
  const handlers = buildStreamHandlers((updater) => {
    messages = updater(messages);
  });

  handlers.onToolStart?.({
    input: { path: "SOUL.md" },
    tool: "read_file",
    toolCallId: "call_1",
  });
  handlers.onToolEnd?.({
    result: { path: "SOUL.md" },
    tool: "read_file",
    toolCallId: "call_1",
  });

  const tool = messages.find((message) => message.role === "tool");
  expect(tool?.toolStatus).toBe("done");
  expect(tool?.tool).toBe("read_file");
  expect(messages[0]?.streaming).toBe(false);
});

test("clears streaming flags when the turn is aborted", () => {
  const finalized = finalizeStreamingMessages([
    { content: "partial", id: "a", role: "assistant", streaming: true },
  ]);
  expect(finalized[0]?.streaming).toBe(false);
});

test("attaches a pending approval to the last message", () => {
  let messages: ChatListItem[] = [
    { content: "", id: "a", role: "assistant", streaming: true },
  ];
  const handlers = buildStreamHandlers((updater) => {
    messages = updater(messages);
  });

  handlers.onApprovalRequested?.({
    consequenceSummary: "Run bash",
    createdAt: "2026-01-01",
    id: "appr_1",
    status: "pending",
    title: "Allow bash",
    tool: "bash",
    toolCallId: "call_1",
  });

  expect(messages[0]?.approval?.id).toBe("appr_1");
});

test("seeds an assistant shell so an active turn can keep streaming", () => {
  const seeded = seedStreamingStateForActiveTurn([
    { content: "Hi", id: "u", role: "user" },
  ]);
  expect(seeded[1]?.role).toBe("assistant");
  expect(seeded[1]?.streaming).toBe(true);
});

test("ignores replayed tool events that are already in the list", () => {
  const ids = materializedToolCallIds([
    {
      content: "read_file",
      id: "call_1",
      role: "tool",
      toolCallId: "call_1",
    },
  ]);
  let started = 0;
  const handlers = createReplayAwareHandlers(
    {
      onChunk: () => undefined,
      onToolStart: () => {
        started += 1;
      },
    },
    ids
  );
  handlers.onToolStart?.({
    input: {},
    tool: "read_file",
    toolCallId: "call_1",
  });
  expect(started).toBe(0);
});
