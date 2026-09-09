import {
  type ChatCompletionResult,
  IncompleteCompletionError,
} from "@atlas/core";

/** Diagnostic snapshots only. Text and tool-input fragments are never executable ToolCalls. */
export interface ProviderFailureEvidence {
  content: string;
  /** Native occupancy is separate from native-reported turn/query counters. */
  contextUsage?: ChatCompletionResult["contextUsage"];
  thinking?: string;
  toolInputFragments: { id?: string; name?: string; arguments: string }[];
  /** Explicit native-reported counters only; missing counters remain unknown. */
  usage?: Partial<NonNullable<ChatCompletionResult["usage"]>>;
}

const failures = new WeakMap<object, ProviderFailureEvidence>();
const isObject = (value: unknown): value is object =>
  value !== null && (typeof value === "object" || typeof value === "function");

/** Keep the original error object, including native classification and approval identity. */
export function captureProviderFailureEvidence<T>(
  error: T,
  evidence: ProviderFailureEvidence
): T {
  if (isObject(error)) {
    failures.set(error, {
      ...evidence,
      contextUsage: evidence.contextUsage
        ? { ...evidence.contextUsage }
        : undefined,
      toolInputFragments: evidence.toolInputFragments.map((fragment) => ({
        ...fragment,
      })),
      usage: evidence.usage ? { ...evidence.usage } : undefined,
    });
  }
  return error;
}

/** A classified wrapper may retain native evidence through its original cause. */
export function getProviderFailureEvidence(
  error: unknown
): ProviderFailureEvidence | undefined {
  const visited = new Set<object>();
  let current = error;
  while (isObject(current) && !visited.has(current)) {
    visited.add(current);
    const evidence =
      failures.get(current) ??
      (current instanceof IncompleteCompletionError
        ? current.evidence
        : undefined);
    if (evidence) {
      return evidence;
    }
    current = "cause" in current ? current.cause : undefined;
  }
}

export function reportedProviderFailureUsage(
  error: unknown
): { inputTokens: number; outputTokens: number } | undefined {
  const usage = getProviderFailureEvidence(error)?.usage;
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  if (
    usage?.estimated ||
    typeof input !== "number" ||
    typeof output !== "number" ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  ) {
    return;
  }
  return { inputTokens: input, outputTokens: output };
}
