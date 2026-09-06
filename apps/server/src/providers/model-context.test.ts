import { describe, expect, test } from "bun:test";
import { usableContextTokens } from "@atlas/agent";
import type { CustomModelEntry, ProviderInstance } from "@atlas/core";
import { resolveModelCompactionConfig } from "./model-context";
import { parseAnthropicModel, parseGeminiModel } from "./native-models";

function instance(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    apiKey: "",
    baseUrl: "https://endpoint.example/v1",
    createdAt: "2026-09-06T00:00:00.000Z",
    id: "provider-1",
    label: "Endpoint",
    type: "openai_compatible",
    ...overrides,
  };
}

describe("model context resolution", () => {
  test("does not reserve output again for native input-only model limits", () => {
    const nativeModels = [
      {
        model: parseAnthropicModel({
          id: "claude-native",
          max_input_tokens: 200_000,
          max_tokens: 64_000,
        }),
        type: "anthropic" as const,
      },
      {
        model: parseGeminiModel({
          inputTokenLimit: 1_048_576,
          name: "models/gemini-native",
          outputTokenLimit: 65_536,
          supportedGenerationMethods: ["generateContent"],
        }),
        type: "gemini" as const,
      },
    ];

    for (const { model, type } of nativeModels) {
      if (!model) {
        throw new Error("Expected a native model entry");
      }
      const config = resolveModelCompactionConfig(
        instance({ customModels: [model], type }),
        model.id
      );
      expect(config).toEqual({
        contextIncludesOutput: false,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
      });
      if (!config) {
        throw new Error("Expected native compaction limits");
      }
      expect(usableContextTokens(config)).toBe(model.contextWindow);
    }
  });

  test("uses the selected instance's limits when two endpoints share a model ID", () => {
    const first = instance({
      customModels: [
        { contextWindow: 32_000, id: "shared", maxOutputTokens: 4000 },
      ],
    });
    const second = instance({
      customModels: [
        { contextWindow: 1_000_000, id: "shared", maxOutputTokens: 16_000 },
      ],
      id: "provider-2",
    });
    expect(resolveModelCompactionConfig(first, "shared")).toEqual({
      contextWindow: 32_000,
      maxOutputTokens: 4000,
    });
    expect(resolveModelCompactionConfig(second, "shared")).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 16_000,
    });
  });

  test("does not substitute the default model's limits for another selected model", () => {
    const provider = instance({
      customModels: [
        {
          contextWindow: 200_000,
          default: true,
          id: "default",
          maxOutputTokens: 8000,
        },
        { id: "selected" },
      ],
    });
    expect(resolveModelCompactionConfig(provider, "selected")).toBeUndefined();
    expect(resolveModelCompactionConfig(provider, "missing")).toBeUndefined();
  });

  test("does not copy OpenAI API limits into subscriptions or proxy endpoints", () => {
    for (const provider of [
      instance({ customModels: [{ id: "gpt-5.4" }], type: "chatgpt" }),
      instance({ customModels: [{ id: "gpt-5.4" }], type: "openai" }),
      instance({ customModels: [{ id: "gpt-5.4" }] }),
    ]) {
      expect(resolveModelCompactionConfig(provider, "gpt-5.4")).toBeUndefined();
    }
  });

  test("uses documented exact OpenAI limits only at the official API endpoint", () => {
    const provider = instance({
      baseUrl: "https://api.openai.com/v1",
      customModels: [{ id: "gpt-5.4" }],
      type: "openai",
    });
    expect(resolveModelCompactionConfig(provider, "gpt-5.4")).toEqual({
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
    });
    expect(
      resolveModelCompactionConfig(provider, "gpt-5.4-unverified")
    ).toBeUndefined();
  });

  test("keeps unknown output limits absent rather than reserving a fabricated 8192 tokens", () => {
    expect(
      resolveModelCompactionConfig(
        instance({
          customModels: [{ contextWindow: 65_536, id: "known-context" }],
        }),
        "known-context"
      )
    ).toEqual({ contextWindow: 65_536 });
    expect(
      resolveModelCompactionConfig(
        instance({
          customModels: [{ id: "output-only", maxOutputTokens: 8192 }],
        }),
        "output-only"
      )
    ).toBeUndefined();
  });

  test.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps invalid context limit %s unknown",
    (contextWindow) => {
      const model: CustomModelEntry = { contextWindow, id: "invalid" };
      expect(
        resolveModelCompactionConfig(
          instance({ customModels: [model] }),
          "invalid"
        )
      ).toBeUndefined();
    }
  );
});
