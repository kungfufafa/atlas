import type { Citation, ResearchSession, SourceItem } from "./contract";

export interface ResearchOptions {
  depth?: "brief" | "standard" | "comprehensive";
  focusAreas?: string[];
  maxSources?: number;
  priorSession?: ResearchSession;
}

export interface EvidenceItem {
  claim: string;
  id: string;
  publisher?: string;
  relevanceScore: number;
  snippet: string;
  sourceTitle: string;
  sourceUrl: string;
}

export interface ContradictionItem {
  analysis: string;
  claimA: string;
  claimB: string;
  sourceA: string;
  sourceB: string;
}

export interface CitationItem {
  index: number;
  publisher?: string;
  title: string;
  url: string;
}

export interface ResearchResult {
  citations: CitationItem[];
  contradictions: ContradictionItem[];
  depth: string;
  evidence: EvidenceItem[];
  markdown: string;
  researchSession?: ResearchSession;
  sources: SourceItem[];
  sourcesCount: number;
  structuredCitations?: Citation[];
  subQuestions: string[];
  summary: string;
  topic: string;
}

/** Everything an LLM (or any synthesizer) needs to write the final report. */
export interface ResearchSynthesisInput {
  citations: CitationItem[];
  depth: "brief" | "standard" | "comprehensive";
  evidence: EvidenceItem[];
  focusAreas?: string[];
  subQuestions: string[];
  topic: string;
}

export interface ResearchSynthesis {
  contradictions: ContradictionItem[];
  markdown: string;
  summary: string;
}

/**
 * Produces the cited markdown report from gathered evidence. Injected by the
 * host so packages/core stays provider-agnostic; when absent the engine falls
 * back to a deterministic, extract-based draft.
 */
export type SynthesizeReport = (
  input: ResearchSynthesisInput
) => Promise<ResearchSynthesis>;

export interface ResearchTools {
  synthesize?: SynthesizeReport;
  web_fetch?: (input: {
    mode?: "article" | "metadata" | "raw";
    url: string;
  }) => Promise<any>;
  web_search?: (input: { query: string; limit?: number }) => Promise<any>;
}

const DEPTH_QUERY_COUNT: Record<string, number> = {
  brief: 2,
  comprehensive: 4,
  standard: 3,
};

const DEPTH_FETCH_COUNT: Record<string, number> = {
  brief: 0,
  comprehensive: 4,
  standard: 2,
};

const SNIPPET_EXCERPT_CHARS = 1500;

