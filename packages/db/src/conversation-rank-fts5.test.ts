import { describe, expect, test } from "bun:test";
import {
  buildFtsChatYardstickDocuments,
  FTS_CHAT_NEEDLE_CODE,
  FTS_CHAT_QUERY,
  FTS_CHAT_RESULT_LIMIT,
} from "./conversation-fts-yardstick";
import type { ConversationSearchCandidate } from "./conversation-rank-fts5";
import { searchRankedConversations } from "./conversation-rank-fts5";

function asCandidates(): ConversationSearchCandidate[] {
  return buildFtsChatYardstickDocuments().map((document) => ({
    createdAt: document.createdAt,
    messageId: document.messageId,
    profileId: "crafts",
    role: "user",
    sessionId: document.messageId === "fts-needle" ? "prior" : "recent-ops",
    sessionTitle: null,
    text: document.text,
  }));
}

describe("conversation FTS5 ranking", () => {
  test("lexical ranking misses the short needle that FTS surfaces", () => {
    const records = asCandidates();
    const lexical = searchRankedConversations(records, FTS_CHAT_QUERY, {
      fts: false,
      limit: FTS_CHAT_RESULT_LIMIT,
    });
    expect(lexical.some((row) => row.messageId === "fts-needle")).toBe(false);
    expect(
      lexical.every((row) => row.messageId.startsWith("fts-distractor-"))
    ).toBe(true);

    const fts = searchRankedConversations(records, FTS_CHAT_QUERY, {
      fts: true,
      limit: FTS_CHAT_RESULT_LIMIT,
    });
    expect(fts[0]?.messageId).toBe("fts-needle");
    expect(fts[0]?.matchedSnippet).toContain(FTS_CHAT_NEEDLE_CODE);
  });

  test("FTS unavailable falls back to lexical ranking", () => {
    const records = asCandidates();
    const fallback = searchRankedConversations(records, FTS_CHAT_QUERY, {
      fts: true,
      ftsRanks: null,
      limit: FTS_CHAT_RESULT_LIMIT,
    });
    expect(fallback.some((row) => row.messageId === "fts-needle")).toBe(false);
  });
});
