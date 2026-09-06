import { createHash } from "node:crypto";
import type { ChatMessage, ToolCall } from "@atlas/core";

const MAX_IDENTICAL_OUTCOMES = 4;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function outcomeData(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/** Same requests can make progress (polling, reading a changed file, pagination). */
export function createToolProgressTracker(): {
  record: (
    calls: readonly ToolCall[],
    results: readonly ChatMessage[],
    orderIndependent?: boolean
  ) => boolean;
} {
  let previous: string | undefined;
  let identicalOutcomes = 0;
  return {
    record(calls, results, orderIndependent = false) {
      const outcomes = calls.map((call, index) => {
        const result = results[index];
        return {
          arguments: call.arguments,
          name: call.name,
          result: result?.role === "tool" ? outcomeData(result.content) : null,
        };
      });
      const normalizedOutcomes = outcomes.map((outcome) =>
        JSON.stringify(canonicalize(outcome))
      );
      if (orderIndependent) {
        normalizedOutcomes.sort();
      }
      const signature = createHash("sha256")
        .update(JSON.stringify(normalizedOutcomes))
        .digest("hex");
      identicalOutcomes = signature === previous ? identicalOutcomes + 1 : 1;
      previous = signature;
      return identicalOutcomes >= MAX_IDENTICAL_OUTCOMES;
    },
  };
}

/** Invalid call correlation must be rejected before any tool side effect. */
export function validateToolCallIds(calls: readonly ToolCall[]): void {
  if (!Array.isArray(calls)) {
    throw new Error("Provider returned an invalid tool call list.");
  }
  const ids = new Set<string>();
  for (const call of calls) {
    if (
      !call ||
      typeof call.id !== "string" ||
      !call.id.trim() ||
      ids.has(call.id)
    ) {
      throw new Error("Provider returned missing or duplicate tool call IDs.");
    }
    ids.add(call.id);
  }
}

export function toolResultError(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return;
  }
  const record = result as Record<string, unknown>;
  if (record.error) {
    return typeof record.error === "string"
      ? record.error
      : "Tool reported an error.";
  }
  if (
    record.success === false ||
    record.ok === false ||
    record.isError === true
  ) {
    return "Tool reported an unsuccessful result.";
  }
}
