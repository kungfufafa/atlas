import {
  AtlasApiError,
  type CustomModelEntry,
  findCustomModel,
  getBuiltinProviderDefinition,
  isSubscriptionProvider,
  type ProviderName,
  validateCustomModels,
} from "@atlas/core";
import type { ProviderModelOption as ContractProviderModelOption } from "@atlas/core/contract";

import { documentedOpenAIModelMetadata } from "./openai/model-metadata";

export type ProviderModelOption = ContractProviderModelOption;

const MODEL_CHOICES: ProviderModelOption[] = [
  {
    default: true,
    id: "claude-sonnet-4-6",
    name: "Sonnet 4.6",
    provider: "claude",
  },
  {
    id: "claude-opus-4-6",
    name: "Opus 4.6",
    provider: "claude",
  },
  {
    default: true,
    id: "claude-sonnet-4-6",
    inputPerMillionUsd: 3,
    name: "Sonnet 4.6",
    outputPerMillionUsd: 15,
    provider: "anthropic",
  },
  {
    id: "claude-opus-4-6",
    inputPerMillionUsd: 15,
    name: "Opus 4.6",
    outputPerMillionUsd: 75,
    provider: "anthropic",
  },
  {
    id: "gpt-5.5",
    inputPerMillionUsd: 2.5,
    name: "GPT-5.5",
    outputPerMillionUsd: 10,
    provider: "openai",
  },
  {
    default: true,
    id: "gpt-5.4",
    inputPerMillionUsd: 2,
    name: "GPT-5.4",
    outputPerMillionUsd: 8,
    provider: "openai",
  },
  {
    default: true,
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "chatgpt",
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    provider: "chatgpt",
  },
  {
    id: "gpt-5.3-codex",
    inputPerMillionUsd: 1.5,
    name: "GPT-5.3 Codex",
    outputPerMillionUsd: 6,
    provider: "openai",
  },
  {
    id: "gpt-4o-mini",
    inputPerMillionUsd: 0.15,
    name: "GPT-4o mini",
    outputPerMillionUsd: 0.6,
    provider: "openai",
  },
  {
    default: true,
    id: "gemini-3-flash-preview",
    inputPerMillionUsd: 0.5,
    name: "Gemini 3 Flash",
    outputPerMillionUsd: 3.0,
    provider: "gemini",
  },
  {
    id: "gemini-3.1-flash-lite",
    inputPerMillionUsd: 0.25,
    name: "Gemini 3.1 Flash Lite",
    outputPerMillionUsd: 1.5,
    provider: "gemini",
  },
  {
    id: "gemini-3.5-flash",
    inputPerMillionUsd: 1.5,
    name: "Gemini 3.5 Flash",
    outputPerMillionUsd: 9.0,
    provider: "gemini",
  },
  {
    default: true,
    id: "deepseek-v4-flash",
    inputPerMillionUsd: 0.14,
    name: "DeepSeek V4 Flash",
    outputPerMillionUsd: 0.28,
    provider: "deepseek",
  },
  {
    id: "deepseek-v4-pro",
    inputPerMillionUsd: 0.435,
    name: "DeepSeek V4 Pro",
    outputPerMillionUsd: 0.87,
    provider: "deepseek",
  },
  {
    default: true,
    id: "gpt-oss-120b",
    inputPerMillionUsd: 0.35,
    name: "OpenAI GPT OSS",
    outputPerMillionUsd: 0.75,
    provider: "cerebras",
  },
  {
    id: "gemma-4-31b",
    inputPerMillionUsd: 0.99,
    name: "Gemma 4 31B",
    outputPerMillionUsd: 1.49,
    provider: "cerebras",
  },
  {
    id: "zai-glm-4.7",
    inputPerMillionUsd: 2.25,
    name: "Z.ai GLM 4.7",
    outputPerMillionUsd: 2.75,
    provider: "cerebras",
  },
  {
    default: true,
    id: "accounts/fireworks/models/kimi-k2p6",
    inputPerMillionUsd: 0.6,
    name: "Kimi K2.6",
    outputPerMillionUsd: 2.5,
    provider: "fireworks",
  },
  {
    id: "accounts/fireworks/models/glm-5p2",
    inputPerMillionUsd: 0.55,
    name: "GLM 5.2",
    outputPerMillionUsd: 2.19,
    provider: "fireworks",
  },
  {
    id: "accounts/fireworks/models/gpt-oss-120b",
    inputPerMillionUsd: 0.15,
    name: "GPT OSS 120B",
    outputPerMillionUsd: 0.6,
    provider: "fireworks",
  },
  {
    id: "accounts/fireworks/models/kimi-k2p5",
    inputPerMillionUsd: 0.6,
    name: "Kimi K2.5",
    outputPerMillionUsd: 2.5,
    provider: "fireworks",
  },
  {
    id: "opencode-go/grok-4.6",
    inputPerMillionUsd: 2,
    name: "Grok 4.6",
    outputPerMillionUsd: 6,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/gpt-5.6-luna",
    inputPerMillionUsd: 0.2,
    name: "GPT 5.6 Luna",
    outputPerMillionUsd: 1.2,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/glm-5.3-flash",
    inputPerMillionUsd: 0.15,
    name: "GLM 5.3 Flash",
    outputPerMillionUsd: 0.5,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/glm-5.3",
    inputPerMillionUsd: 1.4,
    name: "GLM 5.3",
    outputPerMillionUsd: 4.4,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/glm-5.2",
    inputPerMillionUsd: 1.4,
    name: "GLM 5.2",
    outputPerMillionUsd: 4.4,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/glm-5.1",
    inputPerMillionUsd: 1.4,
    name: "GLM 5.1",
    outputPerMillionUsd: 4.4,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/glm-5",
    inputPerMillionUsd: 1,
    name: "GLM 5",
    outputPerMillionUsd: 3.2,
    provider: "opencode_go",
  },
  {
    default: true,
    id: "opencode-go/kimi-k2.7-code",
    inputPerMillionUsd: 0.95,
    name: "Kimi K2.7 Code",
    outputPerMillionUsd: 4,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/kimi-k3",
    inputPerMillionUsd: 3,
    name: "Kimi K3",
    outputPerMillionUsd: 15,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/kimi-k2.6",
    inputPerMillionUsd: 0.95,
    name: "Kimi K2.6",
    outputPerMillionUsd: 4,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/longcat-2.0",
    inputPerMillionUsd: 0.3,
    name: "LongCat 2.0",
    outputPerMillionUsd: 1.2,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/deepseek-v4-pro",
    inputPerMillionUsd: 1.74,
    name: "DeepSeek V4 Pro",
    outputPerMillionUsd: 3.48,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/deepseek-v4-flash",
    inputPerMillionUsd: 0.14,
    name: "DeepSeek V4 Flash",
    outputPerMillionUsd: 0.28,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/deepseek-v4-flash-vision-exp",
    inputPerMillionUsd: 0.22,
    name: "DeepSeek V4 Flash Vision Exp",
    outputPerMillionUsd: 0.66,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/mimo-v2.5",
    inputPerMillionUsd: 0.14,
    name: "MiMo V2.5",
    outputPerMillionUsd: 0.28,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/mimo-v2.5-pro",
    inputPerMillionUsd: 1.74,
    name: "MiMo V2.5 Pro",
    outputPerMillionUsd: 3.48,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/minimax-m3",
    inputPerMillionUsd: 0.3,
    name: "MiniMax M3",
    outputPerMillionUsd: 1.2,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/minimax-m2.7",
    inputPerMillionUsd: 0.3,
    name: "MiniMax M2.7",
    outputPerMillionUsd: 1.2,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/minimax-m2.5",
    inputPerMillionUsd: 0.3,
    name: "MiniMax M2.5",
    outputPerMillionUsd: 1.2,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/qwen3.8-max",
    inputPerMillionUsd: 2,
    name: "Qwen3.8 Max",
    outputPerMillionUsd: 6,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/qwen3.8-flash",
    inputPerMillionUsd: 0.15,
    name: "Qwen3.8 Flash",
    outputPerMillionUsd: 0.47,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/qwen3.7-max",
    inputPerMillionUsd: 2.5,
    name: "Qwen3.7 Max",
    outputPerMillionUsd: 7.5,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/qwen3.7-plus",
    inputPerMillionUsd: 0.4,
    name: "Qwen3.7 Plus",
    outputPerMillionUsd: 1.6,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/qwen3.6-plus",
    inputPerMillionUsd: 0.5,
    name: "Qwen3.6 Plus",
    outputPerMillionUsd: 3,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/qwen3.5-plus",
    inputPerMillionUsd: 0.2,
    name: "Qwen3.5 Plus",
    outputPerMillionUsd: 1.2,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/hy4-preview",
    inputPerMillionUsd: 0.834,
    name: "Hy4 preview",
    outputPerMillionUsd: 2.501,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/hy3",
    inputPerMillionUsd: 0.14,
    name: "Hy3",
    outputPerMillionUsd: 0.58,
    provider: "opencode_go",
  },
  {
    id: "opencode-go/muse-spark-1.2-contributor",
    inputPerMillionUsd: 0.1,
    name: "Muse Spark 1.2 Contributor",
    outputPerMillionUsd: 0.2,
    provider: "opencode_go",
  },
  {
    default: true,
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    inputPerMillionUsd: 0.38,
    name: "Llama 3.3 70B (FP8)",
    outputPerMillionUsd: 0.38,
    provider: "cloudflare",
  },
  {
    id: "@cf/meta/llama-3.1-8b-instruct",
    inputPerMillionUsd: 0.28,
    name: "Llama 3.1 8B",
    outputPerMillionUsd: 0.83,
    provider: "cloudflare",
  },
  {
    id: "@cf/meta/llama-3.1-8b-instruct-fast",
    inputPerMillionUsd: 0.14,
    name: "Llama 3.1 8B (Fast)",
    outputPerMillionUsd: 0.14,
    provider: "cloudflare",
  },
  {
    id: "@cf/meta/llama-4-scout-17b-16e-instruct",
    inputPerMillionUsd: 0.3,
    name: "Llama 4 Scout 17B",
    outputPerMillionUsd: 0.3,
    provider: "cloudflare",
  },
  {
    id: "@cf/qwen/qwen2.5-coder-32b-instruct",
    inputPerMillionUsd: 0.38,
    name: "Qwen 2.5 Coder 32B",
    outputPerMillionUsd: 0.38,
    provider: "cloudflare",
  },
  {
    id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    inputPerMillionUsd: 0.35,
    name: "DeepSeek R1 Distill Qwen 32B",
    outputPerMillionUsd: 0.7,
    provider: "cloudflare",
  },
];

