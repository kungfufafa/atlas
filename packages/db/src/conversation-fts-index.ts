import type { Database } from "bun:sqlite";
import { readConversationMessagePayload } from "./conversation-keyword-search";
import { ftsMatchTokens } from "./conversation-rank-fts5";
import { normalizeMemoryText } from "./memory-search";

export const CONVERSATION_MESSAGES_FTS_TABLE = "conversation_messages_fts";

export interface ConversationFtsDocument {
  archiveId?: string | null;
  createdAt: string;
  messageId: string;
  role: string;
  sessionId: string;
  text: string;
}

/**
 * Persistent FTS5 index over live session_messages and compacted archives.
 * Ranking still runs only over caller-authorized rows; this table is the
 * Hermes-style session_search corpus and a BM25 score source.
 */
export function migrateConversationMessagesFts(db: Database): void {
  try {
    if (!conversationFtsTableExists(db)) {
      try {
        db.run(
          `CREATE VIRTUAL TABLE ${CONVERSATION_MESSAGES_FTS_TABLE} USING fts5(
            message_id UNINDEXED,
            session_id UNINDEXED,
            archive_id UNINDEXED,
            created_at UNINDEXED,
            role UNINDEXED,
            text,
            tokenize='porter'
          )`
        );
      } catch {
        db.run(
          `CREATE VIRTUAL TABLE ${CONVERSATION_MESSAGES_FTS_TABLE} USING fts5(
            message_id UNINDEXED,
            session_id UNINDEXED,
            archive_id UNINDEXED,
            created_at UNINDEXED,
            role UNINDEXED,
            text
          )`
        );
      }
    }
    backfillConversationMessagesFts(db);
  } catch {
    // FTS5 unavailable: keywords ranking falls back to lexical.
  }
}

export function conversationFtsAvailable(db: Database): boolean {
  return conversationFtsTableExists(db);
}

export function upsertConversationFtsDocument(
  db: Database,
  document: ConversationFtsDocument
): void {
  if (!conversationFtsTableExists(db)) {
    return;
  }
  const archiveId = document.archiveId ?? "";
  try {
    db.prepare(
      `DELETE FROM ${CONVERSATION_MESSAGES_FTS_TABLE}
       WHERE message_id = ? AND session_id = ? AND archive_id = ?`
    ).run(document.messageId, document.sessionId, archiveId);
    db.prepare(
      `INSERT INTO ${CONVERSATION_MESSAGES_FTS_TABLE}
        (message_id, session_id, archive_id, created_at, role, text)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      document.messageId,
      document.sessionId,
      archiveId,
      document.createdAt,
      document.role,
      normalizeMemoryText(document.text)
    );
  } catch {
    // Indexer failures must not block message persistence.
  }
}

export function deleteConversationFtsForSession(
  db: Database,
  sessionId: string
): void {
  if (!conversationFtsTableExists(db)) {
    return;
  }
  db.prepare(
    `DELETE FROM ${CONVERSATION_MESSAGES_FTS_TABLE} WHERE session_id = ?`
  ).run(sessionId);
}

export function deleteLiveConversationFtsForSession(
  db: Database,
  sessionId: string
): void {
  if (!conversationFtsTableExists(db)) {
    return;
  }
  db.prepare(
    `DELETE FROM ${CONVERSATION_MESSAGES_FTS_TABLE}
     WHERE session_id = ? AND archive_id = ''`
  ).run(sessionId);
}

export function indexConversationPayload(
  db: Database,
  input: {
    archiveId?: string | null;
    createdAt: string;
    messageId: string;
    payload: unknown;
    sessionId: string;
  }
): void {
  const parsed = readConversationMessagePayload(input.payload);
  upsertConversationFtsDocument(db, {
    archiveId: input.archiveId,
    createdAt: input.createdAt,
    messageId: input.messageId,
    role: parsed.role,
    sessionId: input.sessionId,
    text: parsed.text,
  });
}

export function queryPersistentConversationFtsRanks(
  db: Database,
  query: string
): Map<string, number> | null {
  if (!conversationFtsTableExists(db)) {
    return null;
  }
  const tokens = ftsMatchTokens(query);
  if (tokens.length === 0) {
    return new Map();
  }
  try {
    const rows = db
      .prepare(
        `SELECT message_id, rank
         FROM ${CONVERSATION_MESSAGES_FTS_TABLE}
         WHERE ${CONVERSATION_MESSAGES_FTS_TABLE} MATCH ?
         ORDER BY rank`
      )
      .all(tokens.join(" OR ")) as Array<{ message_id: string; rank: number }>;
    const hits = new Map<string, number>();
    for (const row of rows) {
      if (!hits.has(row.message_id)) {
        hits.set(row.message_id, row.rank);
      }
    }
    return hits;
  } catch {
    return null;
  }
}

function conversationFtsTableExists(db: Database): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get(CONVERSATION_MESSAGES_FTS_TABLE) as { present: number } | null;
  return Boolean(row);
}

function backfillConversationMessagesFts(db: Database): void {
  if (!conversationFtsTableExists(db)) {
    return;
  }
  const countRow = db
    .prepare(`SELECT COUNT(*) AS count FROM ${CONVERSATION_MESSAGES_FTS_TABLE}`)
    .get() as { count: number };
  if (countRow.count > 0) {
    return;
  }
  const messages = db
    .prepare("SELECT id, session_id, payload, created_at FROM session_messages")
    .all() as Array<{
    created_at: string;
    id: string;
    payload: string;
    session_id: string;
  }>;
  for (const row of messages) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload;
    }
    indexConversationPayload(db, {
      createdAt: row.created_at,
      messageId: row.id,
      payload,
      sessionId: row.session_id,
    });
  }
  const archives = db
    .prepare(
      "SELECT id, session_id, messages, created_at FROM session_history_archives"
    )
    .all() as Array<{
    created_at: string;
    id: string;
    messages: string;
    session_id: string;
  }>;
  for (const archive of archives) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(archive.messages);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) {
      continue;
    }
    for (const [seq, payload] of parsed.entries()) {
      indexConversationPayload(db, {
        archiveId: archive.id,
        createdAt: archive.created_at,
        messageId: `${archive.id}:${seq}`,
        payload,
        sessionId: archive.session_id,
      });
    }
  }
}
