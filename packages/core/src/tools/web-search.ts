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

type RawSearchResult = {
  publishedAt?: string;
  snippet?: string;
  title: string;
  url: string;
};

export type WebSearchProviderId = "tavily" | "brave" | "searxng" | "duckduckgo";

const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 200;

const searchCache = new Map<
  string,
  { expiresAt: number; value: WebSearchOutput }
>();

export function clearWebSearchCache(): void {
  searchCache.clear();
}

function readCachedSearch(cacheKey: string): WebSearchOutput | null {
  const entry = searchCache.get(cacheKey);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    searchCache.delete(cacheKey);
    return null;
  }
  return entry.value;
}

function writeCachedSearch(cacheKey: string, value: WebSearchOutput): void {
  if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [key, entry] of searchCache) {
      if (entry.expiresAt <= now) {
        searchCache.delete(key);
      }
    }
    if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
      const oldestKey = searchCache.keys().next().value;
      if (oldestKey !== undefined) {
        searchCache.delete(oldestKey);
      }
    }
  }
  searchCache.set(cacheKey, {
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
    value,
  });
}

/**
 * Picks the strongest configured provider. API-key services (Tavily, Brave)
 * beat self-hosted SearXNG, which beats the unauthenticated DuckDuckGo HTML
 * scrape used as an always-available fallback.
 */
export function resolveWebSearchProvider(
  env: Record<string, string | undefined> = process.env
): WebSearchProviderId {
  if (env.TAVILY_API_KEY) {
    return "tavily";
  }
  if (env.BRAVE_API_KEY) {
    return "brave";
  }
  if (env.SEARXNG_URL) {
    return "searxng";
  }
  return "duckduckgo";
}

type RecencyBucket = "day" | "week" | "month" | "year";

function recencyBucket(days: number): RecencyBucket {
  if (days <= 1) {
    return "day";
  }
  if (days <= 7) {
    return "week";
  }
  if (days <= 30) {
    return "month";
  }
  return "year";
}

function isWithinRecency(
  publishedAt: string | undefined,
  recencyDays: number,
  now = Date.now()
): boolean {
  if (!publishedAt) {
    return true;
  }
  const timestamp = Date.parse(publishedAt);
  if (Number.isNaN(timestamp)) {
    return true;
  }
  return now - timestamp <= recencyDays * 24 * 60 * 60 * 1000;
}

