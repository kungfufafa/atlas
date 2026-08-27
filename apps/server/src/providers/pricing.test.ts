import { describe, expect, test } from "bun:test";
import {
  estimateUsageCostUsd,
  getModelPricing,
  hasCatalogPricing,
} from "./pricing";

const openRouterInstance = {
  apiKey: "sk-test",
  createdAt: "2026-06-07T10:00:00.000Z",
  id: "or-1",
  label: "OpenRouter",
  type: "openrouter" as const,
};

const compatibleInstance = {
  apiKey: "k",
  baseUrl: "http://localhost:11434/v1",
  createdAt: "2026-06-07T10:00:00.000Z",
  id: "cmp-1",
  label: "Ollama",
  type: "openai_compatible" as const,
};

const cerebrasInstance = {
  apiKey: "csk-test",
  createdAt: "2026-07-16T10:00:00.000Z",
  id: "cb-1",
  label: "Cerebras",
  type: "cerebras" as const,
};

const fireworksInstance = {
  apiKey: "fw-test",
  createdAt: "2026-07-24T10:00:00.000Z",
  id: "fw-1",
  label: "Fireworks",
  type: "fireworks" as const,
};

const openAiInstance = {
  apiKey: "sk-test",
  createdAt: "2026-08-27T10:00:00.000Z",
  id: "openai-1",
  label: "OpenAI",
  type: "openai" as const,
};

const anthropicInstance = {
  apiKey: "sk-ant-test",
  createdAt: "2026-08-27T10:00:00.000Z",
  id: "anthropic-1",
  label: "Anthropic",
  type: "anthropic" as const,
};

describe("estimateUsageCostUsd", () => {
  test("computes cost from catalog pricing", () => {
    const cost = estimateUsageCostUsd(
      "claude-sonnet-4-6",
      1_000_000,
      1_000_000
    );
    expect(cost).toBe(18);
  });

  test("uses provider-scoped pricing for shared model ids", () => {
    expect(
      getModelPricing("claude-sonnet-4-6", { provider: "anthropic" })
    ).toEqual({
      inputPerMillionUsd: 3,
      outputPerMillionUsd: 15,
    });
    expect(getModelPricing("gpt-5.4", { provider: "openai" })).toEqual({
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 8,
    });
  });

  test("uses saved pricing for native provider custom models", () => {
    expect(
      getModelPricing("gpt-private", {
        provider: "openai",
        providerInstance: {
          ...openAiInstance,
          customModels: [
            {
              id: "gpt-private",
              inputPerMillionUsd: 7,
              outputPerMillionUsd: 21,
            },
          ],
        },
      })
    ).toEqual({ inputPerMillionUsd: 7, outputPerMillionUsd: 21 });

    expect(
      getModelPricing("claude-private", {
        provider: "anthropic",
        providerInstance: {
          ...anthropicInstance,
          customModels: [
            {
              id: "claude-private",
              inputPerMillionUsd: 5,
              outputPerMillionUsd: 25,
            },
          ],
        },
      })
    ).toEqual({ inputPerMillionUsd: 5, outputPerMillionUsd: 25 });
  });

  test("does not assign API token pricing to subscription usage", () => {
    for (const [provider, model] of [
      ["claude", "claude-sonnet-4-6"],
      ["chatgpt", "gpt-5.4"],
      ["chatgpt", "unknown-subscription-model"],
    ] as const) {
      expect(getModelPricing(model, { provider })).toBeNull();
      expect(
        estimateUsageCostUsd(model, 1_000_000, 1_000_000, { provider })
      ).toBe(0);
      expect(hasCatalogPricing(model, { provider })).toBe(false);
    }
  });

  test("uses fallback pricing for unknown models", () => {
    const pricing = getModelPricing("vendor/custom-model");
    expect(pricing?.inputPerMillionUsd).toBe(1);
    expect(pricing?.outputPerMillionUsd).toBe(3);
  });

  test("prices gpt-image-2 with Images token rates", () => {
    const pricing = getModelPricing("gpt-image-2");
    expect(pricing).toEqual({
      inputPerMillionUsd: 5,
      outputPerMillionUsd: 30,
    });
    // 1M input + 1M output → $5 + $30
    expect(estimateUsageCostUsd("gpt-image-2", 1_000_000, 1_000_000)).toBe(35);
  });

  test("uses saved pricing for openrouter custom models", () => {
    const cost = estimateUsageCostUsd(
      "anthropic/claude-sonnet-4-6",
      1_000_000,
      1_000_000,
      {
        provider: "openrouter",
        providerInstance: {
          ...openRouterInstance,
          customModels: [
            {
              id: "anthropic/claude-sonnet-4-6",
              inputPerMillionUsd: 3,
              outputPerMillionUsd: 15,
            },
          ],
        },
      }
    );

    expect(cost).toBe(18);
  });

  test("does not estimate openrouter models without saved pricing", () => {
    expect(
      getModelPricing("anthropic/claude-sonnet-4-6", {
        provider: "openrouter",
        providerInstance: {
          ...openRouterInstance,
          customModels: [{ id: "anthropic/claude-sonnet-4-6" }],
        },
      })
    ).toBeNull();
    expect(
      estimateUsageCostUsd("anthropic/claude-sonnet-4-6", 1000, 500, {
        provider: "openrouter",
        providerInstance: {
          ...openRouterInstance,
          customModels: [{ id: "anthropic/claude-sonnet-4-6" }],
        },
      })
    ).toBe(0);
  });

  test("uses saved pricing for cerebras custom models", () => {
    const cost = estimateUsageCostUsd("gpt-oss-120b", 1_000_000, 1_000_000, {
      provider: "cerebras",
      providerInstance: {
        ...cerebrasInstance,
        customModels: [
          {
            id: "gpt-oss-120b",
            inputPerMillionUsd: 0.25,
            outputPerMillionUsd: 0.69,
          },
        ],
      },
    });

    expect(cost).toBeCloseTo(0.94, 5);
  });

  test("uses saved pricing for fireworks custom models", () => {
    const cost = estimateUsageCostUsd(
      "accounts/fireworks/models/kimi-k2p6",
      1_000_000,
      1_000_000,
      {
        provider: "fireworks",
        providerInstance: {
          ...fireworksInstance,
          customModels: [
            {
              id: "accounts/fireworks/models/kimi-k2p6",
              inputPerMillionUsd: 0.5,
              outputPerMillionUsd: 2,
            },
          ],
        },
      }
    );

    expect(cost).toBeCloseTo(2.5, 5);
  });

  test("does not estimate compatible models without user pricing", () => {
    const pricing = getModelPricing("llama3.2", {
      provider: "openai_compatible",
      providerInstance: {
        ...compatibleInstance,
        customModels: [{ id: "llama3.2" }],
      },
    });

    expect(pricing).toBeNull();
    expect(
      estimateUsageCostUsd("llama3.2", 1000, 500, {
        provider: "openai_compatible",
        providerInstance: {
          ...compatibleInstance,
          customModels: [{ id: "llama3.2" }],
        },
      })
    ).toBe(0);
    expect(
      hasCatalogPricing("llama3.2", {
        provider: "openai_compatible",
        providerInstance: {
          ...compatibleInstance,
          customModels: [
            {
              id: "llama3.2",
              inputPerMillionUsd: 0,
              outputPerMillionUsd: 0,
            },
          ],
        },
      })
    ).toBe(true);
  });
});
