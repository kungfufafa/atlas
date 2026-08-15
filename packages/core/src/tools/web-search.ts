import { nanoid } from "nanoid";
import { z } from "zod";
import type { ToolDefinition } from "../contract";
import { withDisabledFetchIdle } from "../fetch-idle";
import { jsonSchemaFromZod, requiredTrimmedString } from "./schema";
import {
  calculateTitleSimilarity,
  canonicalizeUrl,
  classifySourceType,
} from "./url-utils";

export const WEB_SEARCH_TOOL_NAME = "web_search";

export const webSearchInputSchema = z
  .object({
    country: z
      .string()
      .optional()
      .describe(
        "Two-letter country code for search results (e.g. 'us', 'id')."
      ),
    domains: z
      .array(z.string())
      .optional()
      .describe(
        "List of allowed domains to include (e.g. ['bun.sh', 'github.com'])."
      ),
    excludeDomains: z
      .array(z.string())
      .optional()
      .describe("List of domains to exclude."),
    language: z
      .string()
      .optional()
      .describe("Language code for search results (e.g. 'en', 'id')."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(5)
      .describe(
        "Maximum number of search results to return (1-20). Defaults to 5."
      ),
    query: requiredTrimmedString("query"),
    recencyDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Filter results published in the last N days."),
  })
  .strict();

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

export interface WebSearchResult {
  domain: string;
  id: string;
  publishedAt?: string;
  score?: number;
  snippet?: string;
  sourceType?: "primary" | "secondary" | "community";
  title: string;
  updatedAt?: string;
  url: string;
}

export interface WebSearchOutput {
  query: string;
  results: WebSearchResult[];
  totalResults: number;
}

export interface PartitionedTools {
  hasWebSearch: boolean;
  localTools: ToolDefinition[];
}

export function partitionTools(tools: ToolDefinition[]): PartitionedTools {
  const localTools = tools.filter((tool) => tool.name !== WEB_SEARCH_TOOL_NAME);

  return {
    hasWebSearch: tools.some((tool) => tool.name === WEB_SEARCH_TOOL_NAME),
    localTools,
  };
}

/**
 * Perform raw search via DuckDuckGo HTML / Lite endpoint with fallbacks.
 */
async function fetchDuckDuckGoResults(
  query: string,
  signal?: AbortSignal
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

  const response = await fetch(
    searchUrl,
    withDisabledFetchIdle({
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal,
    })
  );

  if (!response.ok) {
    throw new Error(`Search provider returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const rawResults: Array<{ title: string; url: string; snippet: string }> = [];

  // Parse results from DuckDuckGo HTML output
  // Result links have class "result__a" and snippets have class "result__snippet"
  const resultRegex =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)/gi;

  let match = resultRegex.exec(html);
  while (match !== null) {
    let rawHref = match[1] ?? "";
    const rawTitle = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();
    const rawSnippet = (match[3] ?? match[4] ?? "")
      .replace(/<[^>]+>/g, "")
      .trim();

    // DuckDuckGo redirects through /l/?uddg=...
    if (rawHref.includes("uddg=")) {
      try {
        const u = new URL(rawHref, "https://html.duckduckgo.com");
        const actual = u.searchParams.get("uddg");
        if (actual) {
          rawHref = decodeURIComponent(actual);
        }
      } catch {
        // keep rawHref
      }
    }

    if (rawHref && rawTitle) {
      rawResults.push({
        snippet: rawSnippet,
        title: rawTitle,
        url: rawHref,
      });
    }
    match = resultRegex.exec(html);
  }

  return rawResults;
}

export function normalizeAndDedupeSearchResults(
  rawResults: Array<{
    title: string;
    url: string;
    snippet?: string;
    publishedAt?: string;
  }>,
  options: {
    domains?: string[];
    excludeDomains?: string[];
    limit?: number;
  } = {}
): WebSearchResult[] {
  const limit = options.limit ?? 5;
  const domainFilter = options.domains?.map((d) => d.toLowerCase().trim());
  const excludeFilter = options.excludeDomains?.map((d) =>
    d.toLowerCase().trim()
  );

  const processed: WebSearchResult[] = [];
  const seenCanonicalUrls = new Set<string>();

  for (const item of rawResults) {
    if (!(item.url && item.title)) {
      continue;
    }

    const canonicalUrl = canonicalizeUrl(item.url);
    if (!canonicalUrl) {
      continue;
    }

    let domain = "";
    try {
      domain = new URL(canonicalUrl).hostname
        .toLowerCase()
        .replace(/^www\./, "");
    } catch {
      continue;
    }

    // Apply domain inclusions
    if (
      domainFilter &&
      domainFilter.length > 0 &&
      !domainFilter.some((d) => domain === d || domain.endsWith(`.${d}`))
    ) {
      continue;
    }

    // Apply domain exclusions
    if (
      excludeFilter &&
      excludeFilter.length > 0 &&
      excludeFilter.some((d) => domain === d || domain.endsWith(`.${d}`))
    ) {
      continue;
    }

    // Check exact canonical URL deduplication
    if (seenCanonicalUrls.has(canonicalUrl)) {
      continue;
    }

    // Check near-identical title deduplication on same domain
    const isNearDuplicate = processed.some(
      (existing) =>
        existing.domain === domain &&
        calculateTitleSimilarity(existing.title, item.title) > 0.75
    );

    if (isNearDuplicate) {
      continue;
    }

    seenCanonicalUrls.add(canonicalUrl);

    const sourceType = classifySourceType(canonicalUrl, domain);
    const score =
      sourceType === "primary" ? 0.95 : sourceType === "secondary" ? 0.8 : 0.65;

    processed.push({
      domain,
      id: `ws_${nanoid(8)}`,
      publishedAt: item.publishedAt,
      score,
      snippet: item.snippet,
      sourceType,
      title: item.title,
      url: canonicalUrl,
    });

    if (processed.length >= limit) {
      break;
    }
  }

  return processed;
}

export const webSearchTool: ToolDefinition<WebSearchInput, WebSearchOutput> = {
  description:
    "Search the web for current, factual information using search queries. Returns canonicalized, deduplicated results with source authority rankings and extracted snippets.",
  name: WEB_SEARCH_TOOL_NAME,
  parallelSafe: true,
  parameters: jsonSchemaFromZod(webSearchInputSchema),
  async run(input, context) {
    const parsed = webSearchInputSchema.parse(input);
    const limit = parsed.limit ?? 5;

    try {
      const rawResults = await fetchDuckDuckGoResults(
        parsed.query,
        context?.signal
      );
      const results = normalizeAndDedupeSearchResults(rawResults, {
        domains: parsed.domains,
        excludeDomains: parsed.excludeDomains,
        limit,
      });

      return {
        query: parsed.query,
        results,
        totalResults: results.length,
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error("web_search was cancelled.");
      }
      throw new Error(`web_search failed: ${(err as Error).message}`);
    }
  },
};
