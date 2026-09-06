import { isDeepStrictEqual } from "node:util";
import type { AgentChatSession } from "@atlas/agent";
import type { ChatMessage, CompactedHistoryArchive } from "@atlas/core";
import { applyRedactionBoundary, createId } from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";

export function wrapPersistedSession(
  sessionId: string,
  session: AgentChatSession,
  db: DatabaseAdapter,
  options: {
    beforePersist?: () => Promise<void>;
    onBeginTurn?: (
      sessionId: string,
      userMessage: string
    ) => string | undefined;
    onSendRejected?: (
      sessionId: string,
      error: unknown,
      turnId: string | undefined
    ) => Promise<void>;
    onSendResolved?: (sessionId: string, turnId: string | undefined) => void;
    /** Commit resources referenced by completed tool evidence, even if the reply failed. */
    onToolEvidenceRetained?: (
      sessionId: string,
      turnId: string | undefined
    ) => void;
    runTurn?: (
      turnId: string | undefined,
      operation: () => Promise<string>
    ) => Promise<string>;
  } = {}
): AgentChatSession {
  let lastPersistedRevision = session.getHistoryRevision();
  let historyNeedsReplace = false;
  let generation = 0;

  function assertCurrentGeneration(expectedGeneration: number): void {
    if (generation !== expectedGeneration) {
      throw new DOMException(
        "Session was cleared during the operation.",
        "AbortError"
      );
    }
  }

  async function persistCurrentHistory(
    previousLength: number,
    revisionBefore: number,
    expectedGeneration: number
  ): Promise<void> {
    const assertCurrent = () => assertCurrentGeneration(expectedGeneration);
    assertCurrent();
    const archives = [...(session.getPendingHistoryArchives?.() ?? [])];
    if (historyNeedsReplace) {
      await replaceSessionHistory(
        db,
        sessionId,
        session.getHistory(),
        options.beforePersist,
        archives,
        assertCurrent
      );
    } else {
      await persistSessionHistory(
        db,
        sessionId,
        session,
        previousLength,
        revisionBefore,
        lastPersistedRevision,
        options.beforePersist,
        archives,
        assertCurrent
      );
    }
    assertCurrent();
    session.acknowledgeHistoryArchives?.(archives.map((archive) => archive.id));
    lastPersistedRevision = session.getHistoryRevision();
    historyNeedsReplace = false;
  }

  async function persistAfterSend(
    send: () => Promise<string>,
    userMessage: string
  ): Promise<string> {
    const turnGeneration = generation;
    const turnId = options.onBeginTurn?.(sessionId, userMessage);
    const before = session.getHistory().length;
    const revisionBefore = session.getHistoryRevision();
    const historySnapshot = session.getHistory().slice();
    const archiveIdsBefore = new Set(
      session.getPendingHistoryArchives?.().map((archive) => archive.id)
    );
    const retainsNewToolEvidence = () =>
      hasNewCompletedToolEvidence(session.getHistory(), historySnapshot) ||
      session
        .getPendingHistoryArchives?.()
        .some(
          (archive) =>
            !archiveIdsBefore.has(archive.id) &&
            hasNewCompletedToolEvidence(archive.messages, historySnapshot)
        );
    let reply: string;
    try {
      reply = options.runTurn
        ? await options.runTurn(turnId, send)
        : await send();
    } catch (error) {
      if (generation === turnGeneration && retainsNewToolEvidence()) {
        options.onToolEvidenceRetained?.(sessionId, turnId);
        try {
          await persistCurrentHistory(before, revisionBefore, turnGeneration);
        } catch (persistenceError) {
          if (generation !== turnGeneration) {
            await notifySendRejected(
              options.onSendRejected,
              sessionId,
              error,
              turnId
            );
            throw error;
          }
          // The actions already happened. Retain evidence in memory and retry
          // a full replacement next time so it cannot be skipped as an old delta.
          historyNeedsReplace = true;
          const combinedError = new AggregateError(
            [error, persistenceError],
            "The reply failed after tools completed, and their results could not be saved.",
            { cause: error }
          );
          await notifySendRejected(
            options.onSendRejected,
            sessionId,
            combinedError,
            turnId
          );
          throw combinedError;
        }
      }
      await notifySendRejected(
        options.onSendRejected,
        sessionId,
        error,
        turnId
      );
      throw error;
    }
    try {
      await persistCurrentHistory(before, revisionBefore, turnGeneration);
      assertCurrentGeneration(turnGeneration);
    } catch (error) {
      if (generation !== turnGeneration) {
        await notifySendRejected(
          options.onSendRejected,
          sessionId,
          error,
          turnId
        );
        throw error;
      }
      if (retainsNewToolEvidence()) {
        options.onToolEvidenceRetained?.(sessionId, turnId);
        historyNeedsReplace = true;
        await notifySendRejected(
          options.onSendRejected,
          sessionId,
          error,
          turnId
        );
        throw error;
      }
      const history = session.getHistory();
      if (!Array.isArray(history)) {
        throw new Error(
          "Session history cannot be restored after persistence failure.",
          {
            cause: error,
          }
        );
      }
      history.splice(0, history.length, ...historySnapshot);
      await notifySendRejected(
        options.onSendRejected,
        sessionId,
        error,
        turnId
      );
      throw error;
    }
    options.onSendResolved?.(sessionId, turnId);
    return reply;
  }

  return {
    acknowledgeHistoryArchives: (ids) =>
      session.acknowledgeHistoryArchives?.(ids),
    clear() {
      generation += 1;
      session.clear();
      lastPersistedRevision = session.getHistoryRevision();
      historyNeedsReplace = false;
    },
    async compact(compactionOptions) {
      const compactionGeneration = generation;
      const lengthBefore = session.getHistory().length;
      const revisionBefore = session.getHistoryRevision();
      const result = await session.compact(compactionOptions);
      assertCurrentGeneration(compactionGeneration);
      if (
        session.getHistoryRevision() > revisionBefore ||
        session.getPendingHistoryArchives?.().length ||
        historyNeedsReplace
      ) {
        await persistCurrentHistory(
          lengthBefore,
          revisionBefore,
          compactionGeneration
        );
      }
      assertCurrentGeneration(compactionGeneration);
      return result;
    },
    createAutomation: (prompt) => session.createAutomation(prompt),
    getContextUsage: () => session.getContextUsage(),
    getHistory: () => session.getHistory(),
    getHistoryRevision: () => session.getHistoryRevision(),
    getPendingHistoryArchives: () =>
      session.getPendingHistoryArchives?.() ?? [],
    async send(message, sendOptions) {
      return persistAfterSend(
        () => session.send(message, sendOptions),
        readUserMessage(message)
      );
    },
    async sendStream(message, handlers, streamOptions) {
      return persistAfterSend(
        () => session.sendStream(message, handlers, streamOptions),
        readUserMessage(message)
      );
    },
  };
}

