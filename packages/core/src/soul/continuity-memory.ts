import { parseMemoryContent } from "./memory-archive";

/** Default MEMORY.md injection budget. Small files under this cap are unchanged. */
export const DEFAULT_MEMORY_MD_BYTE_CAP = 8192;

export const MEMORY_SEARCH_OVERFLOW_HINT =
  "Use memory_search for omitted, archived, or more recently updated continuity facts; prefer later updatedAt when facts conflict.";

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

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Parse live MEMORY.md into searchable facts. Dated `## YYYY-MM-DD` bullets
 * carry that date; preamble bullets are ordered so later lines are newer.
 */
export function parseContinuityMemoryFacts(
  content: string,
  source: ContinuityMemorySource = "live"
): ContinuityMemoryFact[] {
  const parsed = parseMemoryContent(content);
  const facts: ContinuityMemoryFact[] = [];
  let order = 0;

  for (const line of parsed.preamble.split("\n")) {
    if (!line.startsWith("- ")) {
      continue;
    }
    facts.push({
      content: line.slice(2),
      id: `${source}-preamble-${order}`,
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
        id: `${source}-${section.date}-${order}`,
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

/**
 * Bound MEMORY.md for system-prompt injection.
 * Under the cap (or when `byteCap` is null) the file is returned unchanged.
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
  const summary = options.summary?.trim();
  if (summary) {
    const withHint = `${summary.replace(/\n+$/, "")}${hintBlock}`;
    if (utf8ByteLength(withHint) <= byteCap) {
      const facts = parseContinuityMemoryFacts(content);
      return {
        injected: withHint,
        omittedCount: facts.length,
        truncated: true,
      };
    }
  }

  const header = continuityMemoryHeader(content);
  const facts = [...parseContinuityMemoryFacts(content)].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) === 0
      ? right.order - left.order
      : right.updatedAt.localeCompare(left.updatedAt)
  );
  const kept: ContinuityMemoryFact[] = [];
  for (const fact of facts) {
    const candidate = renderContinuitySubset(header, [...kept, fact]);
    if (utf8ByteLength(candidate) > budget) {
      break;
    }
    kept.push(fact);
  }

  if (kept.length === 0) {
    return {
      injected: hintBlock.trimStart(),
      omittedCount: facts.length,
      truncated: true,
    };
  }

  return {
    injected: `${renderContinuitySubset(header, kept).replace(/\n+$/, "")}${hintBlock}`,
    omittedCount: facts.length - kept.length,
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

const SUMMARIZE_PROMPT_PREFIX = `Summarize these profile continuity facts for a new session.
Keep durable identity, preferences, and current values. Drop trivia if needed.
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
