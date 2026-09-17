import { createHash } from "node:crypto";
import { parseMemoryContent } from "./memory-archive";

/** Default MEMORY.md injection budget. Small files under this cap are unchanged. */
export const DEFAULT_MEMORY_MD_BYTE_CAP = 8192;

export const MEMORY_SEARCH_OVERFLOW_HINT =
  "Use memory_search for omitted, archived, or more recently updated continuity facts; prefer later updatedAt when facts conflict.";

/** Bump when the summarizer prompt changes so cached summaries recompute. */
export const CONTINUITY_MEMORY_SUMMARY_PROMPT_VERSION = "v1";

const DEFAULT_SUMMARY_CACHE_LIMIT = 32;

export type ContinuityMemorySource = "archive" | "live" | "store";

export interface ContinuityMemoryFact {
  content: string;
  id: string;
  importance?: number;
  order: number;
  source: ContinuityMemorySource;
  subject?: string | null;
  updatedAt: string;
}

export interface ComposeContinuityMemoryOptions {
  /** `null` dumps the whole file (legacy / eval ablation). */
  byteCap?: number | null;
  overflowHint?: string;
  /** Precomputed LLM or extractive summary; used only when the file exceeds the cap. */
  summary?: string;
}

export interface ComposedContinuityMemory {
  injected: string;
  omittedCount: number;
  truncated: boolean;
}

export interface ContinuityMemorySummarizer {
  summarize(content: string): Promise<string> | string;
}

export interface ParseContinuityMemoryFactsOptions {
  idPrefix?: string;
}

export interface SelectNewestContinuityFactsResult {
  facts: ContinuityMemoryFact[];
  header: string;
  kept: ContinuityMemoryFact[];
  omitted: ContinuityMemoryFact[];
}

