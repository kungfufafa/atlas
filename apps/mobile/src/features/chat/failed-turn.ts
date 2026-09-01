import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FailedChatTurn } from "@/features/chat/chat-stream";

const FAILED_CHAT_TURN_STORAGE_PREFIX = "atlas.mobile.failed-chat-turn.v1";

export interface FailedChatTurnScope {
  orgId: string;
  serverId: string;
  sessionId: string;
}

export function failedChatTurnStorageKey(scope: FailedChatTurnScope): string {
  return `${FAILED_CHAT_TURN_STORAGE_PREFIX}.${encodeURIComponent(scope.serverId)}.${encodeURIComponent(scope.orgId)}.${encodeURIComponent(scope.sessionId)}`;
}

export async function storeFailedChatTurn(
  scope: FailedChatTurnScope,
  turn: FailedChatTurn
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      failedChatTurnStorageKey(scope),
      JSON.stringify({ error: turn.error, text: turn.text })
    );
  } catch {
    // The in-memory failed marker remains retryable when storage is unavailable.
  }
}

export async function readFailedChatTurn(
  scope: FailedChatTurnScope
): Promise<FailedChatTurn | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(failedChatTurnStorageKey(scope));
  } catch {
    return null;
  }

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<FailedChatTurn>;
    const text = typeof parsed.text === "string" ? parsed.text : "";
    const error = typeof parsed.error === "string" ? parsed.error.trim() : "";

    if (!(text.trim() && error)) {
      return null;
    }

    return { error, text };
  } catch {
    return null;
  }
}

export async function clearFailedChatTurn(
  scope: FailedChatTurnScope
): Promise<void> {
  try {
    await AsyncStorage.removeItem(failedChatTurnStorageKey(scope));
  } catch {
    // Nothing else needs clearing when device storage is unavailable.
  }
}
