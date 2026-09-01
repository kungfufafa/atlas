import type { AgentChatSession } from "@atlas/agent";
import type { ChatMessage } from "@atlas/core";
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
    runTurn?: (
      turnId: string | undefined,
      operation: () => Promise<string>
    ) => Promise<string>;
  } = {}
): AgentChatSession {
  let lastPersistedRevision = session.getHistoryRevision();

  return {
    clear() {
      session.clear();
      lastPersistedRevision = session.getHistoryRevision();
    },
    async compact(compactionOptions) {
      const revisionBefore = session.getHistoryRevision();
      const result = await session.compact(compactionOptions);
      if (session.getHistoryRevision() > revisionBefore) {
        await replaceSessionHistory(
          db,
          sessionId,
          session.getHistory(),
          options.beforePersist
        );
        lastPersistedRevision = session.getHistoryRevision();
      }
      return result;
    },
    createAutomation: (prompt) => session.createAutomation(prompt),
    getContextUsage: () => session.getContextUsage(),
    getHistory: () => session.getHistory(),
    getHistoryRevision: () => session.getHistoryRevision(),
    async send(message, sendOptions) {
      const turnId = options.onBeginTurn?.(sessionId, readUserMessage(message));
      const before = session.getHistory().length;
      const revisionBefore = session.getHistoryRevision();
      let reply: string;
      try {
        const send = () => session.send(message, sendOptions);
        reply = options.runTurn
          ? await options.runTurn(turnId, send)
          : await send();
      } catch (error) {
        await notifySendRejected(
          options.onSendRejected,
          sessionId,
          error,
          turnId
        );
        throw error;
      }
      options.onSendResolved?.(sessionId, turnId);
      await persistSessionHistory(
        db,
        sessionId,
        session,
        before,
        revisionBefore,
        lastPersistedRevision,
        options.beforePersist
      );
      lastPersistedRevision = session.getHistoryRevision();
      return reply;
    },
    async sendStream(message, handlers, streamOptions) {
      const turnId = options.onBeginTurn?.(sessionId, readUserMessage(message));
      const before = session.getHistory().length;
      const revisionBefore = session.getHistoryRevision();
      let reply: string;
      try {
        const send = () => session.sendStream(message, handlers, streamOptions);
        reply = options.runTurn
          ? await options.runTurn(turnId, send)
          : await send();
      } catch (error) {
        await notifySendRejected(
          options.onSendRejected,
          sessionId,
          error,
          turnId
        );
        throw error;
      }
      options.onSendResolved?.(sessionId, turnId);
      await persistSessionHistory(
        db,
        sessionId,
        session,
        before,
        revisionBefore,
        lastPersistedRevision,
        options.beforePersist
      );
      lastPersistedRevision = session.getHistoryRevision();
      return reply;
    },
  };
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
  beforePersist?: () => Promise<void>
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
  await db.replaceMessagesForSession(sessionId, messages);
}

async function persistSessionHistory(
  db: DatabaseAdapter,
  sessionId: string,
  session: AgentChatSession,
  previousLength: number,
  revisionBefore: number,
  lastPersistedRevision: number,
  beforePersist?: () => Promise<void>
): Promise<void> {
  const history = session.getHistory();

  if (
    session.getHistoryRevision() > revisionBefore ||
    session.getHistoryRevision() > lastPersistedRevision
  ) {
    await replaceSessionHistory(db, sessionId, history, beforePersist);
    return;
  }

  await persistHistoryDelta(
    db,
    sessionId,
    history,
    previousLength,
    beforePersist
  );
}

async function persistHistoryDelta(
  db: DatabaseAdapter,
  sessionId: string,
  history: readonly ChatMessage[],
  previousLength: number,
  beforePersist?: () => Promise<void>
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
  await db.appendMessagesForSession(sessionId, newMessages);
}
