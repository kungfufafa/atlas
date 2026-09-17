export interface RankableMemoryFact {
  content: string;
  id: string;
  importance?: number;
  subject?: string | null;
  updatedAt: string;
}

const IS_SLOT = /^(?:the\s+)?(.+?)\s+is\s+\S/i;

const MAX_QUERY_CHARS = 4096;
const MAX_TERMS = 16;
const MAX_TERM_CHARS = 128;
const MAX_RESULTS = 200;
const WORDS = new Intl.Segmenter("und", { granularity: "word" });
const HAS_WORD = /[\p{L}\p{N}]/u;
const STOP_WORDS = new Set(
  "a an and are as at be by can do does for from how i in is it me my of on or our please that the their this to was we what when where which who why with you your ada adalah agar aku apa apakah atau bagaimana bagi bahwa berapa bisa buat dalam dan dari dengan di ini itu juga kami kamu ke mengapa mohon pada saya sebagai seperti tolong untuk yang".split(
    " "
  )
);

export function normalizeMemoryText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** Keep literal DB searches literal; arrays opt into bounded lexical matching. */
export function boundedMemoryTerms(
  query: string | readonly string[]
): string[] {
  const values = typeof query === "string" ? [query] : query;
  return [
    ...new Set(
      values
        .slice(0, MAX_TERMS)
        .map((value) =>
          normalizeMemoryText(value.slice(0, MAX_QUERY_CHARS)).trim()
        )
        .filter(Boolean)
    ),
  ];
}

export function tokenizeMemoryQuery(query: string): string[] {
  const normalized = normalizeMemoryText(query.slice(0, MAX_QUERY_CHARS));
  const terms = new Set<string>();
  for (const part of WORDS.segment(normalized)) {
    const term = part.segment;
    if (
      HAS_WORD.test(term) &&
      term.length <= MAX_TERM_CHARS &&
      !STOP_WORDS.has(term)
    ) {
      terms.add(term);
      if (terms.size === MAX_TERMS) {
        break;
      }
    }
  }
  // A punctuation-only search such as '%' is a literal, never a SQL wildcard.
  if (terms.size === 0 && !HAS_WORD.test(normalized)) {
    const literal = normalized.trim();
    return literal ? [literal.slice(0, MAX_TERM_CHARS)] : [];
  }
  return [...terms];
}

export function memoryResultLimit(
  limit: number | undefined,
  fallback: number
): number {
  const value = limit ?? fallback;
  return Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_RESULTS, Math.floor(value)))
    : 0;
}

export function memoryTermWeight(term: string): number {
  return Math.min(4, Math.max(1, Math.ceil([...term].length / 3)));
}

export function memoryMatchScore(
  record: RankableMemoryFact,
  terms: readonly string[]
): number {
  const content = normalizeMemoryText(record.content);
  const subject = normalizeMemoryText(record.subject ?? "");
  let score = 0;
  for (const term of terms) {
    const weight = memoryTermWeight(term);
    score +=
      (content.includes(term) ? weight : 0) +
      (subject.includes(term) ? weight * 2 : 0);
  }
  return score;
}

/**
 * Shared "X is Y" slot so a newer value can replace a stale MEMORY.md line.
 * Subject labels are not a collapse key: independent facts may share a subject.
 */
export function memoryConflictSlot(
  fact: Pick<RankableMemoryFact, "content">
): string | null {
  const match = IS_SLOT.exec(fact.content.trim().replace(/^-\s+/, ""));
  if (!match?.[1]) {
    return null;
  }
  return normalizeMemoryText(match[1]);
}

/**
 * Keep the newest fact per conflict slot. Independent facts without a slot,
 * and distinct slots under one subject label, stay separate.
 */
export function collapseConflictingMemories<T extends RankableMemoryFact>(
  records: readonly T[]
): T[] {
  const chosen = new Map<string, T>();
  const passthrough: T[] = [];
  for (const record of records) {
    const slot = memoryConflictSlot(record);
    if (!slot) {
      passthrough.push(record);
      continue;
    }
    const existing = chosen.get(slot);
    if (
      !existing ||
      record.updatedAt.localeCompare(existing.updatedAt) > 0 ||
      (record.updatedAt === existing.updatedAt &&
        record.id.localeCompare(existing.id) < 0)
    ) {
      chosen.set(slot, record);
    }
  }
  return [...passthrough, ...chosen.values()];
}

export function rankMemoryMatches<T extends RankableMemoryFact>(
  records: T[],
  terms: readonly string[]
): T[] {
  // Confidence is stored evidence, not a default relevance boost. In particular,
  // missing/zero confidence must never be silently promoted to certainty.
  return records
    .map((record) => ({ record, score: memoryMatchScore(record, terms) }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.record.importance ?? 0) - (a.record.importance ?? 0) ||
        b.record.updatedAt.localeCompare(a.record.updatedAt) ||
        a.record.id.localeCompare(b.record.id)
    )
    .map(({ record }) => record);
}
