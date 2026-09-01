import type { StreamHandlers } from "@atlas/client";
import type {
  AgentTodo,
  DocumentAttachment,
  ImageAttachment,
} from "@atlas/core/contract";
import type {
  ChatListItem,
  ChatRetryAttachments,
} from "@/features/chat/chat-items";
import {
  artifactFromStream,
  createChatItemId,
} from "@/features/chat/chat-items";

export function appendOutgoingMessages(
  messages: ChatListItem[],
  text: string,
  attachmentCount = 0,
  retryAttachments?: ChatRetryAttachments
): ChatListItem[] {
  const documents = retryAttachments?.documents?.map((document) => ({
    ...document,
  }));
  const images = retryAttachments?.images?.map((image) => ({ ...image }));

  return [
    ...messages,
    {
      attachmentCount,
      content: text,
      id: createChatItemId(),
      retryAttachments:
        documents?.length || images?.length ? { documents, images } : undefined,
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

function buildFailedAssistantMessage(error: string): ChatListItem {
  return {
    content: error,
    failed: true,
    id: createChatItemId(),
    role: "assistant",
  };
}

/** Converts the active optimistic turn into a stable, retryable failure. */
export function markStreamingTurnFailed(
  messages: ChatListItem[],
  error: string
): ChatListItem[] {
  const failedAssistantIndex = messages.findLastIndex(
    (message) =>
      message.role === "assistant" &&
      Boolean(message.streaming || message.thinkingStreaming)
  );

  const next = messages.map((message, index) => {
    if (message.role === "tool" && message.toolStatus === "running") {
      return {
        ...message,
        content: `${message.tool?.trim() || "Tool"} stopped`,
        toolStatus: "done" as const,
      };
    }

    if (
      message.role === "assistant" &&
      (message.streaming || message.thinkingStreaming)
    ) {
      return {
        ...message,
        ...(index === failedAssistantIndex
          ? { content: error, failed: true }
          : {}),
        streaming: false,
        thinkingStreaming: false,
      };
    }

    return message;
  });

  if (failedAssistantIndex >= 0) {
    return next;
  }

  return next.some((message) => message.role === "user")
    ? [...next, buildFailedAssistantMessage(error)]
    : next;
}

export interface FailedChatTurn {
  error: string;
  text: string;
}

/** Restores a rolled-back text turn without duplicating a persisted prompt. */
export function appendFailedTurnIfNeeded(
  messages: ChatListItem[],
  failedTurn: FailedChatTurn
): ChatListItem[] {
  if (messages.some((message) => message.failed)) {
    return messages;
  }

  const last = messages.at(-1);
  const promptAlreadyPersisted =
    last?.role === "user" && last.content === failedTurn.text;

  return [
    ...messages,
    ...(promptAlreadyPersisted
      ? []
      : [
          {
            content: failedTurn.text,
            id: createChatItemId(),
            role: "user" as const,
          },
        ]),
    buildFailedAssistantMessage(failedTurn.error),
  ];
}

export function findFailedRetryPrompt(
  messages: ChatListItem[],
  failedMessage: ChatListItem
): ChatListItem | null {
  const failedIndex = messages.findIndex(
    (message) => message.id === failedMessage.id
  );

  if (failedIndex < 0) {
    return null;
  }

  return (
    messages
      .slice(0, failedIndex)
      .findLast((message) => message.role === "user") ?? null
  );
}

export type FailedRetryInputResolution =
  | { status: "attachments_unavailable" }
  | { status: "missing" }
  | {
      input: {
        documents?: DocumentAttachment[];
        images?: ImageAttachment[];
        message: string;
      };
      status: "ready";
    };

export function resolveFailedRetryInput(
  prompt: ChatListItem | null
): FailedRetryInputResolution {
  if (!prompt) {
    return { status: "missing" };
  }

  const documents = prompt.retryAttachments?.documents ?? [];
  const images = prompt.retryAttachments?.images ?? [];
  const retainedAttachmentCount = documents.length + images.length;

  if ((prompt.attachmentCount ?? 0) > 0 && retainedAttachmentCount === 0) {
    return { status: "attachments_unavailable" };
  }

  if (!prompt.content.trim() && retainedAttachmentCount === 0) {
    return { status: "missing" };
  }

  return {
    input: {
      documents:
        documents.length > 0
          ? documents.map((document) => ({ ...document }))
          : undefined,
      images:
        images.length > 0 ? images.map((image) => ({ ...image })) : undefined,
      message: prompt.content,
    },
    status: "ready",
  };
}

/** Removes the failed marker and an unpersisted optimistic prompt before retry. */
export function messagesWithoutFailedTurn(
  messages: ChatListItem[],
  failedMessage: ChatListItem
): ChatListItem[] {
  const failedIndex = messages.findIndex(
    (message) => message.id === failedMessage.id
  );

  if (failedIndex < 0) {
    return messages;
  }

  let start = failedIndex;
  const promptIndex = messages
    .slice(0, failedIndex)
    .findLastIndex((message) => message.role === "user");
  const prompt = messages[promptIndex];

  if (prompt && typeof prompt.historyIndex !== "number") {
    start = promptIndex;
  }

  return [...messages.slice(0, start), ...messages.slice(failedIndex + 1)];
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