function hasNewCompletedToolEvidence(
  history: readonly ChatMessage[],
  before: readonly ChatMessage[]
): boolean {
  let commonPrefix = 0;
  while (
    commonPrefix < history.length &&
    isDeepStrictEqual(history[commonPrefix], before[commonPrefix])
  ) {
    commonPrefix += 1;
  }
  let batchEnd = history.length;
  while (batchEnd > commonPrefix) {
    if (history[batchEnd - 1]?.role !== "tool") {
      batchEnd -= 1;
      continue;
    }
    let assistantIndex = batchEnd - 1;
    while (
      assistantIndex >= commonPrefix &&
      history[assistantIndex]?.role === "tool"
    ) {
      assistantIndex -= 1;
    }
    if (assistantIndex < commonPrefix) {
      return false;
    }
    if (isCompleteToolBatch(history, assistantIndex, batchEnd)) {
      return true;
    }
    batchEnd = assistantIndex;
  }
  return false;
}

function isCompleteToolBatch(
  history: readonly ChatMessage[],
  assistantIndex: number,
  batchEnd: number
): boolean {
  const assistant = history[assistantIndex];
  if (assistant?.role !== "assistant" || !assistant.toolCalls?.length) {
    return false;
  }
  const results = history.slice(assistantIndex + 1, batchEnd);
  if (results.length !== assistant.toolCalls.length) {
    return false;
  }
  const pending = new Map(
    assistant.toolCalls.map((call) => [call.id, call.name])
  );
  if (pending.size !== assistant.toolCalls.length) {
    return false;
  }
  for (const result of results) {
    if (
      result.role !== "tool" ||
      pending.get(result.toolCallId) !== result.name ||
      typeof result.content !== "string"
    ) {
      return false;
    }
    pending.delete(result.toolCallId);
  }
  return pending.size === 0;
}

