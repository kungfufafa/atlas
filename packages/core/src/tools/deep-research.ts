import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../contract";
import { ResearchEngine } from "../research-engine";
import { jsonSchemaFromZod } from "./schema";
import { webFetchTool } from "./web-fetch";
import { webSearchTool } from "./web-search";

export const deepResearchInputSchema = z.object({
  depth: z
    .enum(["brief", "standard", "comprehensive"])
    .optional()
    .default("standard")
    .describe("Research depth level"),
  focusAreas: z
    .array(z.string())
    .optional()
    .describe("Specific subtopics or comparative angles to prioritize"),
  maxSources: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum unique sources to gather"),
  topic: z
    .string()
    .min(1)
    .describe("The research topic, question, or technology to investigate"),
});

export const deepResearchTool: ToolDefinition = {
  description:
    "Conduct deep research on a complex topic with automated sub-question decomposition, multi-source evidence extraction, tradeoff and contradiction detection, and cited markdown report synthesis with inline footnotes.",
  name: "deep_research",
  parallelSafe: false,
  parameters: jsonSchemaFromZod(deepResearchInputSchema),
  async run(input: unknown, context: ToolContext) {
    const parsed = deepResearchInputSchema.parse(input);
    const engine = new ResearchEngine();
    const result = await engine.executeResearch(
      parsed.topic,
      {
        depth: parsed.depth,
        focusAreas: parsed.focusAreas,
        maxSources: parsed.maxSources,
      },
      {
        web_fetch: (fetchInput) =>
          webFetchTool.run(
            { mode: fetchInput.mode ?? "article", url: fetchInput.url },
            context
          ),
        web_search: (searchInput) =>
          webSearchTool.run(
            { limit: searchInput.limit ?? 4, query: searchInput.query },
            context
          ),
      }
    );

    return {
      citationsCount: result.citations.length,
      contradictionsCount: result.contradictions.length,
      evidenceCount: result.evidence.length,
      markdownReport: result.markdown,
      summary: result.summary,
      topic: result.topic,
    };
  },
};
