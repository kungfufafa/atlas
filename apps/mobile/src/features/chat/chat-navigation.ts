interface SessionNavigationState {
  activeSessionId?: string;
  currentSessionId?: string;
  isSending: boolean;
}

export function nextSessionIdForNavigation({
  activeSessionId,
  currentSessionId,
  isSending,
}: SessionNavigationState): string | null {
  if (!activeSessionId || activeSessionId === currentSessionId || isSending) {
    return null;
  }
  return activeSessionId;
}
