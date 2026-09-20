import { Database } from "bun:sqlite";
import {
  collapseConflictingMemories,
  memoryMatchScore,
  memoryResultLimit,
  type RankableMemoryFact,
  rankMemoryMatches,
  tokenizeMemoryQuery,
} from "./memory-search";

export interface SearchRankedMemoriesOptions {
  limit?: number;
  resolveConflicts?: boolean;
}

/**
 * Product + eval retrieval: JS lexical score, optional FTS5 MATCH boost,
 * then recency collapse. Callers pass only authorized candidates.
 */
export function searchRankedMemories<T extends RankableMemoryFact>(
  records: readonly T[],
  query: string,
  options: SearchRankedMemoriesOptions = {}
): T[] {
  const limit = memoryResultLimit(options.limit, 20);
  if (limit === 0) {
    return [];
  }
  const terms = tokenizeMemoryQuery(query);
  if (terms.length === 0) {
    return [];
  }
  const ftsHits = queryMemoryFts5Hits(records, query);
  const ranked = [...records]
    .map((record) => ({
      record,
      score: memoryMatchScore(record, terms) + (ftsHits?.get(record.id) ?? 0),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.record.importance ?? 0) - (a.record.importance ?? 0) ||
        b.record.updatedAt.localeCompare(a.record.updatedAt) ||
        a.record.id.localeCompare(b.record.id)
    )
    .map(({ record }) => record);
  const resolved =
    options.resolveConflicts === false
      ? ranked
      : rankMemoryMatches(collapseConflictingMemories(ranked), terms);
  return resolved.slice(0, limit);
}

export const MEMORY_FTS_MATCH_SCORE = 2;

/**
 * In-memory FTS5 ranker over an already-authorized memory candidate set.
 * Mirrors `createFts5SkillRanker`: MATCH hits boost score; JS lexical ranking
 * remains the fallback when FTS5 is unavailable or the query has no FTS tokens.
 */
export function queryMemoryFts5Hits<T extends RankableMemoryFact>(
  records: readonly T[],
  query: string
): Map<string, number> | null {
  try {
    return indexMemoriesWithFts5(records, query);
  } catch {
    return null;
  }
}

function indexMemoriesWithFts5<T extends RankableMemoryFact>(
  records: readonly T[],
  query: string
): Map<string, number> {
  const hits = new Map<string, number>();
  const tokens = tokenizeMemoryQuery(query)
    .map((token) => token.replaceAll(/[^a-z0-9-]/g, ""))
    .filter((token) => token.length >= 3);
  if (tokens.length === 0 || records.length === 0) {
    return hits;
  }

  const matchQuery = tokens.join(" OR ");
  const db = new Database(":memory:");
  try {
    try {
      db.run(
        "CREATE VIRTUAL TABLE memory_fts USING fts5(content, subject, tokenize='porter')"
      );
    } catch {
      db.run("CREATE VIRTUAL TABLE memory_fts USING fts5(content, subject)");
    }
    const insert = db.prepare(
      "INSERT INTO memory_fts (rowid, content, subject) VALUES (?, ?, ?)"
    );
    const ids: string[] = [];
    for (const [index, record] of records.entries()) {
      ids.push(record.id);
      insert.run(index + 1, record.content, record.subject ?? "");
    }

    const rows = db
      .prepare(
        "SELECT rowid FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank"
      )
      .all(matchQuery) as Array<{ rowid: number }>;
    for (const row of rows) {
      const id = ids[row.rowid - 1];
      if (id) {
        hits.set(id, MEMORY_FTS_MATCH_SCORE);
      }
    }
    return hits;
  } finally {
    db.close();
  }
}
