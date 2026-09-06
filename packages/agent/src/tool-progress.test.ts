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