// Legacy choices are labels, not runtime evidence. Only the documented exact
// OpenAI API metadata is supplemented here; live/configured fields take priority.
export const AVAILABLE_MODELS: ProviderModelOption[] = MODEL_CHOICES.map(
  (model) =>
    model.provider === "openai"
      ? { ...model, ...documentedOpenAIModelMetadata(model.id) }
      : model
);

const OPENROUTER_MODEL_SLUG_PATTERN = /^[\w.-]+\/[\w.:-]+$/;

export function isOpenRouterModelSlug(model: string): boolean {
  return OPENROUTER_MODEL_SLUG_PATTERN.test(model.trim());
}

export function validateOpenRouterCustomModels(
  entries: unknown
): CustomModelEntry[] {
  const models = validateCustomModels(entries);

  for (const model of models) {
    if (!isOpenRouterModelSlug(model.id)) {
      throw new Error(
        `Invalid OpenRouter model id "${model.id}". Use vendor/model format.`
      );
    }
  }

  return models;
}

export function validateCerebrasCustomModels(
  entries: unknown
): CustomModelEntry[] {
  return validateCustomModels(entries);
}

export function validateFireworksCustomModels(
  entries: unknown
): CustomModelEntry[] {
  const models = validateCustomModels(entries);

  if (!models.length) {
    throw new Error("At least one Fireworks model is required.");
  }

  return models;
}

