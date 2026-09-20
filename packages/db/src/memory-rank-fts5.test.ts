import { describe, expect, test } from "bun:test";
import { queryMemoryFts5Hits, searchRankedMemories } from "./memory-rank-fts5";
import {
  collapseConflictingMemories,
  memoryConflictSlot,
  type RankableMemoryFact,
} from "./memory-search";

function fact(
  id: string,
  content: string,
  patch: Partial<RankableMemoryFact> = {}
): RankableMemoryFact {
  return {
    content,
    id,
    importance: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("memory FTS5 ranking", () => {
  test("MATCH hits the relevant fact among distractors", () => {
    const records = [
      fact("needle", "The badge code is QUARTZ-WALRUS-19."),
      fact(
        "noise",
        "Warehouse bin 014 holds spare SKU-A014 counted last Tuesday."
      ),
      fact("other", "On-call rotation is posted in the ops channel."),
    ];
    const hits = queryMemoryFts5Hits(
      records,
      "what is the quartz walrus badge code"
    );
    expect(hits?.get("needle")).toBeGreaterThan(0);
    expect(hits?.has("noise") ?? false).toBe(false);

    const ranked = searchRankedMemories(
      records,
      "badge code QUARTZ-WALRUS-19",
      {
        limit: 1,
      }
    );
    expect(ranked.map((item) => item.id)).toEqual(["needle"]);
  });

  test("CJK queries still rank via lexical fallback when FTS tokens are empty", () => {
    const records = [
      fact("han", "仓库交货时间为周四上午。"),
      fact("noise", "Warehouse stationery restock is Friday."),
    ];
    const ranked = searchRankedMemories(records, "请问仓库交货时间是什么？", {
      limit: 1,
    });
    expect(ranked[0]?.id).toBe("han");
  });
});

describe("memory recency conflict collapse", () => {
  test("newer office city wins over a stale MEMORY.md value", () => {
    const stale = fact("stale", "The office city is Berlin.", {
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    const current = fact("current", "The office city is Lisbon.", {
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(memoryConflictSlot(stale)).toBe(memoryConflictSlot(current));
    expect(
      collapseConflictingMemories([stale, current]).map((item) => item.id)
    ).toEqual(["current"]);
    const ranked = searchRankedMemories(
      [stale, current, fact("noise", "Warehouse bin 001 holds tape.")],
      "What city is the office in?",
      { limit: 3 }
    );
    expect(ranked.map((item) => item.id)).toEqual(["current"]);
    expect(ranked[0]?.content).toContain("Lisbon");
  });

  test("independent facts without an is-slot are not collapsed", () => {
    const left = fact("tea", "User prefers tea in the morning.");
    const right = fact("coffee", "User prefers pour-over Ethiopia.");
    expect(collapseConflictingMemories([left, right])).toHaveLength(2);
  });
});