async function notifySendRejected(
  callback:
    | ((
        sessionId: string,
        error: unknown,
        turnId: string | undefined
      ) => Promise<void>)
    | undefined,
  sessionId: string,
  error: unknown,
  turnId: string | undefined
): Promise<void> {
  try {
    await callback?.(sessionId, error, turnId);
  } catch {
    // Cleanup is compensating work and must not replace the original failure.
  }
}

function readUserMessage(
  input: Parameters<AgentChatSession["send"]>[0]
): string {
  return typeof input === "string" ? input : input.message;
}

export async function loadSessionHistory(
  db: DatabaseAdapter,
  sessionId: string
): Promise<ChatMessage[]> {
  const storedMessages = await db.listMessagesForSession(sessionId);

  return storedMessages.map((record) => record.payload as ChatMessage);
}

export async function replaceSessionHistory(
  db: DatabaseAdapter,
  sessionId: string,
  history: readonly ChatMessage[],
  beforePersist?: () => Promise<void>,
  archives: readonly CompactedHistoryArchive[] = [],
  assertCurrent?: () => void
): Promise<void> {
  const now = new Date().toISOString();
  const messages = history.map((payload, index) => ({
    createdAt: now,
    id: createId("msg"),
    payload: applyRedactionBoundary(payload, "transcript"),
    seq: index,
    sessionId,
  }));

  await beforePersist?.();
  assertCurrent?.();
  await db.replaceMessagesForSession(
    sessionId,
    messages,
    archives.map((archive) => ({
      ...archive,
      messages: archive.messages.map((payload) =>
        applyRedactionBoundary(payload, "transcript")
      ),
      sessionId,
    }))
  );
}

async function persistSessionHistory(
  db: DatabaseAdapter,
  sessionId: string,
  session: AgentChatSession,
  previousLength: number,
  revisionBefore: number,
  lastPersistedRevision: number,
  beforePersist?: () => Promise<void>,
  archives: readonly CompactedHistoryArchive[] = [],
  assertCurrent?: () => void
): Promise<void> {
  const history = session.getHistory();

  if (
    archives.length > 0 ||
    session.getHistoryRevision() > revisionBefore ||
    session.getHistoryRevision() > lastPersistedRevision
  ) {
    await replaceSessionHistory(
      db,
      sessionId,
      history,
      beforePersist,
      archives,
      assertCurrent
    );
    return;
  }

  await persistHistoryDelta(
    db,
    sessionId,
    history,
    previousLength,
    beforePersist,
    assertCurrent
  );
}

async function persistHistoryDelta(
  db: DatabaseAdapter,
  sessionId: string,
  history: readonly ChatMessage[],
  previousLength: number,
  beforePersist?: () => Promise<void>,
  assertCurrent?: () => void
): Promise<void> {
  if (history.length <= previousLength) {
    return;
  }

  const existing = await db.listMessagesForSession(sessionId);
  const nextSeq =
    existing.length > 0
      ? Math.max(...existing.map((record) => record.seq)) + 1
      : 0;
  const now = new Date().toISOString();
  const newMessages = history.slice(previousLength).map((payload, index) => ({
    createdAt: now,
    id: createId("msg"),
    payload: applyRedactionBoundary(payload, "transcript"),
    seq: nextSeq + index,
    sessionId,
  }));

  await beforePersist?.();
  assertCurrent?.();
  await db.appendMessagesForSession(sessionId, newMessages);
}
