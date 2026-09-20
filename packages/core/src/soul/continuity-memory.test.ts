import { describe, expect, test } from "bun:test";
import {
  composeSoulSystemPrompt,
  composeSoulSystemPromptWithSummary,
} from "./compose";
import {
  ContinuityMemorySummaryCache,
  composeContinuityMemorySection,
  DEFAULT_MEMORY_MD_BYTE_CAP,
  hashContinuityMemoryContent,
  MEMORY_SEARCH_OVERFLOW_HINT,
  parseContinuityMemoryFacts,
  resolveContinuityMemorySummary,
  selectNewestContinuityFacts,
  summarizeContinuityMemoryWithModel,
} from "./continuity-memory";

function bulkyMemory(count: number, needle?: { date: string; text: string }) {
  const lines = ["Continuity facts for this user:"];
  if (needle) {
    lines.push("", `## ${needle.date}`, "", `- ${needle.text}`);
  }
  lines.push("", "## 2026-09-01", "");
  for (let index = 1; index <= count; index += 1) {
    const bin = String(index).padStart(3, "0");
    lines.push(
      `- Warehouse bin ${bin} holds spare SKU-A${bin} counted last Tuesday.`
    );
  }
  return `${lines.join("\n")}\n`;
}

describe("composeContinuityMemorySection", () => {
  test("returns small files unchanged", () => {
    const memory = "The user's nickname is Harbor.\n";
    expect(composeContinuityMemorySection(memory)).toEqual({
      injected: memory,
      omittedCount: 0,
      truncated: false,
    });
  });

  test("null byte cap dumps the whole file", () => {
    const memory = bulkyMemory(400, {
      date: "2024-01-01",
      text: "The overflow code is MANGROVE-DELTA-5.",
    });
    const composed = composeContinuityMemorySection(memory, { byteCap: null });
    expect(composed.truncated).toBe(false);
    expect(composed.injected).toBe(memory);
    expect(composed.injected).toContain("MANGROVE-DELTA-5");
  });

  test("over-cap files drop oldest bullets and keep a retrieval hint", () => {
    const memory = bulkyMemory(400, {
      date: "2024-01-01",
      text: "The overflow code is MANGROVE-DELTA-5.",
    });
    const composed = composeContinuityMemorySection(memory, { byteCap: 2048 });
    expect(composed.truncated).toBe(true);
    expect(composed.omittedCount).toBeGreaterThan(0);
    expect(composed.injected).not.toContain("MANGROVE-DELTA-5");
    expect(composed.injected).toContain(MEMORY_SEARCH_OVERFLOW_HINT);
    expect(composed.injected).toContain("Warehouse bin 400");
    expect(
      new TextEncoder().encode(composed.injected).byteLength
    ).toBeLessThanOrEqual(2048);
  });

  test("uses a provided summary instead of the extractive subset when over cap", () => {
    const memory = bulkyMemory(400, {
      date: "2024-01-01",
      text: "The overflow code is MANGROVE-DELTA-5.",
    });
    const composed = composeContinuityMemorySection(memory, {
      byteCap: 2048,
      summary: "Summary: user prefers Lisbon office.",
    });
    expect(composed.truncated).toBe(true);
    expect(composed.injected).toContain("Summary: user prefers Lisbon office.");
    expect(composed.injected).toContain(MEMORY_SEARCH_OVERFLOW_HINT);
    expect(composed.injected).not.toContain("MANGROVE-DELTA-5");
  });
});

describe("selectNewestContinuityFacts", () => {
  test("squeezes an older durable fact out of a tight extractive budget", () => {
    const memory = bulkyMemory(80, {
      date: "2024-01-01",
      text: "The user's vault passphrase hint is CEDAR-FALCON-7.",
    });
    const selected = selectNewestContinuityFacts(memory, 2048);
    expect(
      selected.omitted.some((fact) => fact.content.includes("CEDAR-FALCON-7"))
    ).toBe(true);
    expect(
      selected.kept.some((fact) => fact.content.includes("CEDAR-FALCON-7"))
    ).toBe(false);
    expect(
      selected.kept.some((fact) => fact.content.includes("Warehouse bin"))
    ).toBe(true);
  });
});

