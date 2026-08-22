import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { z } from "zod";
import { convertDocumentBytes, resolveAnydocFormat } from "../anydoc-text";
import type { JsonSchema, ToolDefinition } from "../contract";
import { withDisabledFetchIdle } from "../fetch-idle";
import { canonicalizeUrl } from "./url-utils";

export const WEB_FETCH_TOOL_NAME = "web_fetch";

export const webFetchInputSchema = z
  .object({
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 * 1024)
      .optional()
      .describe(
        "Maximum response bytes to download (up to 5MB). Defaults to 1MB."
      ),
    mode: z
      .enum(["article", "raw", "metadata"])
      .optional()
      .describe(
        "Extraction mode: 'article' (default, cleaned Markdown), 'raw' (unmodified text/html), or 'metadata' (metadata and outbound links only)."
      ),
    raw: z
      .boolean()
      .optional()
      .describe(
        "Legacy flag: when true, equivalent to mode='raw'. Defaults to false."
      ),
    url: z
      .string()
      .min(1)
      .url()
      .regex(/^https?:\/\/.+$/i, "url must use http: or https:")
      .describe("Absolute http: or https: URL to fetch."),
  })
  .strict();

export type WebFetchInput = z.infer<typeof webFetchInputSchema>;

export function webFetchParameters(): JsonSchema {
  const { $schema, ...schema } = webFetchInputSchema.toJSONSchema();
  return schema as JsonSchema;
}

export interface WebFetchLink {
  text: string;
  url: string;
}

export interface WebFetchOutput {
  author?: string;
  bytes: number;
  content: string;
  contentType: string;
  description?: string;
  finalUrl: string;
  links?: WebFetchLink[];
  metadata?: Record<string, unknown>;
  publishedAt?: string;
  status: number;
  title?: string;
  truncated: boolean;
  updatedAt?: string;
  url: string;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_CONTENT_CHARS = 16_000;
const TRUNCATION_MARKER = "\n...[truncated]";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_LINKS = 50;

/**
 * Private / reserved address ranges that indicate a local or internal target.
 * Fetching these is blocked to prevent server-side request forgery (SSRF).
 */
const PRIVATE_IPV4_PREFIXES = [
  "0.",
  "10.",
  "100.64.",
  "100.65.",
  "100.66.",
  "100.67.",
  "100.68.",
  "100.69.",
  "100.70.",
  "100.71.",
  "100.72.",
  "100.73.",
  "100.74.",
  "100.75.",
  "100.76.",
  "100.77.",
  "100.78.",
  "100.79.",
  "100.80.",
  "100.81.",
  "100.82.",
  "100.83.",
  "100.84.",
  "100.85.",
  "100.86.",
  "100.87.",
  "100.88.",
  "100.89.",
  "100.90.",
  "100.91.",
  "100.92.",
  "100.93.",
  "100.94.",
  "100.95.",
  "100.96.",
  "100.97.",
  "100.98.",
  "100.99.",
  "100.100.",
  "100.101.",
  "100.102.",
  "100.103.",
  "100.104.",
  "100.105.",
  "100.106.",
  "100.107.",
  "100.108.",
  "100.109.",
  "100.110.",
  "100.111.",
  "100.112.",
  "100.113.",
  "100.114.",
  "100.115.",
  "100.116.",
  "100.117.",
  "100.118.",
  "100.119.",
  "100.120.",
  "100.121.",
  "100.122.",
  "100.123.",
  "100.124.",
  "100.125.",
  "100.126.",
  "100.127.",
  "169.254.",
  "172.16.",
  "172.17.",
  "172.18.",
  "172.19.",
  "172.20.",
  "172.21.",
  "172.22.",
  "172.23.",
  "172.24.",
  "172.25.",
  "172.26.",
  "172.27.",
  "172.28.",
  "172.29.",
  "172.30.",
  "172.31.",
  "192.0.0.",
  "192.0.2.",
  "192.168.",
  "192.88.99.",
  "198.18.",
  "198.19.",
  "203.0.113.",
  "224.",
  "225.",
  "226.",
  "227.",
  "228.",
  "229.",
  "230.",
  "231.",
  "232.",
  "233.",
  "234.",
  "235.",
  "236.",
  "237.",
  "238.",
  "239.",
  "240.",
  "241.",
  "242.",
  "243.",
  "244.",
  "245.",
  "246.",
  "247.",
  "248.",
  "249.",
  "250.",
  "251.",
  "252.",
  "253.",
  "254.",
  "255.",
];

function isPrivateIpv4(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "0.0.0.0" || ip.startsWith("127.")) {
    return true;
  }
  return PRIVATE_IPV4_PREFIXES.some((prefix) => ip.startsWith(prefix));
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fe90:") ||
    normalized.startsWith("fea0:") ||
    normalized.startsWith("feb0:") ||
    normalized.startsWith("fec0:") ||
    normalized.startsWith("::ffff:") ||
    normalized.startsWith("::ffff:0:") ||
    normalized.startsWith("64:ff9b:")
  );
}

