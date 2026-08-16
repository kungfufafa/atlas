import {
  type CitationItem,
  type ContradictionItem,
  deepResearchInputSchema,
  deepResearchTool,
  type EvidenceItem,
  type ProviderClient,
  ResearchEngine,
  type ResearchSynthesis,
  type ToolContext,
  type ToolDefinition,
} from "@atlas/core";
import { webFetchTool } from "@atlas/core/tools/web-fetch";
import { webSearchTool } from "@atlas/core/tools/web-search";

const META_DELIMITER = "<<<ATLAS_RESEARCH_META>>>";

const SYNTHESIS_SYSTEM_PROMPT = [
  "You are a rigorous research analyst. Write a cited research report in Markdown from the provided evidence only.",
  "Rules:",
  "- Ground every claim in the evidence. Cite with footnotes like [^1] matching the numbered sources. Never invent sources, numbers, or quotes.",
  "- Prefer primary sources; note when evidence is thin or conflicting instead of papering over it.",
  "- Include sections: Executive Summary, Key Findings (with inline footnotes), and when evidence disagrees, Contradictions & Divergent Perspectives.",
  "- After the report, output the delimiter line " +
    META_DELIMITER +
    ' followed by a single JSON object: {"summary": string, "contradictions": [{"analysis": string, "claimA": string, "claimB": string, "sourceA": string, "sourceB": string}]}.',
].join("\n");

function buildSynthesisPrompt(input: {
  citations: CitationItem[];
  depth: string;
  evidence: EvidenceItem[];
  focusAreas?: string[];
  subQuestions: string[];
  topic: string;
}): string {
  const depthGuidance =
    input.depth === "brief"
      ? "Keep the report under ~400 words, 2-3 key findings."
      : input.depth === "comprehensive"
        ? "Write a thorough report (~1200+ words) with detailed sections per sub-question."
        : "Write a balanced report (~700 words) with 4-6 key findings.";

  const evidenceLines = input.evidence.map((item) => {
    const cite = input.citations.find((c) => c.url === item.sourceUrl);
    const ref = cite ? ` [^${cite.index}]` : "";
    return [
      `- Source${ref}: ${item.sourceTitle} (${item.publisher ?? "unknown"})`,
      `  URL: ${item.sourceUrl}`,
      `  Evidence: ${(item.snippet || item.claim).replace(/\s+/g, " ").trim().slice(0, 1600)}`,
    ].join("\n");
  });

  const referenceLines = input.citations.map(
    (c) => `- [^${c.index}] ${c.title} — ${c.url}`
  );

  return [
    `Research topic: ${input.topic}`,
    "",
    "Sub-questions to answer:",
    ...input.subQuestions.map((q) => `- ${q}`),
    ...(input.focusAreas?.length
      ? ["", `Focus areas: ${input.focusAreas.join(", ")}`]
      : []),
    "",
    `Depth: ${input.depth}. ${depthGuidance}`,
    "",
    "Evidence (numbered sources):",
    ...evidenceLines,
    "",
    "Reference list:",
    ...referenceLines,
  ].join("\n");
}

function parseSynthesisResponse(
  raw: string
): Pick<ResearchSynthesis, "contradictions" | "summary"> {
  const delimiterIndex = raw.lastIndexOf(META_DELIMITER);
  const markdown =
    delimiterIndex >= 0 ? raw.slice(0, delimiterIndex).trim() : raw.trim();

  let summary = "";
  let contradictions: ContradictionItem[] = [];

  if (delimiterIndex >= 0) {
    const metaRaw = raw.slice(delimiterIndex + META_DELIMITER.length);
    const start = metaRaw.indexOf("{");
    const end = metaRaw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(metaRaw.slice(start, end + 1)) as {
          contradictions?: ContradictionItem[];
          summary?: string;
        };
        if (typeof parsed.summary === "string") {
          summary = parsed.summary;
        }
        if (Array.isArray(parsed.contradictions)) {
          contradictions = parsed.contradictions.filter(
            (item) =>
              item &&
              typeof item.analysis === "string" &&
              typeof item.claimA === "string" &&
              typeof item.claimB === "string"
          );
        }
      } catch {
        // Keep markdown; metadata is optional
      }
    }
  }

  if (!summary) {
    summary = markdown
      .replace(/^#.*$/m, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
  }

  return { contradictions, summary };
}

export interface DeepResearchServerToolOptions {
  /** Resolved lazily per run so provider config changes apply without restart. */
  resolveProvider: () => ProviderClient | null;
}

/**
 * Server override for the builtin deep_research tool: same contract, but the
 * report is synthesized by the workspace LLM instead of the deterministic
 * extract draft, and search/fetch run through the shared builtin tools.
 */
export function createDeepResearchServerTool(
  options: DeepResearchServerToolOptions
): ToolDefinition {
  return {
    ...deepResearchTool,
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
          synthesize: async (synthesisInput) => {
            const provider = options.resolveProvider();
            if (!provider) {
              throw new Error("No LLM provider available for synthesis.");
            }
            const response = await provider.generateText({
              format: "text",
              prompt: buildSynthesisPrompt(synthesisInput),
              system: SYNTHESIS_SYSTEM_PROMPT,
            });
            const meta = parseSynthesisResponse(response.content);
            const delimiterIndex = response.content.lastIndexOf(META_DELIMITER);
            const markdown =
              delimiterIndex >= 0
                ? response.content.slice(0, delimiterIndex).trim()
                : response.content.trim();
            return {
              contradictions: meta.contradictions,
              markdown,
              summary: meta.summary,
            };
          },
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
}
