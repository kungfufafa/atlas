export const TRACKING_PARAM_PATTERNS = [
  /^utm_/i,
  /^ga_/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^gclsrc$/i,
  /^dclid$/i,
  /^wbraid$/i,
  /^gbraid$/i,
  /^msclkid$/i,
  /^twclid$/i,
  /^igshid$/i,
  /^yclid$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^ref_url$/i,
  /^source$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
  /^__hssc$/i,
  /^__hstc$/i,
  /^hsCtsTracking$/i,
];

export function isTrackingParam(name: string): boolean {
  return TRACKING_PARAM_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Canonicalizes a URL by:
 * - Lowercasing protocol and hostname
 * - Removing default ports (:80, :443)
 * - Stripping tracking query parameters (utm_*, fbclid, gclid, etc.)
 * - Deterministically sorting remaining query parameters
 * - Stripping trailing slash from path (unless it's just '/')
 * - Removing fragments (#...)
 */
export function canonicalizeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") {
    return "";
  }

  let parsed: URL;
  try {
    const trimmed = rawUrl.trim();
    const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    parsed = new URL(withProtocol);
  } catch {
    return rawUrl.trim();
  }

  // Normalize protocol
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return rawUrl.trim();
  }

  // Lowercase hostname
  const hostname = parsed.hostname.toLowerCase();
  // Remove default port
  let port = parsed.port;
  if (
    (protocol === "http:" && port === "80") ||
    (protocol === "https:" && port === "443")
  ) {
    port = "";
  }

  // Normalize pathname
  let pathname = parsed.pathname.toLowerCase();
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  if (!pathname) {
    pathname = "/";
  }

  // Filter and sort query parameters
  const searchParams = new URLSearchParams();
  const sortedKeys = Array.from(parsed.searchParams.keys()).sort();
  for (const key of sortedKeys) {
    if (!isTrackingParam(key)) {
      const values = parsed.searchParams.getAll(key);
      for (const val of values) {
        searchParams.append(key, val);
      }
    }
  }

  const queryStr = searchParams.toString();
  const hostWithPort = port ? `${hostname}:${port}` : hostname;
  return `${protocol}//${hostWithPort}${pathname}${queryStr ? `?${queryStr}` : ""}`;
}

const PRIMARY_SOURCE_DOMAINS = new Set([
  "bun.sh",
  "nodejs.org",
  "python.org",
  "github.com",
  "developer.mozilla.org",
  "w3.org",
  "ietf.org",
  "arxiv.org",
  "microsoft.com",
  "apple.com",
  "google.com",
  "rust-lang.org",
  "golang.org",
  "go.dev",
  "typescriptlang.org",
  "react.dev",
  "vuejs.org",
  "svelte.dev",
  "angular.io",
  "deno.land",
  "deno.com",
  "anthropic.com",
  "openai.com",
]);

const COMMUNITY_SOURCE_DOMAINS = new Set([
  "reddit.com",
  "stackoverflow.com",
  "stackexchange.com",
  "news.ycombinator.com",
  "quora.com",
  "medium.com",
  "dev.to",
  "discord.com",
  "discourse.group",
]);

export function classifySourceType(
  url: string,
  domain: string
): "primary" | "secondary" | "community" {
  const normDomain = domain.toLowerCase().replace(/^www\./, "");

  if (
    normDomain.endsWith(".gov") ||
    normDomain.endsWith(".edu") ||
    normDomain.endsWith(".mil") ||
    PRIMARY_SOURCE_DOMAINS.has(normDomain) ||
    url.includes("/docs") ||
    url.includes("/documentation") ||
    url.includes("/api-reference") ||
    url.includes("/releases") ||
    url.includes("/manual")
  ) {
    return "primary";
  }

  if (
    COMMUNITY_SOURCE_DOMAINS.has(normDomain) ||
    normDomain.startsWith("forum.") ||
    normDomain.startsWith("discuss.") ||
    normDomain.startsWith("community.")
  ) {
    return "community";
  }

  return "secondary";
}

/**
 * Lightweight token Jaccard similarity for title comparison.
 */
export function calculateTitleSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((t) => t.length > 2)
    );

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 || tokensB.size === 0) {
    return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  }

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection += 1;
    }
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
