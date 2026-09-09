import { expect, test } from "bun:test";
import type { ChatMessage, ToolCall } from "@atlas/core";
import { createToolProgressTracker } from "./tool-progress";

const calls: ToolCall[] = [
  { arguments: { path: "a.txt" }, id: "a", name: "read_file" },
  { arguments: { path: "b.txt" }, id: "b", name: "read_file" },
];
const results: ChatMessage[] = [
  { content: "A", name: "read_file", role: "tool", toolCallId: "a" },
  { content: "B", name: "read_file", role: "tool", toolCallId: "b" },
];

test("parallel-safe outcome permutations do not evade the progress guard", () => {
  const tracker = createToolProgressTracker();
  expect(tracker.record(calls, results, true)).toBe(false);
  expect(
    tracker.record([...calls].reverse(), [...results].reverse(), true)
  ).toBe(false);
  expect(tracker.record(calls, results, true)).toBe(false);
  expect(
    tracker.record([...calls].reverse(), [...results].reverse(), true)
  ).toBe(true);
});

test("ordered batches preserve execution order when measuring progress", () => {
  const tracker = createToolProgressTracker();
  for (let index = 0; index < 4; index += 1) {
    expect(tracker.record(calls, results)).toBe(false);
    expect(tracker.record([...calls].reverse(), [...results].reverse())).toBe(
      false
    );
  }
});

test("changed parallel outcomes reset the stalled count", () => {
  const tracker = createToolProgressTracker();
  for (let index = 0; index < 3; index += 1) {
    expect(tracker.record(calls, results, true)).toBe(false);
  }
  const changed: ChatMessage[] = [
    results[0]!,
    { content: "New B", name: "read_file", role: "tool", toolCallId: "b" },
  ];
  expect(
    tracker.record([...calls].reverse(), [...changed].reverse(), true)
  ).toBe(false);
  expect(tracker.record(calls, changed, true)).toBe(false);
});

const invalidArgument = {
  error: "Invalid format color",
  errorCode: "INVALID_ARGUMENT",
};

function recordSpreadsheetOutcome(
  tracker: ReturnType<typeof createToolProgressTracker>,
  attempt: number,
  outcome: unknown
): boolean {
  const call: ToolCall = {
    arguments: {
      action: "format_range",
      format: { fillColor: `#00000${attempt}` },
      range: `A${attempt + 1}`,
    },
    id: `spreadsheet-${attempt}`,
    name: "spreadsheet",
  };
  return tracker.record(
    [call],
    outcome === undefined
      ? []
      : [
          {
            content: JSON.stringify(outcome),
            name: call.name,
            role: "tool",
            toolCallId: call.id,
          },
        ]
  );
}

test("changing ranges and colors cannot evade repeated invalid argument stops", () => {
  const tracker = createToolProgressTracker();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    expect(recordSpreadsheetOutcome(tracker, attempt, invalidArgument)).toBe(
      attempt === 3
    );
  }
});

test("alternating input failures across actions still stops an invalid batch streak", () => {
  const tracker = createToolProgressTracker();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const batch = ["format_range", "write_range"].map((action) => ({
      arguments: { action, range: `A${attempt + 1}` },
      id: `${action}-${attempt}`,
      name: "spreadsheet",
    }));
    const failures: ChatMessage[] = batch.map((call, index) => ({
      content: JSON.stringify({
        error: (attempt + index) % 2 ? "Invalid color" : "Missing values",
        errorCode: "INVALID_ARGUMENT",
      }),
      name: call.name,
      role: "tool",
      toolCallId: call.id,
    }));
    expect(tracker.record(batch, failures)).toBe(attempt === 3);
  }
});

test.each([
  ["corrected success", { cellsUpdated: 1, status: "written" }],
  ["different failure", { error: "Missing file", errorCode: "NOT_FOUND" }],
  ["unstructured failure", "INVALID_ARGUMENT: invalid color"],
  ["missing result", undefined],
  ["code without failure", { errorCode: "INVALID_ARGUMENT" }],
  ["successful payload code", { errorCode: "INVALID_ARGUMENT", success: true }],
])("%s resets the invalid argument streak", (_name, outcome) => {
  const tracker = createToolProgressTracker();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(recordSpreadsheetOutcome(tracker, attempt, invalidArgument)).toBe(
      false
    );
  }
  expect(recordSpreadsheetOutcome(tracker, 3, outcome)).toBe(false);
  for (let attempt = 4; attempt < 8; attempt += 1) {
    expect(recordSpreadsheetOutcome(tracker, attempt, invalidArgument)).toBe(
      attempt === 7
    );
  }
});

test("a mixed success batch resets the invalid argument streak", () => {
  const tracker = createToolProgressTracker();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(recordSpreadsheetOutcome(tracker, attempt, invalidArgument)).toBe(
      false
    );
  }
  expect(
    tracker.record(calls, [
      { ...results[0]!, content: JSON.stringify(invalidArgument) },
      results[1]!,
    ])
  ).toBe(false);
  for (let attempt = 4; attempt < 8; attempt += 1) {
    expect(recordSpreadsheetOutcome(tracker, attempt, invalidArgument)).toBe(
      attempt === 7
    );
  }
});

test.each(["isError", "ok", "success"])(
  "structured %s failure indicators count with an explicit invalid argument code",
  (key) => {
    const tracker = createToolProgressTracker();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(
        recordSpreadsheetOutcome(tracker, attempt, {
          errorCode: "INVALID_ARGUMENT",
          [key]: key === "isError",
        })
      ).toBe(attempt === 3);
    }
  }
);