export function validateOllamaCustomModels(
  entries: unknown
): CustomModelEntry[] {
  const models = validateCustomModels(entries);

  if (!models.length) {
    throw new Error("At least one Ollama model is required.");
  }

  return models;
}

export function isCloudflareModelId(model: string): boolean {
  const trimmed = model.trim();
  return trimmed.startsWith("@cf/") || trimmed.startsWith("@hf/");
}

export function validateCloudflareCustomModels(
  entries: unknown
): CustomModelEntry[] {
  const models = validateCustomModels(entries);

  for (const model of models) {
    if (!isCloudflareModelId(model.id)) {
      throw new Error(
        `Invalid Cloudflare model id "${model.id}". Use @cf/ or @hf/ format.`
      );
    }
  }

  return models;
}

export function isOpenCodeGoModelId(model: string): boolean {
  return model.trim().startsWith("opencode-go/");
}

/** Atlas catalog IDs use `opencode-go/<id>`; the HTTP API expects the bare `<id>`. */
export function toOpenCodeGoApiModelId(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("opencode-go/")
    ? trimmed.slice("opencode-go/".length)
    : trimmed;
}

export function validateOpenCodeGoCustomModels(
  entries: unknown
): CustomModelEntry[] {
  const models = validateCustomModels(entries);

  for (const model of models) {
    if (!isOpenCodeGoModelId(model.id)) {
      throw new Error(
        `Invalid OpenCode Go model id "${model.id}". Use opencode-go/model format.`
      );
    }
  }

  return models;
}

