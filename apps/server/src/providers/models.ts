import {
  type CustomModelEntry,
  findCustomModel,
  getBuiltinProviderDefinition,
  isSubscriptionProvider,
  type ProviderName,
  validateCustomModels,
} from "@atlas/core";
import type { ProviderModelOption as ContractProviderModelOption } from "@atlas/core/contract";

export type ProviderModelOption = ContractProviderModelOption & {
  contextWindow: number;
  maxOutputTokens: number;
};

export const AVAILABLE_MODELS: ProviderModelOption[] = [
  {
    contextWindow: 200_000,
    default: true,
    id: "claude-sonnet-4-6",
    maxOutputTokens: 8192,
    name: "Sonnet 4.6",
    provider: "claude",
    reasoningEffortValues: ["low", "medium", "high", "xhigh"],
  },
  {
    contextWindow: 200_000,
    id: "claude-opus-4-6",
    maxOutputTokens: 8192,
    name: "Opus 4.6",
    provider: "claude",
    reasoningEffortValues: ["low", "medium", "high", "xhigh"],
  },
  {
    contextWindow: 200_000,
    default: true,
    id: "claude-sonnet-4-6",
    inputPerMillionUsd: 3,
    maxOutputTokens: 8192,
    name: "Sonnet 4.6",
    outputPerMillionUsd: 15,
    provider: "anthropic",
    reasoningEffortValues: ["low", "medium", "high", "xhigh"],
  },
  {
    contextWindow: 200_000,
    id: "claude-opus-4-6",
    inputPerMillionUsd: 15,
    maxOutputTokens: 8192,
    name: "Opus 4.6",
    outputPerMillionUsd: 75,
    provider: "anthropic",
    reasoningEffortValues: ["low", "medium", "high", "xhigh"],
  },
  {
    contextWindow: 128_000,
    id: "gpt-5.5",
    inputPerMillionUsd: 2.5,
    maxOutputTokens: 8192,
    name: "GPT-5.5",
    outputPerMillionUsd: 10,
    provider: "openai",
    reasoningEffortValues: ["low", "medium", "high"],
  },
  {
    contextWindow: 128_000,
    default: true,
    id: "gpt-5.4",
    inputPerMillionUsd: 2,
    maxOutputTokens: 8192,
    name: "GPT-5.4",
    outputPerMillionUsd: 8,
    provider: "openai",
    reasoningEffortValues: ["low", "medium", "high"],
  },
  {
    contextWindow: 128_000,
    default: true,
    id: "gpt-5.4",
    maxOutputTokens: 8192,
    name: "GPT-5.4",
    provider: "chatgpt",
    reasoningEffortValues: ["low", "medium", "high"],
  },
  {
    contextWindow: 128_000,
    id: "gpt-5.3-codex",
    maxOutputTokens: 8192,
    name: "GPT-5.3 Codex",
    provider: "chatgpt",
    reasoningEffortValues: ["low", "medium", "high"],
  },
  {
    contextWindow: 128_000,
    id: "gpt-5.3-codex",
    inputPerMillionUsd: 1.5,
    maxOutputTokens: 8192,
    name: "GPT-5.3 Codex",
    outputPerMillionUsd: 6,
    provider: "openai",
    reasoningEffortValues: ["low", "medium", "high"],
  },
  {
    contextWindow: 128_000,
    id: "gpt-4o-mini",
    inputPerMillionUsd: 0.15,
    maxOutputTokens: 16_384,
    name: "GPT-4o mini",
    outputPerMillionUsd: 0.6,
    provider: "openai",
    supportsThinking: false,
  },
  {
    contextWindow: 1_048_576,
    default: true,
    id: "gemini-3-flash-preview",
    inputPerMillionUsd: 0.5,
    maxOutputTokens: 65_536,
    name: "Gemini 3 Flash",
    outputPerMillionUsd: 3.0,
    provider: "gemini",
    reasoningEffortValues: ["low", "medium", "high"],
    supportsThinking: true,
  },
  {
    contextWindow: 1_048_576,
    id: "gemini-3.1-flash-lite",
    inputPerMillionUsd: 0.25,
    maxOutputTokens: 65_536,
    name: "Gemini 3.1 Flash Lite",
    outputPerMillionUsd: 1.5,
    provider: "gemini",
    reasoningEffortValues: ["low", "medium", "high"],
    supportsThinking: true,
  },
  {
    contextWindow: 1_048_576,
    id: "gemini-3.5-flash",
    inputPerMillionUsd: 1.5,
    maxOutputTokens: 65_536,
    name: "Gemini 3.5 Flash",
    outputPerMillionUsd: 9.0,
    provider: "gemini",
    reasoningEffortValues: ["low", "medium", "high"],
    supportsThinking: true,
  },
  {
    contextWindow: 1_000_000,
    default: true,
    id: "deepseek-v4-flash",
    inputPerMillionUsd: 0.14,
    maxOutputTokens: 384_000,
    name: "DeepSeek V4 Flash",
    outputPerMillionUsd: 0.28,
    provider: "deepseek",
    reasoningEffortValues: ["low", "high", "max"],
    supportsThinking: true,
  },
  {
    contextWindow: 1_000_000,
    id: "deepseek-v4-pro",
    inputPerMillionUsd: 0.435,
    maxOutputTokens: 384_000,
    name: "DeepSeek V4 Pro",
    outputPerMillionUsd: 0.87,
    provider: "deepseek",
    reasoningEffortValues: ["low", "high", "max"],
    supportsThinking: true,
  },
  {
    contextWindow: 131_072,
    default: true,
    id: "gpt-oss-120b",
    inputPerMillionUsd: 0.35,
    maxOutputTokens: 40_960,
    name: "OpenAI GPT OSS",
    outputPerMillionUsd: 0.75,
    provider: "cerebras",
    supportsThinking: true,
    supportsVision: false,
  },
  {
    contextWindow: 131_072,
    id: "gemma-4-31b",
    inputPerMillionUsd: 0.99,
    maxOutputTokens: 40_960,
    name: "Gemma 4 31B",
    outputPerMillionUsd: 1.49,
    provider: "cerebras",
    supportsThinking: true,
    supportsVision: true,
  },
  {
    contextWindow: 131_072,
    id: "zai-glm-4.7",
    inputPerMillionUsd: 2.25,
    maxOutputTokens: 40_960,
    name: "Z.ai GLM 4.7",
    outputPerMillionUsd: 2.75,
    provider: "cerebras",
    supportsThinking: true,
    supportsVision: false,
  },
  {
    contextWindow: 262_144,
    default: true,
    id: "accounts/fireworks/models/kimi-k2p6",
    inputPerMillionUsd: 0.6,
    maxOutputTokens: 65_536,
    name: "Kimi K2.6",
    outputPerMillionUsd: 2.5,
    provider: "fireworks",
    supportsThinking: true,
    supportsVision: false,
  },
  {
    contextWindow: 131_072,
    id: "accounts/fireworks/models/glm-5p2",
    inputPerMillionUsd: 0.55,
    maxOutputTokens: 40_960,
    name: "GLM 5.2",
    outputPerMillionUsd: 2.19,
    provider: "fireworks",
    supportsThinking: true,
    supportsVision: false,
  },
  {
    contextWindow: 131_072,
    id: "accounts/fireworks/models/gpt-oss-120b",
    inputPerMillionUsd: 0.15,
    maxOutputTokens: 40_960,
    name: "GPT OSS 120B",
    outputPerMillionUsd: 0.6,
    provider: "fireworks",
    supportsThinking: true,
    supportsVision: false,
  },
  {
    contextWindow: 262_144,
    id: "accounts/fireworks/models/kimi-k2p5",
    inputPerMillionUsd: 0.6,
    maxOutputTokens: 65_536,
    name: "Kimi K2.5",
    outputPerMillionUsd: 2.5,
    provider: "fireworks",
    supportsThinking: true,
    supportsVision: true,
  },
  {
    contextWindow: 200_000,
    id: "opencode-go/grok-4.6",
    inputPerMillionUsd: 2,
    maxOutputTokens: 65_536,
    name: "Grok 4.6",
    outputPerMillionUsd: 6,
    provider: "opencode_go",
  },
  {
    contextWindow: 272_000,
    id: "opencode-go/gpt-5.6-luna",
    inputPerMillionUsd: 0.2,
    maxOutputTokens: 65_536,
    name: "GPT 5.6 Luna",
    outputPerMillionUsd: 1.2,
    provider: "opencode_go",
  },
  {
    contextWindow: 204_800,
    id: "opencode-go/glm-5.3-flash",
    inputPerMillionUsd: 0.15,
    maxOutputTokens: 131_072,
    name: "GLM 5.3 Flash",
    outputPerMillionUsd: 0.5,
    provider: "opencode_go",
  },
  {
    contextWindow: 204_800,
    id: "opencode-go/glm-5.3",
    inputPerMillionUsd: 1.4,
    maxOutputTokens: 131_072,
    name: "GLM 5.3",
    outputPerMillionUsd: 4.4,
    provider: "opencode_go",
  },
  {
    contextWindow: 204_800,
    id: "opencode-go/glm-5.2",
    inputPerMillionUsd: 1.4,
    maxOutputTokens: 131_072,
    name: "GLM 5.2",
    outputPerMillionUsd: 4.4,
    provider: "opencode_go",
  },
  {
    contextWindow: 204_800,
    id: "opencode-go/glm-5.1",
    inputPerMillionUsd: 1.4,
    maxOutputTokens: 131_072,
    name: "GLM 5.1",
    outputPerMillionUsd: 4.4,
    provider: "opencode_go",
  },
  {
    contextWindow: 204_800,
    id: "opencode-go/glm-5",
    inputPerMillionUsd: 1,
    maxOutputTokens: 131_072,
    name: "GLM 5",
    outputPerMillionUsd: 3.2,
    provider: "opencode_go",
  },
  {
    contextWindow: 262_144,
    default: true,
    id: "opencode-go/kimi-k2.7-code",
    inputPerMillionUsd: 0.95,
    maxOutputTokens: 262_144,
    name: "Kimi K2.7 Code",
    outputPerMillionUsd: 4,
    provider: "opencode_go",
  },
  {
    contextWindow: 262_144,
    id: "opencode-go/kimi-k3",
    inputPerMillionUsd: 3,
    maxOutputTokens: 65_536,
    name: "Kimi K3",
    outputPerMillionUsd: 15,
    provider: "opencode_go",
  },
  {
    contextWindow: 262_144,
    id: "opencode-go/kimi-k2.6",
    inputPerMillionUsd: 0.95,
    maxOutputTokens: 65_536,
    name: "Kimi K2.6",
    outputPerMillionUsd: 4,
    provider: "opencode_go",
  },
  {
    contextWindow: 262_144,
    id: "opencode-go/longcat-2.0",
    inputPerMillionUsd: 0.3,
    maxOutputTokens: 65_536,
    name: "LongCat 2.0",
    outputPerMillionUsd: 1.2,
    provider: "opencode_go",
  },
  {
    contextWindow: 1_000_000,
    id: "opencode-go/deepseek-v4-pro",
    inputPerMillionUsd: 1.74,
    maxOutputTokens: 384_000,
    name: "DeepSeek V4 Pro",
    outputPerMillionUsd: 3.48,
    provider: "opencode_go",
  },
  {
    contextWindow: 1_000_000,
    id: "opencode-go/deepseek-v4-flash",
    inputPerMillionUsd: 0.14,
    maxOutputTokens: 384_000,
    name: "DeepSeek V4 Flash",
    outputPerMillionUsd: 0.28,
    provider: "opencode_go",
  },
  {
    contextWindow: 1_000_000,
    id: "opencode-go/deepseek-v4-flash-vision-exp",
    inputPerMillionUsd: 0.22,
    maxOutputTokens: 384_000,
    name: "DeepSeek V4 Flash Vision Exp",
    outputPerMillionUsd: 0.66,
    provider: "opencode_go",
    supportsVision: true,
  },
  {
    contextWindow: 262_144,
    id: "opencode-go/mimo-v2.5",
    inputPerMillionUsd: 0.14,
    maxOutputTokens: 65_536,
    name: "MiMo V2.5",
    outputPerMillionUsd: 0.28,
    provider: "opencode_go",
  },
  {
    contextWindow: 262_144,
    id: "opencode-go/mimo-v2.5-pro",
    inputPerMillionUsd: 1.74,
    maxOutputTokens: 65_536,
    name: "MiMo V2.5 Pro",
    outputPerMillionUsd: 3.48,
    provider: "opencode_go",
  },
  {
    contextWindow: 256_000,
    id: "opencode-go/minimax-m3",
    inputPerMillionUsd: 0.3,
    maxOutputTokens: 64_000,
    name: "MiniMax M3",
    outputPerMillionUsd: 1.2,
    provider: "opencode_go",
  },
  {
    contextWindow: 204_800,
    id: "opencode-go/minimax-m2.7",
    inputPerMillionUsd: 0.3,
    maxOutputTokens: 131_072,
    name: "MiniMax M2.7",
    outputPerMillionUsd: 1.2,
    provider: "opencode_go",
  },
  {
    contextWindow: 204_800,
    id: "opencode-go/minimax-m2.5",
    inputPerMillionUsd: 0.3,
    maxOutputTokens: 131_072,
    name: "MiniMax M2.5",
    outputPerMillionUsd: 1.2,
    provider: "opencode_go",
  },
  {
    contextWindow: 262_144,
    id: "opencode-go/qwen3.8-max",
    inputPerMillionUsd: 2,
    maxOutputTokens: 65_536,
    name: "Qwen3.8 Max",
    outputPerMillionUsd: 6,
    provider: "opencode_go",
  },
  {
    contextWindow: 262_144,
    id: "opencode-go/qwen3.8-flash",
    inputPerMillionUsd: 0.15,
    maxOutputTokens: 65_536,
    name: "Qwen3.8 Flash",
    outputPerMillionUsd: 0.47,
    provider: "opencode_go",
  },
  {
    contextWindow: 262_144,
    id: "opencode-go/qwen3.7-max",
    inputPerMillionUsd: 2.5,
    maxOutputTokens: 65_536,
    name: "Qwen3.7 Max",
    outputPerMillionUsd: 7.5,
    provider: "opencode_go",
  },
  {
    contextWindow: 262_144,
    id: "opencode-go/qwen3.7-plus",
    inputPerMillionUsd: 0.4,
    maxOutputTokens: 65_536,
    name: "Qwen3.7 Plus",
    outputPerMillionUsd: 1.6,
    provider: "opencode_go",
  },
  {
    contextWindow: 262_144,
    id: "opencode-go/qwen3.6-plus",
    inputPerMillionUsd: 0.5,
    maxOutputTokens: 65_536,
    name: "Qwen3.6 Plus",
    outputPerMillionUsd: 3,
    provider: "opencode_go",
  },
  {
    contextWindow: 262_144,
    id: "opencode-go/qwen3.5-plus",
    inputPerMillionUsd: 0.2,
    maxOutputTokens: 65_536,
    name: "Qwen3.5 Plus",
    outputPerMillionUsd: 1.2,
    provider: "opencode_go",
  },
  {
    contextWindow: 262_144,
    id: "opencode-go/hy4-preview",
    inputPerMillionUsd: 0.834,
    maxOutputTokens: 65_536,
    name: "Hy4 preview",
    outputPerMillionUsd: 2.501,
    provider: "opencode_go",
  },
  {
    contextWindow: 262_144,
    id: "opencode-go/hy3",
    inputPerMillionUsd: 0.14,
    maxOutputTokens: 65_536,
    name: "Hy3",
    outputPerMillionUsd: 0.58,
    provider: "opencode_go",
  },
  {
    contextWindow: 131_072,
    id: "opencode-go/muse-spark-1.2-contributor",
    inputPerMillionUsd: 0.1,
    maxOutputTokens: 65_536,
    name: "Muse Spark 1.2 Contributor",
    outputPerMillionUsd: 0.2,
    provider: "opencode_go",
  },
  {
    contextWindow: 131_072,
    default: true,
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    inputPerMillionUsd: 0.38,
    maxOutputTokens: 40_960,
    name: "Llama 3.3 70B (FP8)",
    outputPerMillionUsd: 0.38,
    provider: "cloudflare",
    supportsThinking: false,
    supportsVision: false,
  },
  {
    contextWindow: 7968,
    id: "@cf/meta/llama-3.1-8b-instruct",
    inputPerMillionUsd: 0.28,
    maxOutputTokens: 4096,
    name: "Llama 3.1 8B",
    outputPerMillionUsd: 0.83,
    provider: "cloudflare",
    supportsThinking: false,
    supportsVision: false,
  },
  {
    contextWindow: 128_000,
    id: "@cf/meta/llama-3.1-8b-instruct-fast",
    inputPerMillionUsd: 0.14,
    maxOutputTokens: 40_960,
    name: "Llama 3.1 8B (Fast)",
    outputPerMillionUsd: 0.14,
    provider: "cloudflare",
    supportsThinking: false,
    supportsVision: false,
  },
  {
    contextWindow: 131_072,
    id: "@cf/meta/llama-4-scout-17b-16e-instruct",
    inputPerMillionUsd: 0.3,
    maxOutputTokens: 40_960,
    name: "Llama 4 Scout 17B",
    outputPerMillionUsd: 0.3,
    provider: "cloudflare",
    supportsThinking: false,
    supportsVision: false,
  },
  {
    contextWindow: 131_072,
    id: "@cf/qwen/qwen2.5-coder-32b-instruct",
    inputPerMillionUsd: 0.38,
    maxOutputTokens: 40_960,
    name: "Qwen 2.5 Coder 32B",
    outputPerMillionUsd: 0.38,
    provider: "cloudflare",
    supportsThinking: false,
    supportsVision: false,
  },
  {
    contextWindow: 131_072,
    id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    inputPerMillionUsd: 0.35,
    maxOutputTokens: 40_960,
    name: "DeepSeek R1 Distill Qwen 32B",
    outputPerMillionUsd: 0.7,
    provider: "cloudflare",
    supportsThinking: false,
    supportsVision: false,
  },
];

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
  const definition = getBuiltinProviderDefinition(provider);
  const aliased = trimmed
    ? definition?.deprecatedModelAliases?.[trimmed]
    : undefined;

  if (aliased) {
    return aliased;
  }

  if (
    trimmed &&
    definition?.modelIdPolicy === "provider-qualified" &&
    isOpenRouterModelSlug(trimmed)
  ) {
    return trimmed;
  }

  if (trimmed && customModels?.length) {
    if (findCustomModel(customModels, trimmed)) {
      return trimmed;
    }
    return getDefaultModel(provider, customModels);
  }

  if (
    trimmed &&
    getModelsForProvider(provider).some((option) => option.id === trimmed)
  ) {
    return trimmed;
  }

  if (trimmed && definition?.modelIdPolicy === "passthrough") {
    return trimmed;
  }

  return getDefaultModel(provider, customModels);
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
