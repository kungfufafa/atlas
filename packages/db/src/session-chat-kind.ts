export const SESSION_CHAT_KINDS = ["group", "private"] as const;

export type StoredSessionChatKind = (typeof SESSION_CHAT_KINDS)[number];

export function parseStoredChatKind(
  value: unknown
): StoredSessionChatKind | null {
  return value === "group" || value === "private" ? value : null;
}
