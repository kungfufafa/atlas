import {
  type ComposeContinuityMemoryOptions,
  type ContinuityMemorySummaryCache,
  composeContinuityMemorySection,
  resolveContinuityMemorySummary,
} from "./continuity-memory";
import type { LoadedSoulStack } from "./types";

export interface ComposeSoulPromptOptions {
  includeMemory?: boolean;
  memoryByteCap?: ComposeContinuityMemoryOptions["byteCap"];
  memoryOverflowHint?: string;
  memorySummary?: string;
  profilePrompt?: string;
}

export interface ComposeSoulPromptWithSummaryOptions
  extends ComposeSoulPromptOptions {
  generateText?: (prompt: string) => Promise<string>;
  memorySummarization?: boolean;
  summaryCache?: ContinuityMemorySummaryCache;
}

export function composeSoulSystemPrompt(
  stack: LoadedSoulStack,
  options: ComposeSoulPromptOptions = {}
): string {
  const profilePrompt = options.profilePrompt?.trim();
  const sections: string[] = [
    "You embody the identity defined below. This is who you are — not a description of someone else.",
    "You are present in this conversation. Speak in first person as that identity.",
    "Stay in character. Extrapolate from worldview and voice when topics aren't explicitly covered.",
  ];

  if (stack.files.soul) {
    sections.push("", "# Identity (SOUL.md)", stack.files.soul);
  } else if (profilePrompt) {
    sections.push("", "# Identity", profilePrompt);
  }

  if (stack.files.style) {
    sections.push("", "# Voice & Style (STYLE.md)", stack.files.style);
  }

  if (stack.files.instructions) {
    sections.push(
      "",
      "# Operating Instructions (INSTRUCTIONS.md)",
      stack.files.instructions
    );
  }

  if (options.includeMemory !== false && stack.files.memory) {
    const continuity = composeContinuityMemorySection(stack.files.memory, {
      byteCap: options.memoryByteCap,
      overflowHint: options.memoryOverflowHint,
      summary: options.memorySummary,
    });
    sections.push("", "# Continuity (MEMORY.md)", continuity.injected);
  }

  if (stack.files.soul && profilePrompt && profilePrompt !== stack.files.soul) {
    sections.push("", "# Profile Instructions", profilePrompt);
  }

  return sections.join("\n");
}

/**
 * Same as `composeSoulSystemPrompt`, but when MEMORY.md is over cap and a
 * model is available, injects a hash-cached LLM summary of omitted facts.
 * Falls back to extractive recency when summarization is disabled, no model
 * is provided, or the summarizer throws.
 */
export async function composeSoulSystemPromptWithSummary(
  stack: LoadedSoulStack,
  options: ComposeSoulPromptWithSummaryOptions = {}
): Promise<string> {
  let memorySummary = options.memorySummary;
  if (
    memorySummary === undefined &&
    options.includeMemory !== false &&
    stack.files.memory &&
    options.memorySummarization !== false
  ) {
    memorySummary = await resolveContinuityMemorySummary(stack.files.memory, {
      byteCap: options.memoryByteCap,
      cache: options.summaryCache,
      enabled: options.memorySummarization,
      generateText: options.generateText,
    });
  }
  return composeSoulSystemPrompt(stack, { ...options, memorySummary });
}
