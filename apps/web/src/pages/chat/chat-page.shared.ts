import type { ChatListItem, FailedChatTurn } from "@/lib/chat-history";
import { resolveHistoryProfileId } from "@/lib/chat-history";
import { createClientId } from "@/lib/client-id";

export function buildChatAttachmentScopeKey(input: {
  draftKey: string;
  orgId?: string | null;
  profileId?: string | null;
  sessionId?: string | null;
}): string {
  return JSON.stringify([
    input.orgId ?? "no-org",
    input.profileId ?? "no-profile",
    input.sessionId ?? `draft:${input.draftKey}`,
  ]);
}

export function shouldResetChatOnWorkspaceChange(
  previousOrgId: string | null | undefined,
  nextOrgId: string | null | undefined
): boolean {
  return Boolean(previousOrgId && nextOrgId && previousOrgId !== nextOrgId);
}

export function isSupersededChatTurn(
  activeGeneration: number,
  turnGeneration: number
): boolean {
  return activeGeneration !== turnGeneration;
}

export function canSelectSessionModel(options: {
  canUpdateExistingSession: boolean;
  hasSession: boolean;
  readOnlySession: boolean;
  workspaceReadOnly: boolean;
}): boolean {
  if (options.readOnlySession || options.workspaceReadOnly) {
    return false;
  }

  return options.hasSession ? options.canUpdateExistingSession : true;
}

export function resolveProfileIdForWorkspaceProfiles(input: {
  currentProfileId: string;
  liveChatProfileId?: string | null;
  profiles: ReadonlyArray<{ id: string }>;
  search: string;
}): string | null {
  if (
    input.currentProfileId &&
    input.profiles.some((profile) => profile.id === input.currentProfileId)
  ) {
    return input.currentProfileId;
  }

  return resolveHistoryProfileId({
    liveChatProfileId: input.liveChatProfileId,
    profiles: input.profiles,
    search: input.search,
  });
}

export function findRetryPrompt(
  messages: ChatListItem[],
  assistantMessage: ChatListItem
): ChatListItem | null {
  if (typeof assistantMessage.historyIndex !== "number") {
    return null;
  }

  return (
    messages.findLast(
      (message) =>
        message.role === "user" &&
        typeof message.historyIndex === "number" &&
        message.historyIndex < assistantMessage.historyIndex!
    ) ?? null
  );
}

export function findRetryCheckpoint(
  messages: ChatListItem[],
  promptMessage: ChatListItem
): ChatListItem | null {
  if (typeof promptMessage.historyIndex !== "number") {
    return null;
  }

  return (
    messages.findLast(
      (message) =>
        typeof message.historyIndex === "number" &&
        message.historyIndex < promptMessage.historyIndex!
    ) ?? null
  );
}

function buildFailedAssistantMessage(error: string): ChatListItem {
  return {
    content: error,
    failed: true,
    id: createClientId(),
    role: "assistant",
  };
}

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
        artifactStreaming: false,
        content: `${message.tool} stopped`,
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

  return next.at(-1)?.role === "user"
    ? [...next, buildFailedAssistantMessage(error)]
    : next;
}

export function appendFailedTurnIfNeeded(
  messages: ChatListItem[],
  failed: FailedChatTurn
): ChatListItem[] {
  if (messages.some((message) => message.failed)) {
    return messages;
  }

  const last = messages.at(-1);
  const failedPromptAlreadyPersisted =
    last?.role === "user" && last.content === failed.text;

  return [
    ...messages,
    ...(failedPromptAlreadyPersisted
      ? []
      : [
          {
            content: failed.text,
            id: createClientId(),
            role: "user" as const,
          },
        ]),
    buildFailedAssistantMessage(failed.error),
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

export type FailedRetryPayloadResolution =
  | { status: "attachments_unavailable" }
  | { status: "missing" }
  | {
      files: NonNullable<ChatListItem["retryFiles"]>;
      status: "ready";
      text: string;
    };

export function resolveFailedRetryPayload(
  prompt: ChatListItem | null
): FailedRetryPayloadResolution {
  if (!prompt) {
    return { status: "missing" };
  }

  const files = prompt.retryFiles ?? [];
  const hasDisplayAttachments = Boolean(
    prompt.images?.length ||
      prompt.imageAttachments?.length ||
      prompt.documents?.length
  );

  if (hasDisplayAttachments && files.length === 0) {
    return { status: "attachments_unavailable" };
  }

  if (!prompt.content.trim() && files.length === 0) {
    return { status: "missing" };
  }

  return {
    files: [...files],
    status: "ready",
    text: prompt.content,
  };
}

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
