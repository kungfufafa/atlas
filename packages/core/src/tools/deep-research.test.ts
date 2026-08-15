import { describe, expect, test } from "bun:test";
import { ResearchEngine } from "../research-engine";
import { deepResearchTool } from "./deep-research";

describe("Research Engine & deep_research Tool", () => {
  test("decomposes topic, gathers evidence, detects contradictions, and synthesizes cited report", async () => {
    const engine = new ResearchEngine();
    const result = await engine.executeResearch(
      "modern vector database indexing algorithms (HNSW vs IVFPQ vs DiskANN)",
      { depth: "standard" }
    );

    expect(result.topic).toContain("vector database");
    expect(result.subQuestions.length).toBeGreaterThanOrEqual(3);
    expect(result.evidence.length).toBeGreaterThanOrEqual(3);
    expect(result.citations.length).toBeGreaterThanOrEqual(3);
    expect(result.contradictions.length).toBeGreaterThan(0);

    // Verify markdown citations format
    expect(result.markdown).toContain("# Research Report:");
    expect(result.markdown).toContain(
      "## Architectural & Algorithm Comparison"
    );
    expect(result.markdown).toContain("## Comparative Tradeoff Matrix");
    expect(result.markdown).toContain(
      "## Contradictions & Divergent Perspectives"
    );
    expect(result.markdown).toContain("## References & Citations");
    expect(result.markdown).toContain("[^1]:");
    expect(result.markdown).toContain("[^2]:");
    expect(result.markdown).toContain("[^3]:");
  });

  test("runs deep_research tool definition cleanly", async () => {
    const output = await deepResearchTool.run(
      {
        depth: "comprehensive",
        focusAreas: ["memory footprint", "query latency"],
        topic: "Vector Search Indexing Tradeoffs",
      },
      {} as any
    );

    expect(output.topic).toBe("Vector Search Indexing Tradeoffs");
    expect(output.citationsCount).toBeGreaterThanOrEqual(3);
    expect(output.evidenceCount).toBeGreaterThanOrEqual(3);
    expect(output.markdownReport).toContain("## Comparative Tradeoff Matrix");
  });
});
