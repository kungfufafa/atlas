import type { SubscriptionProviderKind } from "@atlas/core";
import { ChatgptSubscriptionRuntime } from "./chatgpt/runtime";
import { ClaudeSubscriptionRuntime } from "./claude/runtime";
import {
  beginSubscriptionSessionDeletion,
  confirmSubscriptionSessionDeletion,
  isMissingSubscriptionSessionError,
  listSubscriptionSessionDeletionCandidates,
  type SubscriptionSessionDeletionCandidate,
} from "./session-store";

const SESSION_DRAIN_TIMEOUT_MS = 10_000;
let chatgptRuntime: ChatgptSubscriptionRuntime | null = null;
let claudeRuntime: ClaudeSubscriptionRuntime | null = null;
const conversationDeletionOperations = new Map<string, Promise<void>>();

export function getChatgptRuntime(): ChatgptSubscriptionRuntime {
  chatgptRuntime ??= new ChatgptSubscriptionRuntime();
  return chatgptRuntime;
}

export function getClaudeRuntime(): ClaudeSubscriptionRuntime {
  claudeRuntime ??= new ClaudeSubscriptionRuntime();
  return claudeRuntime;
}

export function getSubscriptionRuntime(kind: SubscriptionProviderKind) {
  return kind === "chatgpt" ? getChatgptRuntime() : getClaudeRuntime();
}

export function setChatgptRuntimeForTests(
  runtime: ChatgptSubscriptionRuntime | null
): void {
  chatgptRuntime = runtime;
}

export function setClaudeRuntimeForTests(
  runtime: ClaudeSubscriptionRuntime | null
): void {
  claudeRuntime = runtime;
}

export function parseSubscriptionProviderKind(
  value: string | undefined
): SubscriptionProviderKind | null {
  if (value === "chatgpt" || value === "claude") {
    return value;
  }
  return null;
}

export async function deleteSubscriptionConversation(
  conversationId: string
): Promise<void> {
  const existing = conversationDeletionOperations.get(conversationId);
  if (existing) {
    return await existing;
  }

  const operation = performSubscriptionConversationDeletion(conversationId);
  conversationDeletionOperations.set(conversationId, operation);
  try {
    await operation;
  } finally {
    if (conversationDeletionOperations.get(conversationId) === operation) {
      conversationDeletionOperations.delete(conversationId);
    }
  }
}

async function performSubscriptionConversationDeletion(
  conversationId: string
): Promise<void> {
  const barrier = beginSubscriptionSessionDeletion(conversationId);
  try {
    await barrier.waitForIdle(SESSION_DRAIN_TIMEOUT_MS);
    const candidates =
      await listSubscriptionSessionDeletionCandidates(conversationId);
    const failures: Error[] = [];
    for (const candidate of candidates) {
      try {
        await deleteNativeSubscriptionSession(candidate);
        await confirmSubscriptionSessionDeletion(candidate);
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Could not delete every native subscription session. Retry the request."
      );
    }
  } finally {
    barrier.release();
  }
}

export async function deleteNativeSubscriptionSession(
  candidate: SubscriptionSessionDeletionCandidate
): Promise<void> {
  try {
    if (candidate.kind === "chatgpt") {
      await getChatgptRuntime().deleteConversationSession(
        candidate.runtimeSessionId
      );
      return;
    }
    await getClaudeRuntime().deleteConversationSession(
      candidate.runtimeSessionId
    );
  } catch (error) {
    if (isMissingSubscriptionSessionError(error)) {
      return;
    }
    throw error;
  }
}
