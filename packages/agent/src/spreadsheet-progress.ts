import type { ToolCall } from "@atlas/core";

const MAX_FORMATTING_REVISIONS_PER_TURN = 8;

/** Track returned source/output paths, so versioned saves and interleaved reads
 * cannot reset a single workbook's presentation budget. A batch costs one revision. */
export function createSpreadsheetFormattingBudget() {
  const workbooks = new Map<string, { revisions: number }>();
  return (call: ToolCall, result: unknown): boolean => {
    if (call.name !== "spreadsheet" || !result || typeof result !== "object") {
      return false;
    }
    const record = result as Record<string, unknown>;
    if (
      typeof record.path !== "string" ||
      typeof record.sourcePath !== "string" ||
      record.error ||
      record.success === false
    ) {
      return false;
    }
    const budget = workbooks.get(record.sourcePath) ?? { revisions: 0 };
    workbooks.set(record.sourcePath, budget);
    workbooks.set(record.path, budget);
    const formats =
      record.status === "formatted" ||
      (record.status === "batch_edited" &&
        Array.isArray(call.arguments.operations) &&
        call.arguments.operations.some(
          (operation: unknown) =>
            operation !== null &&
            typeof operation === "object" &&
            "action" in operation &&
            operation.action === "format_range"
        ));
    if (formats) {
      budget.revisions += 1;
    }
    return budget.revisions >= MAX_FORMATTING_REVISIONS_PER_TURN;
  };
}
