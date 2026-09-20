import { Database } from "bun:sqlite";
import {
  ConversationKeywordSearch,
  type ConversationSearchIdentity,
  conversationMatchSnippet,
} from "./conversation-keyword-search";
import {
  memoryResultLimit,
  memoryTermWeight,
  normalizeMemoryText,
  tokenizeMemoryQuery,
} from "./memory-search";
import type { StoredConversationSearchResult } from "./types";

export interface ConversationSearchCandidate
  extends ConversationSearchIdentity {
  text: string;
}

export interface SearchRankedConversationsOptions {
  /** Default true for keywords-mode callers. False keeps weighted lexical ranking. */
  fts?: boolean;
  /** Optional BM25 ranks from a persistent FTS index, keyed by messageId. */
  ftsRanks?: Map<string, number> | null;
  limit?: number;
}

/**
 * Rank authorized conversation messages with FTS5 BM25 + recency, falling
 * back to weighted lexical ranking when FTS is unavailable or disabled.
 * Callers pass only tenant-filtered, deduplicated rows.
 */
export function searchRankedConversations(
  records: readonly ConversationSearchCandidate[],
  query: string,
  options: SearchRankedConversationsOptions = {}
): StoredConversationSearchResult[] {
  const limit = memoryResultLimit(options.limit, 20);
  if (limit === 0) {
    return [];
  }
  const terms = tokenizeMemoryQuery(query);
  if (terms.length === 0) {
    return [];
  }
  if (options.fts === false) {
    return rankConversationsLexically(records, query, limit);
  }

  const ftsRanks =
    options.ftsRanks === undefined
      ? queryConversationFts5Ranks(records, query)
      : options.ftsRanks;
  if (!ftsRanks) {
    return rankConversationsLexically(records, query, limit);
  }

  const ranked: Array<{
    ftsRank: number | null;
    lexicalScore: number;
    record: ConversationSearchCandidate;
  }> = [];
  for (const record of records) {
    const normalized = normalizeMemoryText(record.text);
    let lexicalScore = 0;
    for (const term of terms) {
      if (normalized.includes(term)) {
        lexicalScore += memoryTermWeight(term);
      }
    }
    const ftsRank = ftsRanks.get(record.messageId) ?? null;
    if (lexicalScore === 0 && ftsRank == null) {
      continue;
    }
    ranked.push({ ftsRank, lexicalScore, record });
  }

  ranked.sort((left, right) => {
    const leftHit = left.ftsRank != null;
    const rightHit = right.ftsRank != null;
    if (leftHit !== rightHit) {
      return leftHit ? -1 : 1;
    }
    if (leftHit && rightHit && left.ftsRank !== right.ftsRank) {
      return (left.ftsRank ?? 0) - (right.ftsRank ?? 0);
    }
    return (
      right.lexicalScore - left.lexicalScore ||
      right.record.createdAt.localeCompare(left.record.createdAt) ||
      left.record.sessionId.localeCompare(right.record.sessionId) ||
      left.record.messageId.localeCompare(right.record.messageId)
    );
  });

  return ranked
    .slice(0, limit)
    .map(({ record }) => toSearchResult(record, terms));
}

export function queryConversationFts5Ranks(
  records: readonly ConversationSearchCandidate[],
  query: string
): Map<string, number> | null {
  try {
    return indexConversationsWithFts5(records, query);
  } catch {
    return null;
  }
}

function rankConversationsLexically(
  records: readonly ConversationSearchCandidate[],
  query: string,
  limit: number
): StoredConversationSearchResult[] {
  const search = new ConversationKeywordSearch(query, limit);
  if (search.empty) {
    return [];
  }
  for (const record of records) {
    const { text, ...identity } = record;
    search.add(identity, text);
  }
  return search.results();
}

function toSearchResult(
  record: ConversationSearchCandidate,
  terms: readonly string[]
): StoredConversationSearchResult {
  const { text, ...identity } = record;
  return {
    ...identity,
    matchedSnippet: conversationMatchSnippet(text, terms),
  };
}

function indexConversationsWithFts5(
  records: readonly ConversationSearchCandidate[],
  query: string
): Map<string, number> {
  const hits = new Map<string, number>();
  const tokens = ftsMatchTokens(query);
  if (tokens.length === 0 || records.length === 0) {
    return hits;
  }

  const matchQuery = tokens.join(" OR ");
  const db = new Database(":memory:");
  try {
    createConversationFtsVirtualTable(db, "conversation_fts");
    const insert = db.prepare(
      "INSERT INTO conversation_fts (rowid, text) VALUES (?, ?)"
    );
    const ids: string[] = [];
    for (const [index, record] of records.entries()) {
      ids.push(record.messageId);
      insert.run(index + 1, normalizeMemoryText(record.text));
    }

    const rows = db
      .prepare(
        "SELECT rowid, rank FROM conversation_fts WHERE conversation_fts MATCH ? ORDER BY rank"
      )
      .all(matchQuery) as Array<{ rank: number; rowid: number }>;
    for (const row of rows) {
      const id = ids[row.rowid - 1];
      if (id) {
        hits.set(id, row.rank);
      }
    }
    return hits;
  } finally {
    db.close();
  }
}

export function ftsMatchTokens(query: string): string[] {
  return tokenizeMemoryQuery(query)
    .map((token) => token.replaceAll(/[^a-z0-9-]/g, ""))
    .filter((token) => token.length >= 3);
}

export function createConversationFtsVirtualTable(
  db: Database,
  tableName: string
): void {
  try {
    db.run(
      `CREATE VIRTUAL TABLE ${tableName} USING fts5(text, tokenize='porter')`
    );
  } catch {
    db.run(`CREATE VIRTUAL TABLE ${tableName} USING fts5(text)`);
  }
}