function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return isPrivateIpv4(ip);
  }
  if (family === 6) {
    return isPrivateIpv6(ip);
  }
  return true;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  return isPrivateIp(ip);
}

async function assertPublicHostname(hostname: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, "");

  if (isIP(bare)) {
    if (isPrivateIp(bare)) {
      throw new Error(
        `web_fetch blocked: address ${bare} is private or reserved.`
      );
    }
    return;
  }

  let records: { address: string }[];
  try {
    records = await dnsLookup(bare, { all: true });
  } catch (err) {
    throw new Error(
      `web_fetch failed to resolve hostname ${bare}: ${(err as Error).message}`
    );
  }

  if (records.length === 0) {
    throw new Error(
      `web_fetch failed to resolve hostname ${bare}: no records.`
    );
  }

  let privateAddress: string | null = null;

  for (const record of records) {
    if (!isPrivateIp(record.address)) {
      return;
    }
    privateAddress ??= record.address;
  }

  throw new Error(
    `web_fetch blocked: hostname ${bare} resolves to private address ${privateAddress}.`
  );
}

function parseUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("web_fetch: url must be a valid absolute URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `web_fetch: unsupported protocol ${url.protocol} (use http or https).`
    );
  }

  if (!url.hostname) {
    throw new Error("web_fetch: url is missing a hostname.");
  }

  return url;
}

function contentTypeIsHtml(contentType: string): boolean {
  return /text\/html|application\/xhtml\+xml/i.test(contentType ?? "");
}

function contentTypeIsPdfOrDoc(contentType: string, urlStr: string): boolean {
  return (
    /application\/pdf/i.test(contentType) ||
    urlStr.toLowerCase().endsWith(".pdf") ||
    /application\/vnd\.openxmlformats|application\/msword/i.test(contentType)
  );
}

async function fetchWithRedirects(
  url: URL,
  signal: AbortSignal
): Promise<{ response: Response; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(
      current,
      withDisabledFetchIdle({
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
          "user-agent":
            "atlas-web_fetch/1.0 (+https://github.com/kungfufafa/atlas)",
        },
        redirect: "manual",
        signal,
      })
    );

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(
          `web_fetch: redirect ${response.status} without Location header.`
        );
      }
      const nextUrl = new URL(location, current);
      if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
        throw new Error(
          `web_fetch: redirect to unsupported protocol ${nextUrl.protocol}.`
        );
      }
      await assertPublicHostname(nextUrl.hostname);
      current = nextUrl;
      continue;
    }

    return { finalUrl: current.toString(), response };
  }

  throw new Error(`web_fetch: exceeded ${MAX_REDIRECTS} redirects.`);
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(
        `web_fetch: response body exceeds ${maxBytes} bytes (Content-Length: ${declared}).`
      );
    }
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error(`web_fetch: response body exceeds ${maxBytes} bytes.`);
  }

  return { bytes: new Uint8Array(arrayBuffer), truncated: false };
}

export function extractHtmlMetadata(html: string): {
  author?: string;
  description?: string;
  metadata: Record<string, unknown>;
  publishedAt?: string;
  title?: string;
  updatedAt?: string;
} {
  const metadata: Record<string, unknown> = {};

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch
    ? titleMatch[1]?.replace(/<[^>]+>/g, "").trim()
    : undefined;

  const metaTagRegex = /<meta\s+([^>]+)>/gi;
  let description: string | undefined;
  let author: string | undefined;
  let publishedAt: string | undefined;
  let updatedAt: string | undefined;

  let match = metaTagRegex.exec(html);
  while (match !== null) {
    const attrs = match[1] ?? "";
    const nameMatch = /(?:name|property|http-equiv)=["']([^"']+)["']/i.exec(
      attrs
    );
    const contentMatch = /content=["']([^"']*)["']/i.exec(attrs);

    if (nameMatch && contentMatch) {
      const key = nameMatch[1]!.toLowerCase();
      const val = contentMatch[1]!.trim();
      metadata[key] = val;

      if (
        key === "description" ||
        key === "og:description" ||
        key === "twitter:description"
      ) {
        description ??= val;
      }
      if (key === "author" || key === "article:author") {
        author ??= val;
      }
      if (
        key === "article:published_time" ||
        key === "pubdate" ||
        key === "date"
      ) {
        publishedAt ??= val;
      }
      if (key === "article:modified_time" || key === "lastmod") {
        updatedAt ??= val;
      }
    }
    match = metaTagRegex.exec(html);
  }

  return {
    author,
    description,
    metadata,
    publishedAt,
    title,
    updatedAt,
  };
}

