import { describe, expect, spyOn, test } from "bun:test";
import { AtlasApiError } from "@atlas/core/api-error";
import type { ChatListItem } from "./chat-history";
import {
  createReplayAwareHandlers,
  isActiveTurnConflictError,
  isMissingChatSessionError,
  materializedToolCallIds,
  reconnectActiveSessionStream,
  seedStreamingStateForActiveTurn,
} from "./chat-stream-resume";
import { client } from "./client";

describe("chat-stream-resume", () => {
  test("reconnect binds the subscription and stop identity to the same observed turn", async () => {
    const status = spyOn(client, "getSessionStatus").mockResolvedValue({
      active: true,
      turnId: "current-turn",
    });
    const subscribe = spyOn(client, "subscribeSessionStream").mockResolvedValue(
      {
        reconnected: true,
      }
    );
    const observed: (string | undefined)[] = [];
    try {
      const result = await reconnectActiveSessionStream({
        handlers: { onChunk: () => undefined },
        messages: [],
        onActiveTurn: (turnId) => observed.push(turnId),
        sessionId: "session",
      });
      expect(result.reconnected).toBe(true);
      expect(observed).toEqual(["current-turn"]);
      expect(subscribe.mock.calls[0]?.[2]?.expectedTurnId).toBe("current-turn");
    } finally {
      status.mockRestore();
      subscribe.mockRestore();
    }
  });

  test("materializedToolCallIds collects tool rows", () => {
    const messages: ChatListItem[] = [
      { content: "hi", id: "1", role: "user" },
      {
        content: "bash completed",
        id: "tool_1",
        role: "tool",
        tool: "bash",
        toolCallId: "call_1",
        toolStatus: "done",
      },
    ];

    expect(materializedToolCallIds(messages)).toEqual(new Set(["call_1"]));
  });

  test("seedStreamingStateForActiveTurn appends assistant shell after user message", () => {
    const messages: ChatListItem[] = [{ content: "hi", id: "1", role: "user" }];
    const next = seedStreamingStateForActiveTurn(messages);

    expect(next).toHaveLength(2);
    expect(next[1]?.role).toBe("assistant");
    expect(next[1]?.streaming).toBe(true);
  });

  test("seedStreamingStateForActiveTurn appends assistant shell after tool rows", () => {
    const messages: ChatListItem[] = [
      { content: "run", id: "1", role: "user" },
      {
        content: "bash completed",
        id: "tool_1",
        role: "tool",
        tool: "bash",
        toolCallId: "call_1",
        toolStatus: "running",
      },
    ];
    const next = seedStreamingStateForActiveTurn(messages);

    expect(next.at(-1)?.role).toBe("assistant");
    expect(next.at(-1)?.streaming).toBe(true);
  });

  test("createReplayAwareHandlers skips materialized tool events", () => {
    const seen: string[] = [];
    const handlers = createReplayAwareHandlers(
      {
        onChunk: () => {},
        onToolStart: (event) => {
          seen.push(event.toolCallId);
        },
      },
      new Set(["call_1"])
    );

    handlers.onToolStart?.({
      input: {},
      tool: "bash",
      toolCallId: "call_1",
    });
    handlers.onToolStart?.({
      input: {},
      tool: "bash",
      toolCallId: "call_2",
    });

    expect(seen).toEqual(["call_2"]);
  });

  test("recovery requires HTTP rejection rather than provider error text", () => {
    const conflict = "A response is already in progress for this session.";
    const missing = "Session not found";
    expect(isActiveTurnConflictError(new AtlasApiError(conflict, 409))).toBe(
      true
    );
    expect(isActiveTurnConflictError(new Error(conflict))).toBe(false);
    expect(isActiveTurnConflictError(new AtlasApiError(conflict, 500))).toBe(
      false
    );
    expect(isMissingChatSessionError(new AtlasApiError(missing, 404))).toBe(
      true
    );
    expect(isMissingChatSessionError(new Error(missing))).toBe(false);
    expect(isMissingChatSessionError(new AtlasApiError(missing, 500))).toBe(
      false
    );
  });
});
