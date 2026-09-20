import { expect, test } from "bun:test";
import type { ApprovalRequest } from "@atlas/core/contract";
import type { ChatListItem } from "./chat-history";
import { buildStreamHandlers } from "./chat-stream";

function approval(id: string): ApprovalRequest {
  return {
    consequenceSummary: "Send message",
    createdAt: "2026-09-11T00:00:00Z",
    id,
    status: "pending",
    title: "Send WhatsApp",
    tool: "send_whatsapp",
    toolCallId: `call-${id}`,
  };
}

test("consecutive approvals survive one assistant turn and tool starts update the matching card", () => {
  let messages: ChatListItem[] = [
    { content: "", id: "assistant", role: "assistant", streaming: true },
  ];
  const handlers = buildStreamHandlers((update) => {
    messages = typeof update === "function" ? update(messages) : update;
  });
  handlers.onApprovalRequested?.(approval("first"));
  handlers.onApprovalRequested?.(approval("second"));
  handlers.onApprovalRequested?.(approval("second"));
  handlers.onToolStart?.({
    input: { to: "6289500000001" },
    tool: "send_whatsapp",
    toolCallId: "call-first",
  });
  expect(
    messages.flatMap((message) => (message.approval ? [message.approval] : []))
  ).toMatchObject([
    { id: "first", status: "approved" },
    { id: "second", status: "pending" },
  ]);
});