describe("parseContinuityMemoryFacts", () => {
  test("dated bullets carry their section date and preamble lines recency-order later rows", () => {
    const facts = parseContinuityMemoryFacts(
      [
        "Notes",
        "- First preamble fact",
        "- Second preamble fact",
        "",
        "## 2026-09-01",
        "",
        "- Dated fact",
      ].join("\n")
    );
    expect(facts.map((fact) => fact.content)).toEqual([
      "First preamble fact",
      "Second preamble fact",
      "Dated fact",
    ]);
    expect(facts[1]!.updatedAt > facts[0]!.updatedAt).toBe(true);
    expect(facts[2]!.updatedAt).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("composeSoulSystemPrompt memory bounding", () => {
  test("keeps small MEMORY.md identical in the continuity section", () => {
    const memory = "The user's nickname is Harbor.";
    const prompt = composeSoulSystemPrompt({
      directory: "/tmp",
      files: { memory, soul: "You are Atlas." },
      loaded: ["SOUL.md", "MEMORY.md"],
    });
    expect(prompt).toContain("# Continuity (MEMORY.md)");
    expect(prompt).toContain(memory);
    expect(prompt).not.toContain(MEMORY_SEARCH_OVERFLOW_HINT);
  });

  test("omits private memory when includeMemory is false", () => {
    const prompt = composeSoulSystemPrompt(
      {
        directory: "/tmp",
        files: { memory: "SECRET", soul: "Public." },
        loaded: ["SOUL.md", "MEMORY.md"],
      },
      { includeMemory: false }
    );
    expect(prompt).not.toContain("SECRET");
    expect(prompt).not.toContain("# Continuity (MEMORY.md)");
  });
});

describe("summarizeContinuityMemoryWithModel", () => {
  test("returns the model summary and falls back to extractive on empty output", async () => {
    const memory = bulkyMemory(80);
    const summary = await summarizeContinuityMemoryWithModel(
      memory,
      async () => "Kept nickname Harbor."
    );
    expect(summary).toBe("Kept nickname Harbor.");

    const fallback = await summarizeContinuityMemoryWithModel(
      memory,
      async () => "   "
    );
    expect(fallback).toContain("Warehouse bin");
    expect(new TextEncoder().encode(fallback).byteLength).toBeLessThanOrEqual(
      DEFAULT_MEMORY_MD_BYTE_CAP
    );
  });
});

describe("resolveContinuityMemorySummary", () => {
  const needleMemory = bulkyMemory(80, {
    date: "2024-01-01",
    text: "The user's vault passphrase hint is CEDAR-FALCON-7.",
  });

  test("returns undefined when summarization is disabled or no model is provided", async () => {
    const calls: string[] = [];
    expect(
      await resolveContinuityMemorySummary(needleMemory, {
        byteCap: 2048,
        enabled: false,
        generateText: async (prompt) => {
          calls.push(prompt);
          return "should not run";
        },
      })
    ).toBeUndefined();
    expect(
      await resolveContinuityMemorySummary(needleMemory, { byteCap: 2048 })
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("keys the cache by content hash and skips a second model call", async () => {
    const cache = new ContinuityMemorySummaryCache();
    let calls = 0;
    const generateText = async () => {
      calls += 1;
      return "The user's vault passphrase hint is CEDAR-FALCON-7.";
    };
    const first = await resolveContinuityMemorySummary(needleMemory, {
      byteCap: 2048,
      cache,
      generateText,
    });
    const second = await resolveContinuityMemorySummary(needleMemory, {
      byteCap: 2048,
      cache,
      generateText,
    });
    expect(first).toContain("CEDAR-FALCON-7");
    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(hashContinuityMemoryContent(needleMemory)).toHaveLength(64);

    const mutated = `${needleMemory}-changed`;
    await resolveContinuityMemorySummary(mutated, {
      byteCap: 2048,
      cache,
      generateText,
    });
    expect(calls).toBe(2);
  });

  test("falls back to extractive bounding when the model throws", async () => {
    const summary = await resolveContinuityMemorySummary(needleMemory, {
      byteCap: 2048,
      cache: new ContinuityMemorySummaryCache(),
      generateText: async () => {
        throw new Error("provider unavailable");
      },
    });
    expect(summary).toBeUndefined();
    const extractive = composeContinuityMemorySection(needleMemory, {
      byteCap: 2048,
    });
    expect(extractive.injected).not.toContain("CEDAR-FALCON-7");
    expect(extractive.injected).toContain("Warehouse bin");
  });
});

describe("composeSoulSystemPromptWithSummary", () => {
  test("injects the model summary of an omitted fact and keeps recent bullets", async () => {
    const memory = bulkyMemory(80, {
      date: "2024-01-01",
      text: "The user's vault passphrase hint is CEDAR-FALCON-7.",
    });
    let calls = 0;
    const prompt = await composeSoulSystemPromptWithSummary(
      {
        directory: "/tmp",
        files: { memory, soul: "You are Atlas." },
        loaded: ["SOUL.md", "MEMORY.md"],
      },
      {
        generateText: async () => {
          calls += 1;
          return "The user's vault passphrase hint is CEDAR-FALCON-7.";
        },
        memoryByteCap: 2048,
        summaryCache: new ContinuityMemorySummaryCache(),
      }
    );
    expect(calls).toBe(1);
    expect(prompt).toContain("CEDAR-FALCON-7");
    expect(prompt).toContain("Warehouse bin");
    expect(prompt).toContain(MEMORY_SEARCH_OVERFLOW_HINT);

    const extractive = composeSoulSystemPrompt(
      {
        directory: "/tmp",
        files: { memory, soul: "You are Atlas." },
        loaded: ["SOUL.md", "MEMORY.md"],
      },
      { memoryByteCap: 2048 }
    );
    expect(extractive).not.toContain("CEDAR-FALCON-7");
  });
});
