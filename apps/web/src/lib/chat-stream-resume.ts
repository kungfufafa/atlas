import type { StreamHandlers } from "@atlas/client";
import { AtlasApiError } from "@atlas/core/api-error";
import { nanoid } from "nanoid";
import type { ChatListItem } from "@/lib/chat-history";
import { client } from "@/lib/client";

export function materializedToolCallIds(messages: ChatListItem[]): Set<string> {
  const ids = new Set<string>();

  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      ids.add(message.toolCallId);
    }
  }

  return ids;
}

export function seedStreamingStateForActiveTurn(
  messages: ChatListItem[]
): ChatListItem[] {
  const last = messages[messages.length - 1];

  if (!last) {
    return messages;
  }

  const needsAssistantShell = last.role === "user" || last.role === "tool";

  if (!needsAssistantShell) {
    return messages;
  }

  if (
    messages.some(
      (message) => message.role === "assistant" && message.streaming
    )
  ) {
    return messages;
  }

  return [
    ...messages,
    {
      content: "",
      id: nanoid(),
      role: "assistant",
      streaming: true,
    },
  ];
}

export function createReplayAwareHandlers(
  handlers: StreamHandlers,
  materializedTools: Set<string>
): StreamHandlers {
  return {
    ...handlers,
    onToolEnd: (event) => {
      if (materializedTools.has(event.toolCallId)) {
        return;
      }

      handlers.onToolEnd?.(event);
    },
    onToolInputDelta: (event) => {
      if (materializedTools.has(event.toolCallId)) {
        return;
      }

      handlers.onToolInputDelta?.(event);
    },
    onToolStart: (event) => {
      if (materializedTools.has(event.toolCallId)) {
        return;
      }

      handlers.onToolStart?.(event);
    },
  };
}

export async function reconnectActiveSessionStream(input: {
  sessionId: string;
  messages: ChatListItem[];
  handlers: StreamHandlers;
  onActiveTurn?: (turnId: string | undefined) => void;
  signal?: AbortSignal;
}): Promise<{ reconnected: boolean }> {
  const status = await client.getSessionStatus(input.sessionId);

  if (!status.active) {
    return { reconnected: false };
  }
  input.onActiveTurn?.(status.turnId);

  const replayHandlers = createReplayAwareHandlers(
    input.handlers,
    materializedToolCallIds(input.messages)
  );

  const result = await client.subscribeSessionStream(
    input.sessionId,
    replayHandlers,
    {
      expectedTurnId: status.turnId,
      signal: input.signal,
    }
  );

  return { reconnected: result.reconnected };
}

export function isActiveTurnConflictError(error: unknown): boolean {
  return (
    error instanceof AtlasApiError &&
    error.status === 409 &&
    error.message.includes("already in progress")
  );
}

export function isMissingChatSessionError(error: unknown): boolean {
  return (
    error instanceof AtlasApiError &&
    error.status === 404 &&
    error.message.includes("Session not found")
  );
}