export interface ResolveContinuityMemorySummaryOptions {
  byteCap?: number | null;
  cache?: ContinuityMemorySummaryCache;
  enabled?: boolean;
  generateText?: (prompt: string) => Promise<string>;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function compareFactsNewestFirst(
  left: ContinuityMemoryFact,
  right: ContinuityMemoryFact
): number {
  const byDate = right.updatedAt.localeCompare(left.updatedAt);
  return byDate === 0 ? right.order - left.order : byDate;
}

/**
 * Parse live MEMORY.md into searchable facts. Dated `## YYYY-MM-DD` bullets
 * carry that date; preamble bullets are ordered so later lines are newer.
 */
export function parseContinuityMemoryFacts(
  content: string,
  source: ContinuityMemorySource = "live",
  options: ParseContinuityMemoryFactsOptions = {}
): ContinuityMemoryFact[] {
  const parsed = parseMemoryContent(content);
  const facts: ContinuityMemoryFact[] = [];
  let order = 0;
  const prefix = options.idPrefix ? `${options.idPrefix}:` : "";

  for (const line of parsed.preamble.split("\n")) {
    if (!line.startsWith("- ")) {
      continue;
    }
    facts.push({
      content: line.slice(2),
      id: `${prefix}${source}-preamble-${order}`,
      order,
      source,
      updatedAt: new Date(order).toISOString(),
    });
    order += 1;
  }

  for (const section of parsed.sections) {
    for (const bullet of section.bullets) {
      facts.push({
        content: bullet,
        id: `${prefix}${source}-${section.date}-${order}`,
        order,
        source,
        updatedAt: `${section.date}T00:00:00.000Z`,
      });
      order += 1;
    }
  }

  return facts;
}

export function continuityMemoryHeader(content: string): string {
  const lines: string[] = [];
  for (const line of content.split("\n")) {
    if (line.startsWith("- ") || /^## \d{4}-\d{2}-\d{2}$/.test(line)) {
      break;
    }
    lines.push(line);
  }
  return lines.join("\n").replace(/\n+$/, "");
}

function renderContinuitySubset(
  header: string,
  facts: readonly ContinuityMemoryFact[]
): string {
  const selected = [...facts].sort((left, right) => left.order - right.order);
  const lines: string[] = [];
  if (header.trim()) {
    lines.push(header, "");
  }
  for (const fact of selected) {
    lines.push(`- ${fact.content}`);
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function renderSummaryWithRecentFacts(input: {
  budget: number;
  header: string;
  hintBlock: string;
  recent: readonly ContinuityMemoryFact[];
  summary: string;
}): string | null {
  const summaryBody = input.summary.replace(/\n+$/, "");
  const kept: ContinuityMemoryFact[] = [];
  for (const fact of input.recent) {
    if (summaryBody.includes(fact.content)) {
      continue;
    }
    const candidate = renderOverCapInjection({
      facts: [...kept, fact],
      header: input.header,
      hintBlock: input.hintBlock,
      summary: summaryBody,
    });
    const limit = input.budget + utf8ByteLength(input.hintBlock);
    if (utf8ByteLength(candidate) > limit) {
      break;
    }
    kept.push(fact);
  }
  const injected = renderOverCapInjection({
    facts: kept,
    header: input.header,
    hintBlock: input.hintBlock,
    summary: summaryBody,
  });
  const limit = input.budget + utf8ByteLength(input.hintBlock);
  if (utf8ByteLength(injected) > limit) {
    return null;
  }
  return injected;
}

function renderOverCapInjection(input: {
  facts: readonly ContinuityMemoryFact[];
  header: string;
  hintBlock: string;
  summary?: string;
}): string {
  const lines: string[] = [];
  if (input.summary?.trim()) {
    lines.push(input.summary.trimEnd());
  }
  if (input.facts.length > 0) {
    const recent = renderContinuitySubset(input.header, input.facts).replace(
      /\n+$/,
      ""
    );
    if (recent.trim()) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(recent);
    }
  }
  return `${lines.join("\n").replace(/\n+$/, "")}${input.hintBlock}`;
}

/**
 * Newest-first extractive subset that fits `budgetBytes` (excluding the overflow hint).
 */
export function selectNewestContinuityFacts(
  content: string,
  budgetBytes: number
): SelectNewestContinuityFactsResult {
  const header = continuityMemoryHeader(content);
  const facts = parseContinuityMemoryFacts(content);
  const newestFirst = [...facts].sort(compareFactsNewestFirst);
  const kept: ContinuityMemoryFact[] = [];
  for (const fact of newestFirst) {
    const candidate = renderContinuitySubset(header, [...kept, fact]);
    if (utf8ByteLength(candidate) > budgetBytes) {
      break;
    }
    kept.push(fact);
  }
  const keptIds = new Set(kept.map((fact) => fact.id));
  return {
    facts,
    header,
    kept,
    omitted: facts.filter((fact) => !keptIds.has(fact.id)),
  };
}

/**
 * Bound MEMORY.md for system-prompt injection.
 * Under the cap (or when `byteCap` is null) the file is returned unchanged.
 * Over cap: optional LLM summary of omitted facts plus the newest extractive
 * bullets that still fit, so recent facts are never dropped.
 */
export function composeContinuityMemorySection(
  content: string,
  options: ComposeContinuityMemoryOptions = {}
): ComposedContinuityMemory {
  const byteCap =
    options.byteCap === undefined
      ? DEFAULT_MEMORY_MD_BYTE_CAP
      : options.byteCap;
  if (byteCap === null || utf8ByteLength(content) <= byteCap) {
    return { injected: content, omittedCount: 0, truncated: false };
  }

  const hint = options.overflowHint ?? MEMORY_SEARCH_OVERFLOW_HINT;
  const hintBlock = hint.trim() ? `\n- ${hint}\n` : "\n";
  const hintBytes = utf8ByteLength(hintBlock);
  const budget = Math.max(0, byteCap - hintBytes);
  const selected = selectNewestContinuityFacts(content, budget);
  const summary = options.summary?.trim();
  if (summary) {
    const withSummary = renderSummaryWithRecentFacts({
      budget,
      header: "",
      hintBlock,
      recent: selected.kept,
      summary,
    });
    if (withSummary && utf8ByteLength(withSummary) <= byteCap) {
      const omitted = selected.facts.filter(
        (fact) => !withSummary.includes(fact.content)
      );
      return {
        injected: withSummary,
        omittedCount: omitted.length,
        truncated: true,
      };
    }
  }

  if (selected.kept.length === 0) {
    return {
      injected: hintBlock.trimStart(),
      omittedCount: selected.facts.length,
      truncated: true,
    };
  }

  return {
    injected: `${renderContinuitySubset(selected.header, selected.kept).replace(/\n+$/, "")}${hintBlock}`,
    omittedCount: selected.omitted.length,
    truncated: true,
  };
}

export function createExtractiveContinuityMemorySummarizer(
  byteCap = DEFAULT_MEMORY_MD_BYTE_CAP
): ContinuityMemorySummarizer {
  return {
    summarize(content: string) {
      return composeContinuityMemorySection(content, {
        byteCap,
        overflowHint: MEMORY_SEARCH_OVERFLOW_HINT,
      }).injected;
    },
  };
}

const SUMMARIZE_PROMPT_PREFIX = `Summarize these older profile continuity facts that will not fit in the new-session prompt.
Keep durable identity, preferences, standing personal codes, and passphrase hints verbatim.
Drop warehouse bin counts, SKU inventory, overflow/stock labels, and similar trivia.
Do not invent facts. Stay under the byte budget implied by a short markdown list.

Facts:
`;

export async function summarizeContinuityMemoryWithModel(
  content: string,
  generateText: (prompt: string) => Promise<string>
): Promise<string> {
  const summary = (
    await generateText(`${SUMMARIZE_PROMPT_PREFIX}${content}`)
  ).trim();
  if (!summary) {
    return createExtractiveContinuityMemorySummarizer().summarize(content);
  }
  return summary;
}

export function hashContinuityMemoryContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function continuityMemorySummaryCacheKey(input: {
  byteCap: number;
  content: string;
}): string {
  return [
    CONTINUITY_MEMORY_SUMMARY_PROMPT_VERSION,
    String(input.byteCap),
    hashContinuityMemoryContent(input.content),
  ].join(":");
}

export class ContinuityMemorySummaryCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly limit = DEFAULT_SUMMARY_CACHE_LIMIT) {}

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, summary: string): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, summary);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export const defaultContinuityMemorySummaryCache =
  new ContinuityMemorySummaryCache();

