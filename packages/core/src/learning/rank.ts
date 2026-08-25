export interface RankableSkill {
  description: string;
  name: string;
}

export interface SkillOutcomeSignal {
  helpful?: boolean | null;
  skillName: string;
  useCount?: number;
}

export interface RankedSkill<T extends RankableSkill> {
  confidence: number;
  score: number;
  skill: T;
}

export const SKILL_QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "to",
  "when",
  "use",
  "with",
  "user",
  "asks",
  "about",
  "working",
  "files",
  "file",
  "this",
  "that",
  "from",
  "into",
  "are",
  "is",
  "in",
  "on",
  "of",
  "by",
  "as",
  "at",
  "it",
  "be",
  "do",
  "does",
  "help",
  "helps",
  "using",
  "used",
]);

/** Pluggable ranker. JS BM25 is the default; FTS5 adapters implement this. */
export interface SkillRanker {
  rank<T extends RankableSkill>(
    skills: T[],
    userMessage: string,
    outcomes?: SkillOutcomeSignal[]
  ): RankedSkill<T>[];
  /**
   * Extra retrieval hits beyond the lexical matcher (FTS/paraphrase).
   * Default JS ranker does not add recall on its own.
   */
  retrieve?<T extends RankableSkill>(skills: T[], userMessage: string): T[];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((token) => token.length >= 3 && !SKILL_QUERY_STOP_WORDS.has(token));
}

function bm25Score(query: string, document: string): number {
  const queryTokens = tokenize(query);
  const docTokens = tokenize(document);
  if (queryTokens.length === 0 || docTokens.length === 0) {
    return 0;
  }
  const tf = new Map<string, number>();
  for (const token of docTokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  const k1 = 1.2;
  const b = 0.75;
  const avgLen = 32;
  let score = 0;
  for (const token of queryTokens) {
    const freq = tf.get(token) ?? 0;
    if (freq === 0) {
      continue;
    }
    const numerator = freq * (k1 + 1);
    const denominator = freq + k1 * (1 - b + b * (docTokens.length / avgLen));
    score += numerator / denominator;
  }
  return score;
}

export function applySkillOutcomeBoost(
  score: number,
  signal: SkillOutcomeSignal | undefined
): number {
  if (signal?.helpful === true) {
    return score + 1.5 + Math.min(signal.useCount ?? 0, 10) * 0.1;
  }
  if (signal?.helpful === false) {
    return 0;
  }
  return score;
}

export function tokenizeSkillQuery(text: string): string[] {
  return tokenize(text);
}

export function rankSkillsForMessage<T extends RankableSkill>(
  skills: T[],
  userMessage: string,
  outcomes: SkillOutcomeSignal[] = []
): RankedSkill<T>[] {
  return assembleRankedSkills(skills, outcomes, (skill) =>
    bm25Score(userMessage, `${skill.name} ${skill.description}`)
  );
}

export function assembleRankedSkills<T extends RankableSkill>(
  skills: T[],
  outcomes: SkillOutcomeSignal[],
  scoreSkill: (skill: T, index: number) => number
): RankedSkill<T>[] {
  const outcomeByName = new Map<string, SkillOutcomeSignal>();
  for (const outcome of outcomes) {
    outcomeByName.set(outcome.skillName, outcome);
  }

  const ranked: RankedSkill<T>[] = [];
  for (const [index, skill] of skills.entries()) {
    const score = applySkillOutcomeBoost(
      scoreSkill(skill, index),
      outcomeByName.get(skill.name)
    );
    if (score > 0) {
      ranked.push({
        confidence: Math.min(1, score / 8),
        score,
        skill,
      });
    }
  }
  return ranked.sort((left, right) => right.score - left.score);
}

export const jsBm25SkillRanker: SkillRanker = {
  rank: rankSkillsForMessage,
};
