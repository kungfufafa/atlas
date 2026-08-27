import {
  AtlasApiError,
  PROVIDER_CAPABILITY_IDS,
  type ProviderInstance,
  type UserConfig,
} from "@atlas/core";
import { builtinProviderAdapterRegistry } from "../providers/capabilities/builtin-adapters";
import {
  type ImageGenerationInput,
  type ImageGenerationOutput,
  normalizeImageGenerationInput,
  normalizeImageGenerationOutput,
} from "../providers/capabilities/executors/image-generation";
import type { ProviderAdapterRegistry } from "../providers/capabilities/registry";
import {
  executeConfiguredCapability,
  type ResolvedConfiguredCapability,
  resolveConfiguredCapability,
} from "../providers/capabilities/runtime";
import { readApiKeyForInstance } from "../providers/create";
import { decodeStoredModelSelection } from "./provider-instance-helpers";

export {
  DEFAULT_IMAGE_GENERATION_SIZE,
  fallbackImageGenerationTokens,
  IMAGE_GENERATION_SIZES,
  type ImageGenerationInput,
  type ImageGenerationOutput as GenerateImageResult,
  type ImageGenerationSize,
  type ImageGenerationUsage,
  normalizeImageGenerationSize,
  resolveImageGenerationTokens,
} from "../providers/capabilities/executors/image-generation";

const IMAGE_GENERATION = PROVIDER_CAPABILITY_IDS.imageGeneration;

export const IMAGE_MODEL_REQUIRED_MESSAGE =
  "Configure an image generation model in Settings before generating images.";

export interface ImageGenerationRuntimeOptions {
  env?: Record<string, string | undefined>;
  registry?: ProviderAdapterRegistry;
}

export interface ResolvedImageGenerationSelection
  extends ResolvedConfiguredCapability {
  selection: string;
}

export interface ConfiguredImageGenerationResult {
  output: ImageGenerationOutput;
  selection: ResolvedConfiguredCapability;
}

export function resolveImageGenerationSelection(
  userConfig: UserConfig | null | undefined,
  options: ImageGenerationRuntimeOptions = {}
): ResolvedImageGenerationSelection | null {
  const legacySelection = userConfig?.imageModel?.trim();
  const configuredBinding =
    userConfig?.capabilityConfig?.bindings[IMAGE_GENERATION];
  if (!(legacySelection || configuredBinding)) {
    return null;
  }

  if (!userConfig?.capabilityConfig && legacySelection) {
    const decoded = decodeStoredModelSelection(legacySelection);
    if (!decoded || decoded.providerId === "__unknown__") {
      throw new AtlasApiError(
        "Configured image generation model is invalid. Update it in Settings → Capability mappings.",
        400
      );
    }
  }

  const selection = resolveConfiguredCapability({
    capabilityId: IMAGE_GENERATION,
    config: userConfig,
    readApiKey: createApiKeyReader(options.env),
    registry: options.registry ?? builtinProviderAdapterRegistry,
  });
  return {
    ...selection,
    selection: `${selection.instance.id}::${selection.model}`,
  };
}

/**
 * Execute a previously resolved image-generation target. The target is chosen
 * before any provider request; execution never retries another provider.
 */
export async function generateImage(
  selection: ResolvedImageGenerationSelection,
  input: ImageGenerationInput,
  registry: ProviderAdapterRegistry = builtinProviderAdapterRegistry
): Promise<ImageGenerationOutput> {
  const output = await registry.execute(
    IMAGE_GENERATION,
    {
      apiKey: selection.apiKey,
      instance: selection.instance,
      model: selection.model,
    },
    normalizeImageGenerationInput(input)
  );
  return normalizeImageGenerationOutput(output);
}

/** Resolve configured primary/fallback targets, then execute exactly one. */
export async function generateImageWithConfiguredProvider(
  userConfig: UserConfig | null | undefined,
  input: ImageGenerationInput,
  options: ImageGenerationRuntimeOptions = {}
): Promise<ConfiguredImageGenerationResult> {
  const result = await executeConfiguredCapability<ImageGenerationOutput>({
    capabilityId: IMAGE_GENERATION,
    config: userConfig,
    input: normalizeImageGenerationInput(input),
    readApiKey: createApiKeyReader(options.env),
    registry: options.registry ?? builtinProviderAdapterRegistry,
  });
  return {
    output: normalizeImageGenerationOutput(result.output),
    selection: result.selection,
  };
}

function createApiKeyReader(
  env: Record<string, string | undefined> = process.env
): (instance: ProviderInstance) => string | undefined {
  return (instance) => readApiKeyForInstance(instance, env);
}
