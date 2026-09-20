import { createHash } from "node:crypto";
import type { ChatMessage, ToolCall } from "@atlas/core";
import { createSpreadsheetFormattingBudget } from "./spreadsheet-progress";

const MAX_IDENTICAL_OUTCOMES = 4;
const MAX_INVALID_ARGUMENT_BATCHES = 4;

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

function isInvalidArgumentFailure(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "errorCode" in value &&
    value.errorCode === "INVALID_ARGUMENT" &&
    toolResultError(value) !== undefined
  );
}

/** Same requests can make progress (polling, reading a changed file, pagination). */
export function createToolProgressTracker(): {
  recordFormatting: (call: ToolCall, result: unknown) => boolean;
  stop: () => { reason: "no_progress" | "iteration_limit"; message: string };
  record: (
    calls: readonly ToolCall[],
    results: readonly ChatMessage[],
    orderIndependent?: boolean,
    formattingAlreadyRecorded?: boolean
  ) => boolean;
} {
  const formattingBudget = createSpreadsheetFormattingBudget();
  let formattingLimit = false;
  let previous: string | undefined;
  let identicalOutcomes = 0;
  let invalidArgumentBatches = 0;
  return {
    record(
      calls,
      results,
      orderIndependent = false,
      formattingAlreadyRecorded = false
    ) {
      const outcomes = calls.map((call, index) => {
        const result = results[index];
        const data =
          result?.role === "tool" ? outcomeData(result.content) : null;
        if (!formattingAlreadyRecorded) {
          formattingLimit = formattingBudget(call, data) || formattingLimit;
        }
        return {
          arguments: call.arguments,
          name: call.name,
          result: data,
        };
      });
      // Changing ranges or other arguments cannot turn repeated input rejection
      // into progress. Any completed success or different failure allows recovery.
      const onlyInvalidArguments =
        outcomes.length > 0 &&
        results.length === calls.length &&
        outcomes.every((outcome) => isInvalidArgumentFailure(outcome.result));
      invalidArgumentBatches = onlyInvalidArguments
        ? invalidArgumentBatches + 1
        : 0;
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
      return (
        formattingLimit ||
        identicalOutcomes >= MAX_IDENTICAL_OUTCOMES ||
        invalidArgumentBatches >= MAX_INVALID_ARGUMENT_BATCHES
      );
    },
    recordFormatting(call, result) {
      formattingLimit = formattingBudget(call, result) || formattingLimit;
      return formattingLimit;
    },
    stop() {
      return formattingLimit
        ? {
            message:
              "The spreadsheet reached eight formatting revisions in one turn. Stop restyling and report the latest saved workbook and any unfinished work. For future edits, combine related writes and formatting with batch_edit.",
            reason: "iteration_limit" as const,
          }
        : {
            message:
              "Repeated tool calls did not make observable progress. Use the recorded results to identify the blocker.",
            reason: "no_progress" as const,
          };
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
