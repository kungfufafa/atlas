import {
  findCustomModel,
  isDiscoveryModelProvider,
  isSubscriptionProvider,
  type ProviderInstance,
  type ProviderName,
} from "@atlas/core";
import { getModelById, getModelByIdForProvider } from "./models";

export interface ModelPricing {
  /** USD per 1M input tokens */
  inputPerMillionUsd: number;
  /** USD per 1M output tokens */
  outputPerMillionUsd: number;
}

const DEFAULT_PRICING: ModelPricing = {
  inputPerMillionUsd: 1,
  outputPerMillionUsd: 3,
};

/**
 * Token-shaped pricing bridge for Images API models.
 * gpt-image-2: text input $5/MTok, image output $30/MTok (OpenAI list pricing).
 * Image-input rates are unused for v1 generate-only calls.
 */
const IMAGE_GENERATION_PRICING: Record<string, ModelPricing> = {
  "gpt-image-2": {
    inputPerMillionUsd: 5,
    outputPerMillionUsd: 30,
  },
};

export interface PricingContext {
  provider?: ProviderName | null;
  providerInstance?: ProviderInstance | null;
}

function getCustomModelPricing(
  modelId: string,
  context: PricingContext
): ModelPricing | null {
  const entry = findCustomModel(
    context.providerInstance?.customModels,
    modelId
  );

  if (
    entry?.inputPerMillionUsd !== undefined &&
    entry.outputPerMillionUsd !== undefined
  ) {
    return {
      inputPerMillionUsd: entry.inputPerMillionUsd,
      outputPerMillionUsd: entry.outputPerMillionUsd,
    };
  }

  return null;
}

export function getModelPricing(
  modelId: string,
  context: PricingContext = {}
): ModelPricing | null {
  const provider = context.provider ?? context.providerInstance?.type ?? null;

  if (provider !== null && isSubscriptionProvider(provider)) {
    return null;
  }

  const imagePricing = IMAGE_GENERATION_PRICING[modelId];
  if (imagePricing) {
    return imagePricing;
  }

  const customPricing = getCustomModelPricing(modelId, context);
  if (customPricing) {
    return customPricing;
  }

  if (
    (provider !== null && isDiscoveryModelProvider(provider)) ||
    provider === "openrouter" ||
    provider === "cerebras" ||
    provider === "fireworks" ||
    provider === "ollama"
  ) {
    return null;
  }

  const catalog = provider
    ? getModelByIdForProvider(modelId, provider)
    : getModelById(modelId);

  if (
    catalog?.inputPerMillionUsd != null &&
    catalog.outputPerMillionUsd != null
  ) {
    return {
      inputPerMillionUsd: catalog.inputPerMillionUsd,
      outputPerMillionUsd: catalog.outputPerMillionUsd,
    };
  }

  return DEFAULT_PRICING;
}

export function estimateUsageCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  context: PricingContext = {}
): number {
  const pricing = getModelPricing(modelId, context);

  if (!pricing) {
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillionUsd;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillionUsd;
  return inputCost + outputCost;
}

export function hasCatalogPricing(
  modelId: string,
  context: PricingContext = {}
): boolean {
  return getModelPricing(modelId, context) !== null;
}

export function isCostEstimated(
  provider: ProviderName | null,
  modelId: string | null,
  providerInstance: ProviderInstance | null | undefined
): boolean {
  if (!(provider && modelId)) {
    return false;
  }

  return hasCatalogPricing(modelId, { provider, providerInstance });
}