async function fetchTavilyResults(
  query: string,
  options: {
    country?: string;
    env: Record<string, string | undefined>;
    limit: number;
    recencyDays?: number;
    signal?: AbortSignal;
  }
): Promise<RawSearchResult[]> {
  const response = await fetch(
    "https://api.tavily.com/search",
    withDisabledFetchIdle({
      body: JSON.stringify({
        max_results: Math.min(options.limit + 5, 20),
        query,
      }),
      headers: {
        "content-type": "application/json",
        "x-api-key": options.env.TAVILY_API_KEY ?? "",
      },
      method: "POST",
      signal: options.signal,
    })
  );

  if (!response.ok) {
    throw new Error(`Tavily returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    results?: Array<{
      content?: string;
      published_date?: string;
      title?: string;
      url?: string;
    }>;
  };

  return (data.results ?? []).flatMap((item) =>
    item.title && item.url
      ? [
          {
            publishedAt: item.published_date,
            snippet: item.content,
            title: item.title,
            url: item.url,
          },
        ]
      : []
  );
}

async function fetchBraveResults(
  query: string,
  options: {
    country?: string;
    env: Record<string, string | undefined>;
    language?: string;
    limit: number;
    recencyDays?: number;
    signal?: AbortSignal;
  }
): Promise<RawSearchResult[]> {
  const params = new URLSearchParams({ q: query });
  // Fetch extra so post-filter domain/recency rules can still fill the limit.
  params.set("count", String(Math.min(options.limit + 5, 20)));
  if (options.country) {
    params.set("country", options.country);
  }
  if (options.language) {
    params.set("search_lang", options.language);
  }
  if (options.recencyDays) {
    const bucket = recencyBucket(options.recencyDays);
    const freshness = { day: "pd", month: "pm", week: "pw", year: "py" }[
      bucket
    ];
    params.set("freshness", freshness);
  }

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
    withDisabledFetchIdle({
      headers: {
        accept: "application/json",
        "x-subscription-token": options.env.BRAVE_API_KEY ?? "",
      },
      signal: options.signal,
    })
  );

  if (!response.ok) {
    throw new Error(`Brave returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    web?: {
      results?: Array<{
        description?: string;
        page_age?: string;
        title?: string;
        url?: string;
      }>;
    };
  };

  return (data.web?.results ?? []).flatMap((item) =>
    item.title && item.url
      ? [
          {
            publishedAt: item.page_age,
            snippet: item.description
              ? item.description.replace(/<[^>]+>/g, "")
              : undefined,
            title: item.title.replace(/<[^>]+>/g, ""),
            url: item.url,
          },
        ]
      : []
  );
}

async function fetchSearXngResults(
  query: string,
  options: {
    country?: string;
    env: Record<string, string | undefined>;
    language?: string;
    recencyDays?: number;
    signal?: AbortSignal;
  }
): Promise<RawSearchResult[]> {
  const params = new URLSearchParams({
    format: "json",
    q: query,
  });
  const languageParts = [options.language, options.country].filter(
    (part): part is string => Boolean(part)
  );
  if (languageParts.length > 0) {
    params.set("language", languageParts.join("-"));
  }
  if (options.recencyDays) {
    params.set("time_range", recencyBucket(options.recencyDays));
  }

  const baseUrl = (options.env.SEARXNG_URL ?? "").replace(/\/+$/, "");
  const response = await fetch(
    `${baseUrl}/search?${params.toString()}`,
    withDisabledFetchIdle({ signal: options.signal })
  );

  if (!response.ok) {
    throw new Error(`SearXNG returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    results?: Array<{
      content?: string;
      publishedDate?: string;
      title?: string;
      url?: string;
    }>;
  };

  return (data.results ?? []).flatMap((item) =>
    item.title && item.url
      ? [
          {
            publishedAt: item.publishedDate,
            snippet: item.content,
            title: item.title,
            url: item.url,
          },
        ]
      : []
  );
}

/**
 * Perform raw search via DuckDuckGo HTML endpoint with fallbacks.
 */
async function fetchDuckDuckGoResults(
  query: string,
  options: {
    country?: string;
    language?: string;
    recencyDays?: number;
    signal?: AbortSignal;
  } = {}
): Promise<RawSearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (options.country || options.language) {
    params.set("kl", `${options.country || "us"}-${options.language || "en"}`);
  }
  if (options.recencyDays) {
    const bucket = recencyBucket(options.recencyDays);
    params.set("df", { day: "d", month: "m", week: "w", year: "y" }[bucket]);
  }

  const searchUrl = `https://html.duckduckgo.com/html/?${params.toString()}`;

  const response = await fetch(
    searchUrl,
    withDisabledFetchIdle({
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: options.signal,
    })
  );

  if (!response.ok) {
    throw new Error(`Search provider returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const rawResults: RawSearchResult[] = [];

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
    recencyDays?: number;
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

    if (
      options.recencyDays &&
      !isWithinRecency(item.publishedAt, options.recencyDays)
    ) {
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

async function fetchProviderResults(
  parsed: WebSearchInput,
  signal?: AbortSignal
): Promise<RawSearchResult[]> {
  const provider = resolveWebSearchProvider();
  const limit = parsed.limit ?? 5;

  if (provider === "tavily") {
    return fetchTavilyResults(parsed.query, {
      country: parsed.country,
      env: process.env,
      limit,
      recencyDays: parsed.recencyDays,
      signal,
    });
  }

  if (provider === "brave") {
    return fetchBraveResults(parsed.query, {
      country: parsed.country,
      env: process.env,
      language: parsed.language,
      limit,
      recencyDays: parsed.recencyDays,
      signal,
    });
  }

  if (provider === "searxng") {
    return fetchSearXngResults(parsed.query, {
      country: parsed.country,
      env: process.env,
      language: parsed.language,
      recencyDays: parsed.recencyDays,
      signal,
    });
  }

  return fetchDuckDuckGoResults(parsed.query, {
    country: parsed.country,
    language: parsed.language,
    recencyDays: parsed.recencyDays,
    signal,
  });
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

    const cacheKey = JSON.stringify([resolveWebSearchProvider(), parsed]);

    const cached = readCachedSearch(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      let rawResults: RawSearchResult[];
      try {
        rawResults = await fetchProviderResults(parsed, context?.signal);
      } catch (providerError) {
        // Configured providers can fail (quota, network, upstream 5xx);
        // DuckDuckGo stays available without credentials.
        if (resolveWebSearchProvider() === "duckduckgo") {
          throw providerError;
        }
        rawResults = await fetchDuckDuckGoResults(parsed.query, {
          country: parsed.country,
          language: parsed.language,
          recencyDays: parsed.recencyDays,
          signal: context?.signal,
        });
      }

      const results = normalizeAndDedupeSearchResults(rawResults, {
        domains: parsed.domains,
        excludeDomains: parsed.excludeDomains,
        limit,
        recencyDays: parsed.recencyDays,
      });

      const output: WebSearchOutput = {
        query: parsed.query,
        results,
        totalResults: results.length,
      };
      writeCachedSearch(cacheKey, output);
      return output;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error("web_search was cancelled.");
      }
      throw new Error(`web_search failed: ${(err as Error).message}`);
    }
  },
};
