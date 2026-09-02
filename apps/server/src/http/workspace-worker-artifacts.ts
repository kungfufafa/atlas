import { type ChatMessage, extractSessionArtifacts } from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";

export async function getWorkspaceWorkerSessionArtifactPaths(
  databaseAdapter: DatabaseAdapter,
  sessionId: string
): Promise<Set<string>> {
  const records = await databaseAdapter.listMessagesForSession(sessionId);
  const messages = records
    .map((record) => record.payload)
    .filter(isStoredChatMessage);

  return new Set(
    extractSessionArtifacts(messages).map((artifact) => artifact.path)
  );
}

function isStoredChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null || !("role" in value)) {
    return false;
  }

  const role = (value as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "tool";
}
