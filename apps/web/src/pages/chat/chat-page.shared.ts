import type { ChatListItem } from "@/lib/chat-history";
import { resolveHistoryProfileId } from "@/lib/chat-history";

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