export function extractHtmlLinks(
  html: string,
  finalUrl: string,
  maxLinks = MAX_LINKS
): WebFetchLink[] {
  const links: WebFetchLink[] = [];
  const seen = new Set<string>();
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch = linkRegex.exec(html);

  while (linkMatch !== null) {
    const rawHref = linkMatch[1]?.trim();
    const linkText = (linkMatch[2] ?? "").replace(/<[^>]+>/g, "").trim();

    if (
      !rawHref ||
      rawHref.startsWith("#") ||
      rawHref.startsWith("javascript:") ||
      rawHref.startsWith("mailto:")
    ) {
      linkMatch = linkRegex.exec(html);
      continue;
    }

    try {
      const resolved = new URL(rawHref, finalUrl).toString();
      const canonical = canonicalizeUrl(resolved);
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        links.push({
          text: linkText || canonical,
          url: canonical,
        });
      }
    } catch {
      // ignore invalid URLs
    }

    if (links.length >= maxLinks) {
      break;
    }
    linkMatch = linkRegex.exec(html);
  }

  return links;
}

export function cleanHtmlNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "");
}

export async function convertHtmlToMarkdown(html: string): Promise<string> {
  const removeCommentNoise = (value: string) =>
    value.replace(/<!--(?:\[--|\]--|\[|\])?-->/g, "");
  const cleanedHtml = cleanHtmlNoise(html);
  const markdown = String(
    await unified()
      .use(rehypeParse, { fragment: true })
      .use(rehypeRemark)
      .use(remarkGfm)
      .use(remarkStringify, { bullet: "-", fences: true })
      .process(cleanedHtml)
  );
  return removeCommentNoise(markdown)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const webFetchTool: ToolDefinition<WebFetchInput, WebFetchOutput> = {
  description:
    "Fetch a single public HTTP(S) URL and extract research-grade content with metadata and links. HTML pages are cleaned and converted to Markdown. PDFs are extracted automatically.",
  name: WEB_FETCH_TOOL_NAME,
  parallelSafe: true,
  parameters: webFetchParameters(),
  async run(input) {
    let parsed: WebFetchInput;
    try {
      parsed = webFetchInputSchema.parse(input);
    } catch (err) {
      if (err instanceof z.ZodError) {
        const issue = err.issues[0];
        const at =
          issue.path && issue.path.length > 0
            ? ` at ${issue.path.join(".")}`
            : "";
        throw new Error(`web_fetch: invalid parameter${at}: ${issue.message}`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }

    const effectiveMode = parsed.raw ? "raw" : (parsed.mode ?? "article");
    const maxBytes = parsed.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
    const url = parseUrl(parsed.url);
    await assertPublicHostname(url.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const { response, finalUrl } = await fetchWithRedirects(
        url,
        controller.signal
      );

      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `web_fetch failed: HTTP ${response.status} ${response.statusText}.`
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      const { bytes } = await readBoundedBytes(response, maxBytes);
      const totalBytes = bytes.byteLength;

      // Handle PDF / Document
      if (contentTypeIsPdfOrDoc(contentType, finalUrl)) {
        const format = resolveAnydocFormat(finalUrl, contentType);
        const converted = await convertDocumentBytes(bytes, {
          filename: finalUrl.split("/").pop() || "document.pdf",
          format,
          mediaType: contentType,
        });

        let content = converted.text;
        const truncated = content.length > MAX_CONTENT_CHARS;
        if (truncated) {
          content = `${content.slice(0, MAX_CONTENT_CHARS)}${TRUNCATION_MARKER}`;
        }

        return {
          bytes: totalBytes,
          content,
          contentType,
          finalUrl,
          status: response.status,
          title: finalUrl.split("/").pop(),
          truncated,
          url: url.toString(),
        };
      }

      const rawText = new TextDecoder("utf-8").decode(bytes);
      const isHtml =
        contentTypeIsHtml(contentType) && rawText.trimStart().startsWith("<");

      let metaInfo: ReturnType<typeof extractHtmlMetadata> = { metadata: {} };
      let links: WebFetchLink[] | undefined;

      if (isHtml) {
        metaInfo = extractHtmlMetadata(rawText);
        links = extractHtmlLinks(rawText, finalUrl);
      }

      if (effectiveMode === "metadata") {
        return {
          author: metaInfo.author,
          bytes: totalBytes,
          content: "",
          contentType,
          description: metaInfo.description,
          finalUrl,
          links,
          metadata: metaInfo.metadata,
          publishedAt: metaInfo.publishedAt,
          status: response.status,
          title: metaInfo.title,
          truncated: false,
          updatedAt: metaInfo.updatedAt,
          url: url.toString(),
        };
      }

      let content = rawText;
      if (effectiveMode === "article" && isHtml) {
        content = await convertHtmlToMarkdown(rawText);
      }

      const truncated = content.length > MAX_CONTENT_CHARS;
      if (truncated) {
        const keep = Math.max(0, MAX_CONTENT_CHARS - TRUNCATION_MARKER.length);
        content = `${content.slice(0, keep)}${TRUNCATION_MARKER}`;
      }

      return {
        author: metaInfo.author,
        bytes: totalBytes,
        content,
        contentType,
        description: metaInfo.description,
        finalUrl,
        links,
        metadata: metaInfo.metadata,
        publishedAt: metaInfo.publishedAt,
        status: response.status,
        title: metaInfo.title,
        truncated,
        updatedAt: metaInfo.updatedAt,
        url: url.toString(),
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`web_fetch timed out after ${REQUEST_TIMEOUT_MS}ms.`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  },
};