export function getAvailableModels(): ProviderModelOption[] {
  return AVAILABLE_MODELS;
}

export function getModelById(modelId: string): ProviderModelOption | undefined {
  const matches = AVAILABLE_MODELS.filter((model) => model.id === modelId);
  return (
    matches.find(
      (model) =>
        !isSubscriptionProvider(model.provider) && hasExplicitPricing(model)
    ) ??
    matches.find((model) => !isSubscriptionProvider(model.provider)) ??
    matches.find(hasExplicitPricing) ??
    matches[0]
  );
}

export function getModelByIdForProvider(
  modelId: string,
  provider: ProviderName
): ProviderModelOption | undefined {
  return AVAILABLE_MODELS.find(
    (model) => model.id === modelId && model.provider === provider
  );
}

export function getModelsForProvider(
  provider: ProviderName
): ProviderModelOption[] {
  return AVAILABLE_MODELS.filter((model) => model.provider === provider);
}

export function getDefaultModel(
  provider: ProviderName,
  customModels?: CustomModelEntry[]
): string {
  const customDefault = preferredCustomModel(customModels);
  if (customDefault) {
    return customDefault;
  }

  const models = getModelsForProvider(provider);
  const definition = getBuiltinProviderDefinition(provider);
  return (
    models.find((model) => model.default)?.id ??
    models[0]?.id ??
    definition?.fallbackModelId ??
    "custom-model"
  );
}

export function isValidModel(model: string): boolean {
  return AVAILABLE_MODELS.some((option) => option.id === model);
}

export function resolveModel(
  provider: ProviderName,
  model?: string,
  customModels?: CustomModelEntry[]
): string {
  const trimmed = model?.trim();
  if (!trimmed) {
    return getDefaultModel(provider, customModels);
  }

  if (customModels?.length && !findCustomModel(customModels, trimmed)) {
    throw new AtlasApiError(
      `Model "${trimmed}" is not in the configured ${provider} model list.`,
      409
    );
  }

  if (
    getBuiltinProviderDefinition(provider)?.modelIdPolicy ===
      "provider-qualified" &&
    !isOpenRouterModelSlug(trimmed)
  ) {
    throw new AtlasApiError(
      `Invalid ${provider} model id "${trimmed}". Use vendor/model format.`,
      400
    );
  }

  // An explicit choice must reach that exact model. Stale catalogs and old
  // aliases are not permission to substitute a different model at execution.
  return trimmed;
}

function preferredCustomModel(
  customModels: CustomModelEntry[] | undefined
): string | undefined {
  return (
    customModels?.find((entry) => entry.default)?.id ?? customModels?.[0]?.id
  );
}

function hasExplicitPricing(model: ProviderModelOption): boolean {
  return (
    model.inputPerMillionUsd !== undefined &&
    model.outputPerMillionUsd !== undefined
  );
}
