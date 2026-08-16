import { describe, expect, it } from "bun:test";
import {
  ResearchEngine,
  type ResearchTools,
  validateCitationIntegrity,
} from "./research-engine";

function mockTools(overrides: Partial<ResearchTools> = {}): ResearchTools {
  return {
    web_search: async () => ({
      results: [
        {
          domain: "bun.sh",
          snippet: "Bun is a fast all-in-one JavaScript runtime.",
          title: "Bun — Documentation",
          url: "https://bun.sh/docs",
        },
        {
          domain: "example.com",
          snippet: "Comparison of JavaScript runtimes and their tradeoffs.",
          title: "Runtime Comparison",
          url: "https://example.com/runtimes",
        },
      ],
    }),
    ...overrides,
  };
}

describe("Research Engine, Delta Research & Citation Integrity", () => {
  const engine = new ResearchEngine();

  it("Gathers evidence from provided search tools and keeps citation integrity", async () => {
    const result = await engine.executeResearch(
      "JavaScript runtimes",
      {},
      mockTools()
    );

    expect(result.sourcesCount).toBe(2);
    expect(result.evidence.length).toBe(2);
    expect(result.citations[0]?.url).toBe("https://bun.sh/docs");
    expect(result.markdown).toContain("## References & Citations");
    expect(result.markdown).toContain("[^1]:");

    const integrity = validateCitationIntegrity(
      result.structuredCitations || [],
      result.evidence,
      result.sources
    );
    expect(integrity.valid).toBe(true);
  });

  it("Reports honestly when no tools and no evidence are available", async () => {
    const result = await engine.executeResearch("Vector Database Indexing");

    expect(result.sourcesCount).toBe(0);
    expect(result.evidence.length).toBe(0);
    expect(result.markdown).toContain("No sources could be retrieved");

    const integrity = validateCitationIntegrity(
      result.structuredCitations || [],
      result.evidence,
      result.sources
    );
    expect(integrity.valid).toBe(true);
  });

  it("Uses the injected synthesizer for the report and appends missing references", async () => {
    const result = await engine.executeResearch(
      "JavaScript runtimes",
      {},
      mockTools({
        synthesize: async () => ({
          contradictions: [],
          markdown:
            "# Research Report: JavaScript runtimes\n\nBun is fast[^1]. Example compares runtimes[^2].",
          summary: "Synthesized summary.",
        }),
      })
    );

    expect(result.summary).toBe("Synthesized summary.");
    expect(result.markdown).toContain("Bun is fast[^1].");
    // The synthesizer omitted footnote definitions; the engine must add them.
    expect(result.markdown).toContain("[^1]: [Bun — Documentation]");
    expect(result.markdown).toContain("[^2]: [Runtime Comparison]");
  });

  it("Falls back to the extract draft when the synthesizer throws", async () => {
    const result = await engine.executeResearch(
      "JavaScript runtimes",
      {},
      mockTools({
        synthesize: async () => {
          throw new Error("provider unavailable");
        },
      })
    );

    expect(result.summary).toContain("Extract-based research draft");
    expect(result.markdown).toContain("## Key Findings");
  });

  it("Enriches evidence snippets via web_fetch", async () => {
    const result = await engine.executeResearch(
      "JavaScript runtimes",
      { depth: "standard" },
      mockTools({
        web_fetch: async () => ({
          content: "Full article body about Bun's architecture.".repeat(50),
        }),
      })
    );

    const enriched = result.evidence.find(
      (e) => e.sourceUrl === "https://bun.sh/docs"
    );
    expect(enriched?.snippet).toContain("Full article body");
  });

  it("Delta Research: reuses previous evidence, increments revision, and maintains provenance", async () => {
    const tools = mockTools();
    const initialResult = await engine.executeResearch(
      "OpenAI vs Anthropic",
      {},
      tools
    );
    const priorSession = initialResult.researchSession;

    expect(priorSession).toBeDefined();
    if (!priorSession) {
      return;
    }

    const deltaResult = await engine.executeResearch("Add Gemini", {
      focusAreas: ["Gemini multimodal capabilities"],
      priorSession,
    });

    expect(deltaResult.researchSession?.revision).toBe(2);
    expect(deltaResult.researchSession?.parentRevisionId).toBe(priorSession.id);
    expect(deltaResult.evidence.length).toBeGreaterThan(0);

    const integrity = validateCitationIntegrity(
      deltaResult.structuredCitations || [],
      deltaResult.evidence,
      deltaResult.sources
    );
    expect(integrity.valid).toBe(true);
  });

  it("Citation Integrity: catches orphan citations referencing non-existent sources or evidence", () => {
    const badCitation = {
      evidenceIds: ["non-existent-ev-99"],
      id: "cite-bad",
      sourceId: "non-existent-source-99",
    };

    const integrity = validateCitationIntegrity([badCitation], [], []);

    expect(integrity.valid).toBe(false);
    expect(integrity.errors.length).toBeGreaterThan(0);
    expect(integrity.errors.some((e) => e.includes("missing source"))).toBe(
      true
    );
    expect(integrity.errors.some((e) => e.includes("missing evidence"))).toBe(
      true
    );
  });
});
