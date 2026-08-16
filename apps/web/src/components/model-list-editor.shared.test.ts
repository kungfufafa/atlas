import { describe, expect, test } from "bun:test";
import { normalizeModelListRows } from "./model-list-editor.shared";
import {
  seedManageModelRows,
  seedShortlistManageModelRows,
} from "./settings/provider-settings-seed";

describe("normalizeModelListRows", () => {
  test("preserves reasoningEffortValues array and cleans empty items", () => {
    const normalized = normalizeModelListRows([
      {
        id: "qwen/qwen3.8-max-free",
        name: "Qwen 3.8 Max Free",
        reasoningEffortValues: ["low", "medium", "xhigh"],
        supportsThinking: true,
      },
    ]);

    expect(normalized).toEqual([
      {
        id: "qwen/qwen3.8-max-free",
        name: "Qwen 3.8 Max Free",
        reasoningEffortValues: ["low", "medium", "xhigh"],
        supportsThinking: true,
      },
    ]);
  });

  test("parses string reasoningEffortValues into trimmed array", () => {
    const normalized = normalizeModelListRows([
      {
        id: "qwen/qwen3.8-max-free",
        name: "qwen/qwen3.8-max-free",
        // @ts-expect-error test raw string input
        reasoningEffortValues: "low, medium, high, xhigh",
        supportsThinking: true,
      },
    ]);

    expect(normalized).toEqual([
      {
        id: "qwen/qwen3.8-max-free",
        name: "qwen/qwen3.8-max-free",
        reasoningEffortValues: ["low", "medium", "high", "xhigh"],
        supportsThinking: true,
      },
    ]);
  });

  test("skips empty id rows", () => {
    const normalized = normalizeModelListRows([
      {
        id: "   ",
        name: "Empty",
      },
    ]);

    expect(normalized).toEqual([]);
  });
});

describe("provider-settings-seed", () => {
  test("seedManageModelRows preserves reasoningEffortValues", () => {
    const seeded = seedManageModelRows(
      [
        {
          id: "qwen/qwen3.8-max-free",
          reasoningEffortValues: ["low", "medium", "xhigh"],
          supportsThinking: true,
        },
      ],
      []
    );

    expect(seeded[0].reasoningEffortValues).toEqual(["low", "medium", "xhigh"]);
  });

  test("seedShortlistManageModelRows preserves reasoningEffortValues", () => {
    const seeded = seedShortlistManageModelRows([
      {
        id: "qwen/qwen3.8-max-free",
        reasoningEffortValues: ["low", "medium", "high"],
        supportsThinking: true,
      },
    ]);

    expect(seeded[0].reasoningEffortValues).toEqual(["low", "medium", "high"]);
  });
});
