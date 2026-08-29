import type { StreamHandlers } from "@atlas/client";
import type { AgentTodo } from "@atlas/core/contract";
import type { ChatListItem } from "@/features/chat/chat-items";
import {
  artifactFromStream,
  createChatItemId,
} from "@/features/chat/chat-items";

export function appendOutgoingMessages(
  messages: ChatListItem[],
  text: string,
  attachmentCount = 0
): ChatListItem[] {
  return [
    ...messages,
    {
      attachmentCount,
      content: text,
      id: createChatItemId(),
      role: "user",
    },
    {
      content: "",
      id: createChatItemId(),
      role: "assistant",
      streaming: true,
    },
  ];
}

export function finalizeStreamingMessages(
  messages: ChatListItem[]
): ChatListItem[] {
  return messages.map((message) =>
    message.streaming || message.thinkingStreaming
      ? { ...message, streaming: false, thinkingStreaming: false }
      : message
  );
}

export function buildStreamHandlers(
  setMessages: (updater: (current: ChatListItem[]) => ChatListItem[]) => void,
  options: {
    isCurrent?: () => boolean;
    onRelatedQuestions?: (questions: string[]) => void;
    onTodosUpdated?: (todos: AgentTodo[]) => void;
  } = {}
): StreamHandlers {
  const isCurrent = options.isCurrent ?? (() => true);

  return {
    onApprovalRequested: (approval) => {
      if (!isCurrent()) {
        return;
      }
      setMessages((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (!last) {
          return current;
        }
        next[next.length - 1] = { ...last, approval };
        return next;
      });
    },
    onArtifactCreated: (artifact) => {
      if (!isCurrent()) {
        return;
      }
      setMessages((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (!last) {
          return current;
        }
        next[next.length - 1] = {
          ...last,
          artifacts: [...(last.artifacts ?? []), artifactFromStream(artifact)],
        };
        return next;
      });
    },
    onChunk: (delta) => {
      if (!isCurrent()) {
        return;
      }
      setMessages((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          next[next.length - 1] = {
            ...last,
            content: last.content + delta,
            streaming: true,
            ...(last.thinkingStreaming ? { thinkingStreaming: false } : {}),
          };
          return next;
        }
        next.push({
          content: delta,
          id: createChatItemId(),
          role: "assistant",
          streaming: true,
        });
        return next;
      });
    },
    onRelatedQuestions: (questions) => {
      if (isCurrent()) {
        options.onRelatedQuestions?.(questions);
      }
    },
    onThinking: (delta) => {
      if (!isCurrent()) {
        return;
      }
      setMessages((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          next[next.length - 1] = {
            ...last,
            thinking: `${last.thinking ?? ""}${delta}`,
            thinkingStreaming: true,
          };
          return next;
        }
        next.push({
          content: "",
          id: createChatItemId(),
          role: "assistant",
          streaming: true,
          thinking: delta,
          thinkingStreaming: true,
        });
        return next;
      });
    },
    onTodosUpdated: (todos) => {
      if (isCurrent()) {
        options.onTodosUpdated?.(todos);
      }
    },
    onToolEnd: (event) => {
      if (!isCurrent()) {
        return;
      }
      setMessages((current) =>
        current.map((message) =>
          message.toolCallId === event.toolCallId
            ? {
                ...message,
                content: `${event.tool} completed`,
                toolResult: event.result,
                toolStatus: "done",
              }
            : message
        )
      );
    },
    onToolStart: (event) => {
      if (!isCurrent()) {
        return;
      }
      setMessages((current) => {
        const next = current.map((message) =>
          message.role === "assistant" && message.streaming
            ? { ...message, streaming: false }
            : message
        );
        const existingIndex = next.findIndex(
          (message) => message.toolCallId === event.toolCallId
        );
        const toolMessage: ChatListItem = {
          content: event.tool,
          id: event.toolCallId,
          role: "tool",
          tool: event.tool,
          toolCallId: event.toolCallId,
          toolInput: event.input,
          toolStatus: "running",
        };
        if (existingIndex >= 0) {
          next[existingIndex] = { ...next[existingIndex], ...toolMessage };
          return next;
        }
        return [...next, toolMessage];
      });
    },
  };
}

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
      id: createChatItemId(),
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