export function memorySummarizationEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env.ATLAS_MEMORY_SUMMARIZATION?.trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

function resolveByteCap(
  byteCap: ResolveContinuityMemorySummaryOptions["byteCap"]
): number | null {
  return byteCap === undefined ? DEFAULT_MEMORY_MD_BYTE_CAP : byteCap;
}

/**
 * LLM summary of facts squeezed out of extractive recency. Cached by content
 * hash + byte cap so an unchanged MEMORY.md is not re-summarized every turn.
 * Returns undefined when under cap, summarization is disabled, or no model is
 * available so compose falls back to extractive bounding.
 */
export async function resolveContinuityMemorySummary(
  content: string,
  options: ResolveContinuityMemorySummaryOptions = {}
): Promise<string | undefined> {
  const byteCap = resolveByteCap(options.byteCap);
  if (
    options.enabled === false ||
    !options.generateText ||
    byteCap === null ||
    utf8ByteLength(content) <= byteCap
  ) {
    return;
  }

  const hintBytes = utf8ByteLength(`\n- ${MEMORY_SEARCH_OVERFLOW_HINT}\n`);
  const selected = selectNewestContinuityFacts(
    content,
    Math.max(0, byteCap - hintBytes)
  );
  if (selected.omitted.length === 0) {
    return;
  }

  const cache = options.cache ?? defaultContinuityMemorySummaryCache;
  const cacheKey = continuityMemorySummaryCacheKey({ byteCap, content });
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const omittedMarkdown = selected.omitted
    .map((fact) => `- ${fact.content}`)
    .join("\n");
  try {
    const summary = await summarizeContinuityMemoryWithModel(
      omittedMarkdown,
      options.generateText
    );
    if (!summary.trim()) {
      return;
    }
    cache.set(cacheKey, summary);
    return summary;
  } catch {}
}
