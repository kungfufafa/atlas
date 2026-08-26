import type { ProviderName } from "@atlas/core";
import {
  type CustomModelEntry,
  findCustomModel,
  isDiscoveryModelProvider,
  validateCustomModels,
} from "@atlas/core";
import type { ProviderModelOption as ContractProviderModelOption } from "@atlas/core/contract";
import {
  resolveCerebrasDefaultModel,
  resolveCompatibleDefaultModel,
  resolveFireworksDefaultModel,
  resolveOllamaDefaultModel,
  resolveOpenRouterDefaultModel,
} from "./compatible-models";

export type ProviderModelOption = ContractProviderModelOption & {
  contextWindow: number;
  maxOutputTokens: number;
};

function withVisionDefaults(
  models: ProviderModelOption[]
): ProviderModelOption[] {
  return models.map((model) => ({
    ...model,
    supportsVision:
      model.provider === "opencode_go" || model.provider === "deepseek"
        ? false
        : model.provider === "openai" ||
            model.provider === "anthropic" ||
            model.provider === "gemini"
          ? true
          : model.supportsVision,
  }));
}

export const AVAILABLE_MODELS: ProviderModelOption[] = withVisionDefaults([
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
    id: "opencode-go/kimi-k2.6",
    inputPerMillionUsd: 0.95,
    maxOutputTokens: 65_536,
    name: "Kimi K2.6",
    outputPerMillionUsd: 4,
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
]);

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
  return AVAILABLE_MODELS.find((model) => model.id === modelId);
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
  if (isDiscoveryModelProvider(provider)) {
    return resolveCompatibleDefaultModel(customModels);
  }

  if (provider === "openrouter" && customModels?.length) {
    return resolveOpenRouterDefaultModel(customModels);
  }

  if (provider === "cerebras" && customModels?.length) {
    return resolveCerebrasDefaultModel(customModels);
  }

  if (provider === "fireworks" && customModels?.length) {
    return resolveFireworksDefaultModel(customModels);
  }

  if (provider === "ollama" && customModels?.length) {
    return resolveOllamaDefaultModel(customModels);
  }

  if (
    (provider === "openai" ||
      provider === "anthropic" ||
      provider === "gemini" ||
      provider === "deepseek" ||
      provider === "opencode_go" ||
      provider === "cloudflare") &&
    customModels?.length
  ) {
    return resolveCompatibleDefaultModel(customModels, undefined);
  }

  const models = getModelsForProvider(provider);
  const fallback =
    provider === "openrouter"
      ? "anthropic/claude-sonnet-4-6"
      : provider === "anthropic"
        ? "claude-sonnet-4-6"
        : provider === "gemini"
          ? "gemini-3-flash-preview"
          : provider === "deepseek"
            ? "deepseek-v4-flash"
            : provider === "cerebras"
              ? "gpt-oss-120b"
              : provider === "fireworks"
                ? "accounts/fireworks/models/kimi-k2p6"
                : provider === "opencode_go"
                  ? "opencode-go/kimi-k2.7-code"
                  : provider === "cloudflare"
                    ? "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
                    : "gpt-5.4";
  return models.find((model) => model.default)?.id ?? models[0]?.id ?? fallback;
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

  if (
    provider === "gemini" &&
    trimmed &&
    (trimmed === "gemini-2.0-flash" ||
      trimmed === "gemini-2.0-flash-lite" ||
      trimmed === "gemini-1.5-flash" ||
      trimmed === "gemini-1.5-pro" ||
      trimmed === "gemini-2.0-pro-exp-02-05" ||
      trimmed === "gemini-2.5-flash" ||
      trimmed === "gemini-2.5-flash-lite" ||
      trimmed === "gemini-2.5-pro")
  ) {
    return "gemini-3-flash-preview";
  }

  if (trimmed && provider === "openrouter" && isOpenRouterModelSlug(trimmed)) {
    return trimmed;
  }

  if (trimmed && provider === "cerebras" && customModels?.length) {
    if (findCustomModel(customModels, trimmed)) {
      return trimmed;
    }

    return resolveCerebrasDefaultModel(customModels, trimmed);
  }

  if (trimmed && provider === "fireworks" && customModels?.length) {
    if (findCustomModel(customModels, trimmed)) {
      return trimmed;
    }

    return resolveFireworksDefaultModel(customModels, trimmed);
  }

  if (trimmed && provider === "ollama" && customModels?.length) {
    if (findCustomModel(customModels, trimmed)) {
      return trimmed;
    }

    return resolveOllamaDefaultModel(customModels, trimmed);
  }

  if (trimmed && provider === "cloudflare" && customModels?.length) {
    if (findCustomModel(customModels, trimmed)) {
      return trimmed;
    }

    return resolveCompatibleDefaultModel(customModels, trimmed);
  }

  if (trimmed && isDiscoveryModelProvider(provider)) {
    if (findCustomModel(customModels, trimmed)) {
      return trimmed;
    }

    return resolveCompatibleDefaultModel(customModels, trimmed);
  }

  if (
    trimmed &&
    (provider === "openai" ||
      provider === "anthropic" ||
      provider === "gemini" ||
      provider === "deepseek" ||
      provider === "cerebras" ||
      provider === "fireworks" ||
      provider === "opencode_go") &&
    customModels?.length
  ) {
    if (findCustomModel(customModels, trimmed)) {
      return trimmed;
    }

    return resolveCompatibleDefaultModel(customModels, trimmed);
  }

  if (
    trimmed &&
    getModelsForProvider(provider).some((option) => option.id === trimmed)
  ) {
    return trimmed;
  }

  if (
    trimmed &&
    (provider === "openai" ||
      provider === "anthropic" ||
      provider === "gemini" ||
      provider === "opencode_go")
  ) {
    return trimmed;
  }

  return getDefaultModel(provider, customModels);
}

