import { Database } from "bun:sqlite";
import {
  assembleRankedSkills,
  type RankableSkill,
  type RankedSkill,
  rankSkillsForMessage,
  type SkillOutcomeSignal,
  type SkillRanker,
  tokenizeSkillQuery,
} from "@atlas/core";

const FTS_MATCH_SCORE = 2;

/**
 * SQLite FTS5 ranker. Skills are indexed in an in-memory FTS5 virtual table
 * and MATCH hits contribute both retrieval (paraphrase/stem recall) and score.
 * JS BM25 + outcome boost remain the scorer when FTS5 is unavailable.
 */
export function createFts5SkillRanker(): SkillRanker {
  return {
    rank<T extends RankableSkill>(
      skills: T[],
      userMessage: string,
      outcomes: SkillOutcomeSignal[] = []
    ): RankedSkill<T>[] {
      const hits = queryFts5Hits(skills, userMessage);
      if (!hits) {
        return rankSkillsForMessage(skills, userMessage, outcomes);
      }
      return assembleRankedSkills(skills, outcomes, (skill, index) => {
        const js =
          rankSkillsForMessage([skill], userMessage, [])[0]?.score ?? 0;
        const fts = hits.get(index) ?? 0;
        return js + fts;
      });
    },
    retrieve<T extends RankableSkill>(skills: T[], userMessage: string): T[] {
      const hits = queryFts5Hits(skills, userMessage);
      if (!hits) {
        return [];
      }
      return skills.filter((_, index) => hits.has(index));
    },
  };
}

function queryFts5Hits<T extends RankableSkill>(
  skills: T[],
  userMessage: string
): Map<number, number> | null {
  try {
    return indexSkillsWithFts5(skills, userMessage);
  } catch {
    return null;
  }
}

function indexSkillsWithFts5<T extends RankableSkill>(
  skills: T[],
  userMessage: string
): Map<number, number> {
  const hits = new Map<number, number>();
  const tokens = tokenizeSkillQuery(userMessage)
    .map((token) => token.replaceAll(/[^a-z0-9-]/g, ""))
    .filter((token) => token.length >= 3);
  if (tokens.length === 0 || skills.length === 0) {
    return hits;
  }

  const matchQuery = tokens.join(" OR ");
  const db = new Database(":memory:");
  try {
    try {
      db.run(
        "CREATE VIRTUAL TABLE skill_fts USING fts5(name, description, tokenize='porter')"
      );
    } catch {
      db.run("CREATE VIRTUAL TABLE skill_fts USING fts5(name, description)");
    }
    const insert = db.prepare(
      "INSERT INTO skill_fts (rowid, name, description) VALUES (?, ?, ?)"
    );
    for (const [index, skill] of skills.entries()) {
      insert.run(index + 1, skill.name, skill.description);
    }

    const rows = db
      .prepare(
        "SELECT rowid FROM skill_fts WHERE skill_fts MATCH ? ORDER BY rank"
      )
      .all(matchQuery) as Array<{ rowid: number }>;
    for (const row of rows) {
      hits.set(row.rowid - 1, FTS_MATCH_SCORE);
    }
    return hits;
  } finally {
    db.close();
  }
}
