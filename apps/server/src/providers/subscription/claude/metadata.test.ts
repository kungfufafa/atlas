import { describe, expect, test } from "bun:test";
import {
  claudeModelOptions,
  claudeThinkingOptions,
  readClaudeContextUsage,
  readClaudeTokenUsage,
} from "./metadata";

describe("Claude runtime metadata", () => {
  test("uses advertised model IDs and exact effort levels without inventing limits or defaults", () => {
    const models = claudeModelOptions([
      {
        displayName: "Claude model",
        resolvedModel: "claude-runtime-model",
        supportedEffortLevels: ["medium", "max"],
        supportsAdaptiveThinking: true,
        supportsEffort: true,
        value: "sonnet",
      },
      { value: "future-model" },
    ]);

    expect(models.map((model) => model.id)).toEqual([
      "sonnet",
      "claude-runtime-model",
      "future-model",
    ]);
    expect(models[0]).toEqual({
      id: "sonnet",
      name: "Claude model",
      provider: "claude",
      reasoningEffortValues: ["medium", "max"],
      supportsThinking: true,
    });
    expect(models[2]).toEqual({
      id: "future-model",
      name: "future-model",
      provider: "claude",
    });
  });

  test("lack of adaptive thinking does not invent a claim about legacy thinking", () => {
    const [model] = claudeModelOptions([
      {
        supportsAdaptiveThinking: false,
        supportsEffort: false,
        value: "legacy",
      },
    ]);
    expect(model?.supportsThinking).toBeUndefined();
    expect(model?.reasoningEffortValues).toEqual([]);
  });

  test("preserves explicit reasoning effort and leaves runtime default effort unset", () => {
    const model = {
      supportedEffortLevels: ["low", "max"],
      supportsAdaptiveThinking: true,
    };
    expect(
      claudeThinkingOptions({ effort: "max", enabled: true }, model)
    ).toMatchObject({ effort: "max" });
    expect(claudeThinkingOptions({ enabled: true }, model)).not.toHaveProperty(
      "effort"
    );
    expect(() =>
      claudeThinkingOptions({ effort: "high", enabled: true }, model)
    ).toThrow();
    expect(() => claudeThinkingOptions({ enabled: true })).toThrow();
    expect(claudeThinkingOptions({ enabled: false })).toEqual({
      thinking: { type: "disabled" },
    });
  });

  test("uses native occupancy rather than raw context capacity or cumulative query usage", () => {
    expect(
      readClaudeContextUsage({
        maxTokens: 180_000,
        rawMaxTokens: 200_000,
        totalTokens: 50_000,
      })
    ).toEqual({
      contextWindow: 180_000,
      usedTokens: 50_000,
    });
    expect(
      readClaudeContextUsage({ contextWindow: 200_000, inputTokens: 100_000 })
    ).toBeUndefined();
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid native context windows %s",
    (maxTokens) => {
      expect(
        readClaudeContextUsage({ maxTokens, totalTokens: 100 })
      ).toBeUndefined();
    }
  );

  test("counts all cache input and each query model once", () => {
    expect(
      readClaudeTokenUsage({
        modelUsage: {
          auxiliary: {
            cacheCreationInputTokens: 50,
            cacheReadInputTokens: 0,
            inputTokens: 10,
            outputTokens: 5,
          },
          main: {
            cacheCreationInputTokens: 300,
            cacheReadInputTokens: 2000,
            inputTokens: 100,
            outputTokens: 20,
          },
        },
        usage: { input_tokens: 9, output_tokens: 9 },
      })
    ).toEqual({ inputTokens: 2460, outputTokens: 25, totalTokens: 2485 });
    expect(
      readClaudeTokenUsage({
        usage: {
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 2,
          input_tokens: 1,
          output_tokens: 4,
        },
      })
    ).toEqual({ inputTokens: 6, outputTokens: 4, totalTokens: 10 });
    expect(readClaudeTokenUsage({})).toBeUndefined();
  });
});
