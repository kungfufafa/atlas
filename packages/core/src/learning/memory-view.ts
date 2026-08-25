import { applyRedactionBoundary } from "../redaction-boundary";

export interface LedgerMemory {
  content: string;
  importance?: number;
  subject?: string | null;
  updatedAt: string;
}

const DEFAULT_MEMORY_MD_BULLETS = 40;

/**
 * DB memories are the canonical fact ledger. MEMORY.md is a bounded
 * materialized view only — never a second source of truth.
 */
export function materializeMemoryMarkdown(
  memories: LedgerMemory[],
  maxBullets = DEFAULT_MEMORY_MD_BULLETS
): string {
  const ranked = [...memories].sort((left, right) => {
    const importance = (right.importance ?? 0) - (left.importance ?? 0);
    if (importance !== 0) {
      return importance;
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  });
  const bullets = ranked.slice(0, maxBullets).map((item) => {
    const text = applyRedactionBoundary(item.content.trim(), "memory");
    const subject = item.subject?.trim();
    return subject ? `- (${subject}) ${text}` : `- ${text}`;
  });
  return ["# Memory", "", ...bullets, ""].join("\n");
}

export function composeTurnMemoryContext(memories: LedgerMemory[]): string {
  if (memories.length === 0) {
    return "";
  }
  const lines = memories.slice(0, 12).map((item) => `- ${item.content.trim()}`);
  return ["## Retrieved memory", "", ...lines].join("\n");
}