export function modelSupportsVision(
  modelId: string,
  provider: ProviderName,
  customModels?: CustomModelEntry[]
): boolean | undefined {
  const custom = findCustomModel(customModels, modelId);

  if (custom?.supportsVision !== undefined) {
    return custom.supportsVision;
  }

  if (
    isDiscoveryModelProvider(provider) ||
    provider === "opencode_go" ||
    provider === "deepseek"
  ) {
    return false;
  }

  if (
    provider === "cerebras" ||
    provider === "fireworks" ||
    provider === "ollama"
  ) {
    if (custom?.supportsVision !== undefined) {
      return custom.supportsVision;
    }

    const catalog = getModelById(modelId);
    return catalog?.supportsVision ?? false;
  }

  const catalog = getModelById(modelId);

  if (catalog?.supportsVision !== undefined) {
    return catalog.supportsVision;
  }

  if (
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "gemini"
  ) {
    return true;
  }
}

export const TRANSCRIPTION_MODEL_IDS = new Set([
  "whisper-1",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
]);

export function modelSupportsTranscription(
  modelId: string,
  provider: ProviderName
): boolean {
  const trimmed = modelId.trim();
  if (provider === "openai") {
    return (
      TRANSCRIPTION_MODEL_IDS.has(trimmed) ||
      trimmed.startsWith("whisper") ||
      trimmed.includes("transcribe")
    );
  }

  if (provider === "gemini") {
    return TRANSCRIPTION_MODEL_IDS.has(trimmed) || trimmed.startsWith("gemini");
  }

  if (
    provider === "openai_compatible" ||
    provider === "openrouter" ||
    provider === "ollama" ||
    provider === "fireworks" ||
    provider === "cerebras"
  ) {
    return Boolean(trimmed);
  }

  return false;
}

export const IMAGE_GENERATION_MODEL_ID = "gpt-image-2";
export const IMAGE_GENERATION_SELECTION = `openai::${IMAGE_GENERATION_MODEL_ID}`;

export const IMAGE_GENERATION_MODEL_IDS = new Set([
  "gpt-image-2",
  "dall-e-3",
  "dall-e-2",
  "imagen-3.0-generate-002",
  "imagen-3",
]);

export function modelSupportsImageGeneration(
  modelId: string,
  provider: ProviderName
): boolean {
  const trimmed = modelId.trim();
  if (provider === "openai") {
    return (
      IMAGE_GENERATION_MODEL_IDS.has(trimmed) ||
      trimmed.startsWith("dall-e") ||
      trimmed.startsWith("gpt-image")
    );
  }

  if (provider === "gemini") {
    return (
      IMAGE_GENERATION_MODEL_IDS.has(trimmed) || trimmed.startsWith("imagen")
    );
  }

  if (
    provider === "openai_compatible" ||
    provider === "openrouter" ||
    provider === "fireworks" ||
    provider === "ollama"
  ) {
    return Boolean(trimmed);
  }

  return false;
}

export function isAllowedImageGenerationSelection(
  value: string | null | undefined
): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }

  return trimmed === IMAGE_GENERATION_SELECTION;
}
