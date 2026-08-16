import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../contract";
import { ResearchEngine } from "../research-engine";
import { deepResearchTool } from "./deep-research";

describe("Research Engine & deep_research Tool", () => {
  test("decomposes the topic and synthesizes a cited report from provided evidence", async () => {
    const engine = new ResearchEngine();
    const result = await engine.executeResearch(
      "modern vector database indexing algorithms",
      { depth: "standard" },
      {
        web_search: async () => ({
          results: [
            {
              domain: "arxiv.org",
              snippet: "HNSW builds multi-layer proximity graphs.",
              title: "HNSW paper",
              url: "https://arxiv.org/abs/1603.09320",
            },
            {
              domain: "hal.inria.fr",
              snippet: "Product quantization compresses vectors.",
              title: "IVFPQ paper",
              url: "https://hal.inria.fr/inria-00514462/document",
            },
            {
              domain: "proceedings.neurips.cc",
              snippet: "DiskANN scales graphs to SSDs.",
              title: "DiskANN paper",
              url: "https://proceedings.neurips.cc/paper/2019/file/09853c7fb1d15db7a18306d642447304-Paper.pdf",
            },
          ],
        }),
      }
    );

    expect(result.topic).toContain("vector database");
    expect(result.subQuestions.length).toBeGreaterThanOrEqual(3);
    expect(result.evidence.length).toBeGreaterThanOrEqual(3);
    expect(result.citations.length).toBeGreaterThanOrEqual(3);

    expect(result.markdown).toContain("# Research Report:");
    expect(result.markdown).toContain("## Key Findings");
    expect(result.markdown).toContain("## References & Citations");
    expect(result.markdown).toContain("[^1]:");
    expect(result.markdown).toContain("[^2]:");
    expect(result.markdown).toContain("[^3]:");
  });

  test("runs the tool offline without fabricating sources", async () => {
    const context = { signal: AbortSignal.abort() } as ToolContext;
    const output = await deepResearchTool.run(
      {
        depth: "brief",
        topic: "Vector Search Indexing Tradeoffs",
      },
      context
    );

    expect(output.topic).toBe("Vector Search Indexing Tradeoffs");
    expect(output.citationsCount).toBe(0);
    expect(output.evidenceCount).toBe(0);
    expect(output.markdownReport).toContain("No sources could be retrieved");
  });
});
