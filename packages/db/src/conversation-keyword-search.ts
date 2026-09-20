import {
  memoryResultLimit,
  memoryTermWeight,
  normalizeMemoryText,
  tokenizeMemoryQuery,
} from "./memory-search";
import type { StoredConversationSearchResult } from "./types";

export type ConversationSearchIdentity = Omit<
  StoredConversationSearchResult,
  "matchedSnippet"
>;
type SearchIdentity = ConversationSearchIdentity;
type RankedMatch = { result: StoredConversationSearchResult; score: number };

export function readConversationMessagePayload(payload: unknown): {
  role: string;
  text: string;
} {
  if (typeof payload === "string") {
    return { role: "user", text: payload };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { role: "user", text: JSON.stringify(payload ?? "") };
  }
  const record = payload as Record<string, unknown>;
  return {
    role: typeof record.role === "string" ? record.role : "user",
    text:
      typeof record.content === "string"
        ? record.content
        : JSON.stringify(record.content ?? ""),
  };
}

function compareMatches(left: RankedMatch, right: RankedMatch): number {
  return (
    right.score - left.score ||
    right.result.createdAt.localeCompare(left.result.createdAt) ||
    left.result.sessionId.localeCompare(right.result.sessionId) ||
    left.result.messageId.localeCompare(right.result.messageId)
  );
}

export function conversationMatchSnippet(
  text: string,
  terms: readonly string[]
): string {
  const lower = text.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (index < 0 || found < index)) {
      index = found;
    }
  }
  // NFKC can change character offsets. Preserve the original text rather than
  // invent a source offset when only its normalized spelling matched.
  const start = index < 0 ? 0 : Math.max(0, index - 80);
  const end = Math.min(text.length, start + 240);
  return `${start ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

/** Bounded query/results; callers supply only authorized, deduplicated rows.
 * Ranking scans the eligible history before the result limit. It is lexical
 * retrieval, not semantic search; full history scanning remains linear.
 */
export class ConversationKeywordSearch {
  private readonly terms: string[];
  private readonly limit: number;
  private readonly matches: RankedMatch[] = [];

  constructor(query: string, limit?: number) {
    this.terms = tokenizeMemoryQuery(query);
    this.limit = memoryResultLimit(limit, 20);
  }

  get empty(): boolean {
    return this.terms.length === 0 || this.limit === 0;
  }

  add(identity: SearchIdentity, text: string): void {
    if (this.empty) {
      return;
    }
    const normalized = normalizeMemoryText(text);
    let score = 0;
    for (const term of this.terms) {
      if (normalized.includes(term)) {
        score += memoryTermWeight(term);
      }
    }
    if (score === 0) {
      return;
    }
    const match: RankedMatch = {
      result: {
        ...identity,
        matchedSnippet: conversationMatchSnippet(text, this.terms),
      },
      score,
    };
    let low = 0;
    let high = this.matches.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (compareMatches(match, this.matches[middle]!) < 0) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    if (low < this.limit) {
      this.matches.splice(low, 0, match);
      if (this.matches.length > this.limit) {
        this.matches.pop();
      }
    }
  }

  results(): StoredConversationSearchResult[] {
    return this.matches.map(({ result }) => result);
  }
}