export class ResearchEngine {
  async executeResearch(
    topic: string,
    options: ResearchOptions = {},
    tools?: ResearchTools
  ): Promise<ResearchResult> {
    const depth = options.depth || "standard";
    const maxSources =
      options.maxSources || (depth === "comprehensive" ? 10 : 5);

    // 1. Decompose topic into sub-questions and targeted queries
    const subQuestions = this.generateSubQuestions(topic, options.focusAreas);
    const searchQueries = this.generateSearchQueries(
      topic,
      subQuestions,
      options.focusAreas
    );

    // 2. Multi-source Search & Evidence Gathering (with Delta Research reuse)
    const evidence: EvidenceItem[] = [];
    const citations: CitationItem[] = [];
    const seenUrls = new Set<string>();

    // Delta Research: reuse previous evidence & citations if prior session exists
    if (options.priorSession && Array.isArray(options.priorSession.claims)) {
      for (let idx = 0; idx < options.priorSession.claims.length; idx += 1) {
        const evId =
          options.priorSession.evidenceIds?.[idx] || `ev-prior-${idx + 1}`;
        const sourceId =
          options.priorSession.sourceIds?.[idx] || `source-prior-${idx + 1}`;
        const claimText = String(options.priorSession.claims[idx]);

        evidence.push({
          claim: claimText,
          id: evId,
          publisher: "Prior Research Evidence",
          relevanceScore: 0.95,
          snippet: claimText,
          sourceTitle: `Prior Source ${idx + 1}`,
          sourceUrl: `https://prior-session.atlas/sources/${sourceId}`,
        });

        citations.push({
          index: idx + 1,
          publisher: "Prior Research",
          title: `Prior Source ${idx + 1}`,
          url: `https://prior-session.atlas/sources/${sourceId}`,
        });
        seenUrls.add(`https://prior-session.atlas/sources/${sourceId}`);
      }
    }

    if (tools?.web_search) {
      const queryCount = DEPTH_QUERY_COUNT[depth] ?? 3;
      for (const query of searchQueries.slice(0, queryCount)) {
        if (seenUrls.size >= maxSources) {
          break;
        }
        try {
          const searchRes = await tools.web_search({ limit: 4, query });
          const results = Array.isArray(searchRes?.results)
            ? searchRes.results
            : [];

          for (const res of results) {
            if (
              !res.url ||
              seenUrls.has(res.url) ||
              seenUrls.size >= maxSources
            ) {
              continue;
            }
            seenUrls.add(res.url);

            const citationIndex = citations.length + 1;
            citations.push({
              index: citationIndex,
              publisher: res.domain || safeHostname(res.url),
              title: res.title || `Source ${citationIndex}`,
              url: res.url,
            });

            evidence.push({
              claim: res.snippet || res.title || topic,
              id: `ev-${citationIndex}`,
              publisher: res.domain || safeHostname(res.url),
              relevanceScore: 0.9,
              snippet: res.snippet || "",
              sourceTitle: res.title || `Source ${citationIndex}`,
              sourceUrl: res.url,
            });
          }
        } catch {
          // Continue gathering from remaining queries
        }
      }
    }

    // 3. Evidence enrichment: fetch full page content for the top sources so
    // synthesis is grounded in more than search-result snippets.
    const fetchCount = DEPTH_FETCH_COUNT[depth] ?? 2;
    if (tools?.web_fetch) {
      for (const item of evidence
        .filter((e) => e.id.startsWith("ev-"))
        .slice(0, fetchCount)) {
        try {
          const fetched = await tools.web_fetch({
            mode: "article",
            url: item.sourceUrl,
          });
          const content: string = (fetched?.content ?? fetched?.markdown ?? "")
            .toString()
            .trim();
          if (content) {
            const excerpt = content.slice(0, SNIPPET_EXCERPT_CHARS);
            item.snippet = item.snippet
              ? `${item.snippet}\n\n${excerpt}`
              : excerpt;
          }
        } catch {
          // Snippet-only evidence is still usable
        }
      }
    }

    // 4. Synthesis: LLM-generated when a synthesizer is injected, otherwise a
    // deterministic extract-based draft. Never fabricate sources either way.
    let synthesis: ResearchSynthesis;
    if (tools?.synthesize) {
      try {
        synthesis = await tools.synthesize({
          citations,
          depth,
          evidence,
          focusAreas: options.focusAreas,
          subQuestions,
          topic,
        });
      } catch {
        synthesis = this.buildExtractDraft(topic, depth, evidence, citations);
      }
    } else {
      synthesis = this.buildExtractDraft(topic, depth, evidence, citations);
    }

    // Guardrails: keep references complete even if the synthesizer dropped them.
    synthesis = {
      ...synthesis,
      markdown: this.ensureReferencesSection(synthesis.markdown, citations),
    };

    const sources: SourceItem[] = citations.map((c, i) => {
      let domain = "";
      try {
        domain = new URL(c.url).hostname;
      } catch {
        domain = c.publisher || "";
      }
      return {
        domain,
        id: `source-${c.index}`,
        publisher: c.publisher,
        score: 0.95 - i * 0.05,
        snippet: evidence.find((e) => e.sourceUrl === c.url)?.snippet || "",
        title: c.title,
        type: i === 0 ? "primary" : i === 1 ? "secondary" : "community",
        url: c.url,
      };
    });

    const structuredCitations: Citation[] = citations.map((c) => ({
      evidenceIds: evidence
        .filter((e) => e.sourceUrl === c.url)
        .map((e) => e.id),
      id: `cite-${c.index}`,
      sourceId: `source-${c.index}`,
    }));

    const currentRevision = (options.priorSession as any)?.revision || 1;
    const nextRevision = options.priorSession ? currentRevision + 1 : 1;

    const researchSession: ResearchSession = {
      citationIds: structuredCitations.map((c) => c.id),
      claims: evidence.map((e) => e.claim),
      evidenceIds: evidence.map((e) => e.id),
      id: options.priorSession
        ? `rs_${Date.now()}_v${nextRevision}`
        : `rs_${Date.now()}`,
      parentRevisionId: options.priorSession?.id,
      question: topic,
      revision: nextRevision,
      sourceIds: sources.map((s) => s.id),
      updatedAt: new Date().toISOString(),
    };

    return {
      citations,
      contradictions: synthesis.contradictions,
      depth,
      evidence,
      markdown: synthesis.markdown,
      researchSession,
      sources,
      sourcesCount: citations.length,
      structuredCitations,
      subQuestions,
      summary: synthesis.summary,
      topic,
    };
  }

