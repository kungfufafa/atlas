import { expect, test } from "bun:test";
import type { ChatListItem } from "./chat-items";
import {
  appendOutgoingMessages,
  buildStreamHandlers,
  createReplayAwareHandlers,
  finalizeStreamingMessages,
  materializedToolCallIds,
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
