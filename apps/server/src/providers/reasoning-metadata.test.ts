import { describe, expect, test } from "bun:test";
import type { CustomModelEntry } from "@atlas/core";
import { buildGeminiChatConfig } from "./gemini/config";
import {
  modelSupportsReasoning,
  resolveModelThinkingEffort,
} from "./reasoning-metadata";

const metadata: CustomModelEntry[] = [
  {
    defaultReasoningEffort: "minimal",
    id: "reasoning-model",
    reasoningEffortValues: ["minimal", "high"],
    supportsThinking: true,
  },
];

describe("provider reasoning metadata", () => {
  test("validates selections against this model's advertised values and default", () => {
    expect(
      resolveModelThinkingEffort("reasoning-model", "high", metadata)
    ).toBe("high");
    expect(resolveModelThinkingEffort("reasoning-model", "max", metadata)).toBe(
      "minimal"
    );
    expect(
      resolveModelThinkingEffort("different-model", "high", metadata)
    ).toBeUndefined();
    expect(resolveModelThinkingEffort("gpt-5-future", "high")).toBeUndefined();
  });

  test.each([{ values: undefined }, { values: [] }])(
    "does not invent effort values from supportsThinking when list is %j",
    ({ values: reasoningEffortValues }) => {
      const entries = [
        {
          id: "reasoning-model",
          reasoningEffortValues,
          supportsThinking: true,
        },
      ];
      expect(
        resolveModelThinkingEffort("reasoning-model", "high", entries)
      ).toBeUndefined();
    }
  );

  test("explicit opt-out suppresses stale supported efforts", () => {
    const entries = [{ ...metadata[0]!, supportsThinking: false }];
    expect(modelSupportsReasoning("reasoning-model", entries)).toBe(false);
    expect(
      resolveModelThinkingEffort("reasoning-model", "high", entries)
    ).toBeUndefined();
  });

  test("Gemini sends advertised levels unchanged and leaves unspecified budgets to the provider", () => {
    const input = {
      providerOptions: { thinking: { effort: "high", enabled: true } },
    };
    expect(
      buildGeminiChatConfig(input, "Answer", "reasoning-model", metadata)
        .thinkingConfig
    ).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
    expect(
      buildGeminiChatConfig(input, "Answer", "gemini-unknown-flash")
        .thinkingConfig
    ).toBeUndefined();
    expect(
      buildGeminiChatConfig(input, "Answer", "reasoning-model", [
        { id: "reasoning-model", supportsThinking: true },
      ]).thinkingConfig
    ).toEqual({ includeThoughts: true });
    expect(
      buildGeminiChatConfig(
        { providerOptions: { thinking: { enabled: false } } },
        "Answer",
        "gemini-unknown-flash"
      ).thinkingConfig
    ).toBeUndefined();
  });
});