  private generateSubQuestions(topic: string, focusAreas?: string[]): string[] {
    const questions = [
      `What is ${topic} and why does it matter right now?`,
      `What are the main approaches or perspectives on ${topic}, and how do they compare?`,
      `What are the key tradeoffs, limitations, and open questions around ${topic}?`,
    ];
    if (focusAreas && focusAreas.length > 0) {
      for (const area of focusAreas) {
        questions.push(
          `What is the current state of ${area} in relation to ${topic}?`
        );
      }
    }
    return questions;
  }

  private generateSearchQueries(
    topic: string,
    _subQuestions: string[],
    focusAreas?: string[]
  ): string[] {
    const queries = [
      topic,
      `${topic} overview explained`,
      `${topic} comparison tradeoffs`,
    ];
    for (const area of focusAreas ?? []) {
      queries.push(`${topic} ${area}`);
    }
    return queries;
  }

  private buildExtractDraft(
    topic: string,
    depth: string,
    evidence: EvidenceItem[],
    citations: CitationItem[]
  ): ResearchSynthesis {
    if (evidence.length === 0) {
      return {
        contradictions: [],
        markdown: [
          `# Research Report: ${topic}`,
          "",
          "## Executive Summary",
          "",
          `No sources could be retrieved for **${topic}** during this run, so no findings are reported. Retry, or narrow the topic.`,
          "",
        ].join("\n"),
        summary: `No sources were retrieved for ${topic}.`,
      };
    }

    const lines: string[] = [];
    lines.push(`# Research Report: ${topic}`);
    lines.push("");
    lines.push("## Executive Summary");
    lines.push(
      `Extract-based draft covering ${evidence.length} evidence points from ${citations.length} sources on **${topic}** (${depth} depth, no model synthesis available).`
    );
    lines.push("");
    lines.push("## Key Findings");
    for (const item of evidence) {
      const cite = citations.find((c) => c.url === item.sourceUrl);
      const footnote = cite ? `[^${cite.index}]` : "";
      const snippet = (item.snippet || item.claim).replace(/\s+/g, " ").trim();
      lines.push(`- ${snippet.slice(0, 280)}${footnote}`);
    }
    lines.push("");
    lines.push("## References & Citations");
    for (const cite of citations) {
      const pub = cite.publisher ? ` (${cite.publisher})` : "";
      lines.push(`[^${cite.index}]: [${cite.title}](${cite.url})${pub}`);
    }
    lines.push("");

    return {
      contradictions: [],
      markdown: lines.join("\n"),
      summary: `Extract-based research draft on ${topic} synthesizing ${evidence.length} evidence points across ${citations.length} sources.`,
    };
  }

  /**
   * Footnote definitions are load-bearing: the UI maps [^n] badges to the
   * sources panel. If the synthesizer omitted any, append the canonical list.
   */
  private ensureReferencesSection(
    markdown: string,
    citations: CitationItem[]
  ): string {
    if (citations.length === 0) {
      return markdown;
    }

    const missing = citations.filter(
      (c) => !markdown.includes(`[^${c.index}]:`)
    );
    if (missing.length === 0) {
      return markdown;
    }

    const lines = [markdown.trimEnd(), "", "## References & Citations"];
    for (const cite of missing) {
      const pub = cite.publisher ? ` (${cite.publisher})` : "";
      lines.push(`[^${cite.index}]: [${cite.title}](${cite.url})${pub}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function validateCitationIntegrity(
  citations: Citation[],
  evidence: EvidenceItem[],
  sources: SourceItem[]
): { errors: string[]; valid: boolean } {
  const errors: string[] = [];
  const sourceIdSet = new Set(sources.map((s) => s.id));
  const evidenceIdSet = new Set(evidence.map((e) => e.id));

  for (const cite of citations) {
    if (!sourceIdSet.has(cite.sourceId)) {
      errors.push(
        `Citation ${cite.id} references missing source ${cite.sourceId}`
      );
    }
    for (const evId of cite.evidenceIds) {
      if (!evidenceIdSet.has(evId)) {
        errors.push(`Citation ${cite.id} references missing evidence ${evId}`);
      }
    }
  }

  return {
    errors,
    valid: errors.length === 0,
  };
}
