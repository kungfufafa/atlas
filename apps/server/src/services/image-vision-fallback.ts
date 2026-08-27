import {
  AtlasApiError,
  type MessageContentPart,
  migrateLegacyCapabilityConfig,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityClaim,
  type ProviderClient,
  type UserConfig,
} from "@atlas/core";
import {
  builtinProviderAdapterRegistry,
  type ProviderAdapterRegistry,
} from "../providers/capabilities";
import {
  describeImagesWithProvider,
  type VisionUnderstandingOutput,
} from "../providers/capabilities/executors/vision-understanding";
import {
  executeConfiguredCapability,
  resolveConfiguredCapability,
} from "../providers/capabilities/runtime";
import { getModelsForProviderInstance } from "../providers/compatible-models";
import {
  createProviderForInstance,
  readApiKeyForInstance,
} from "../providers/create";
import {
  type ResolvedProfileProviderSelection,
  resolveProfileProviderSelection,
} from "./provider-instance-helpers";

export interface VisionCapabilityRuntimeOptions {
  env?: Record<string, string | undefined>;
  recordUsage?: (
    model: string,
    usage: { inputTokens: number; outputTokens: number }
  ) => void;
  registry?: ProviderAdapterRegistry;
}

export function resolveVisionProviderSelection(
  userConfig: UserConfig | null | undefined,
  options: VisionCapabilityRuntimeOptions = {}
): ResolvedProfileProviderSelection | null {
  const capabilityConfig = migrateLegacyCapabilityConfig(
    {
      imageModel: userConfig?.imageModel,
      transcriptionModel: userConfig?.transcriptionModel,
      visionModel: userConfig?.visionModel,
    },
    userConfig?.capabilityConfig
  );
  if (!capabilityConfig.bindings[PROVIDER_CAPABILITY_IDS.imageUnderstanding]) {
    if (!userConfig?.capabilityConfig && userConfig?.visionModel?.trim()) {
      throw new AtlasApiError(
        "Configured image parsing model is invalid. Update it in Settings → Capability mappings.",
        400
      );
    }
    return null;
  }

  const normalizedConfig: UserConfig = {
    ...userConfig,
    capabilityConfig,
    defaultProviderId: userConfig?.defaultProviderId ?? null,
    providers: userConfig?.providers ?? [],
  };
  const selection = resolveConfiguredCapability({
    capabilityId: PROVIDER_CAPABILITY_IDS.imageUnderstanding,
    config: normalizedConfig,
    readApiKey: (instance) =>
      readApiKeyForInstance(instance, options.env ?? process.env),
    registry: options.registry ?? builtinProviderAdapterRegistry,
  });
  return { instance: selection.instance, model: selection.model };
}

export function resolvePrimaryModelVisionSupport(
  userConfig: UserConfig | null | undefined,
  profileModel: string | null | undefined,
  registry: ProviderAdapterRegistry = builtinProviderAdapterRegistry
): boolean {
  const resolved = resolveProfileProviderSelection({
    defaultProviderId: userConfig?.defaultProviderId,
    profileModel,
    providers: userConfig?.providers ?? [],
  });

  if (!resolved) {
    return false;
  }

  const capabilityId = PROVIDER_CAPABILITY_IDS.chatInputImage;
  const model = getModelsForProviderInstance(resolved.instance).find(
    (candidate) => candidate.id === resolved.model
  );
  const legacyModelClaim =
    model?.supportsVision === undefined
      ? undefined
      : legacyVisionClaim(model.supportsVision);
  const modelClaim = model?.capabilities?.[capabilityId] ?? legacyModelClaim;
  const providerClaim = resolved.instance.capabilityOverrides?.[capabilityId];
  const effective = registry.resolveModelCapability({
    additionalClaims: [modelClaim, providerClaim].filter(
      (claim): claim is ProviderCapabilityClaim => claim !== undefined
    ),
    capabilityId,
    credentialsAvailable: true,
    modelId: resolved.model,
    providerType: resolved.instance.type,
  });

  return effective.claim.status === "supported";
}

export function createVisionFallbackProvider(
  selection: ResolvedProfileProviderSelection
): ProviderClient {
  const provider = createProviderForInstance(
    selection.instance,
    selection.model
  );
  if (!provider) {
    throw new Error("Unable to create vision fallback provider.");
  }
  return provider;
}

export async function describeImagesWithVisionModel(
  provider: ProviderClient,
  images: Extract<MessageContentPart, { type: "image" }>[]
): Promise<string[]> {
  return (await describeImagesWithProvider(provider, { images })).descriptions;
}

export async function describeImagesWithConfiguredVisionModel(
  userConfig: UserConfig | null | undefined,
  images: Extract<MessageContentPart, { type: "image" }>[],
  options: VisionCapabilityRuntimeOptions = {}
): Promise<string[]> {
  const result = await executeConfiguredCapability<VisionUnderstandingOutput>({
    capabilityId: PROVIDER_CAPABILITY_IDS.imageUnderstanding,
    config: userConfig,
    input: { images },
    readApiKey: (instance) =>
      readApiKeyForInstance(instance, options.env ?? process.env),
    registry: options.registry ?? builtinProviderAdapterRegistry,
  });
  if (result.output.usage) {
    options.recordUsage?.(result.selection.model, result.output.usage);
  }
  return result.output.descriptions;
}

export const VISION_MODEL_REQUIRED_MESSAGE =
  "This model cannot see images. Configure an image parsing model in Settings before sending images.";

function legacyVisionClaim(supportsVision: boolean): ProviderCapabilityClaim {
  return {
    source: "legacy-migration",
    status: supportsVision ? "supported" : "unsupported",
    verified: false,
  };
}
