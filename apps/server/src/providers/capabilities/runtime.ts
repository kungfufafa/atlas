import {
  type CapabilityTarget,
  findCustomModel,
  findProviderInstance,
  migrateCapabilityTargetProviderIds,
  migrateLegacyCapabilityConfig,
  type ProviderCapabilityClaim,
  type ProviderCapabilityId,
  type ProviderInstance,
  type UserConfig,
} from "@atlas/core";
import type { CapabilityRouteAttempt } from "./errors";
import { ProviderCapabilityError } from "./errors";
import type {
  EffectiveModelCapability,
  ProviderAdapterRegistry,
} from "./registry";
import { resolveCapabilityRoute } from "./resolver";

export interface ResolvedConfiguredCapability {
  apiKey: string;
  fallbackIndex: number | null;
  instance: ProviderInstance;
  model: string;
  trace: CapabilityRouteAttempt[];
}

export interface ResolveConfiguredCapabilityOptions {
  capabilityId: ProviderCapabilityId;
  config: UserConfig | null | undefined;
  readApiKey: (instance: ProviderInstance) => string | undefined;
  registry: ProviderAdapterRegistry;
}

export function resolveConfiguredCapability(
  options: ResolveConfiguredCapabilityOptions
): ResolvedConfiguredCapability {
  const userConfig = options.config;
  const capabilityConfig = migrateCapabilityTargetProviderIds(
    migrateLegacyCapabilityConfig(
      {
        imageModel: userConfig?.imageModel,
        transcriptionModel: userConfig?.transcriptionModel,
        visionModel: userConfig?.visionModel,
      },
      userConfig?.capabilityConfig
    ),
    userConfig?.providers ?? [],
    userConfig?.defaultProviderId
  );
  const route = resolveCapabilityRoute({
    capabilityId: options.capabilityId,
    config: capabilityConfig,
    evaluate: (target) => evaluateCapabilityTarget(options, target),
  });
  const instance = findProviderInstance(
    { providers: userConfig?.providers ?? [] },
    route.target.providerId
  );
  if (!instance) {
    throw new ProviderCapabilityError({
      attempts: route.trace,
      capabilityId: options.capabilityId,
      code: "CAPABILITY_NOT_CONFIGURED",
      message: `Configured provider instance "${route.target.providerId}" no longer exists. Review Settings → Capability mappings.`,
    });
  }
  const apiKey = options.readApiKey(instance)?.trim() ?? "";
  if (!options.registry.credentialsAreAvailable(instance, apiKey)) {
    throw new ProviderCapabilityError({
      attempts: route.trace,
      capabilityId: options.capabilityId,
      code: "CAPABILITY_CREDENTIALS_MISSING",
      message: `Credentials for "${instance.label}" are missing. Review Settings → Providers.`,
    });
  }

  return {
    apiKey,
    fallbackIndex: route.fallbackIndex,
    instance,
    model: route.target.modelId,
    trace: route.trace,
  };
}

export async function executeConfiguredCapability<Output>(options: {
  capabilityId: ProviderCapabilityId;
  config: UserConfig | null | undefined;
  input: unknown;
  readApiKey: (instance: ProviderInstance) => string | undefined;
  registry: ProviderAdapterRegistry;
}): Promise<{ output: Output; selection: ResolvedConfiguredCapability }> {
  const selection = resolveConfiguredCapability(options);
  const output = await options.registry.execute(
    options.capabilityId,
    {
      apiKey: selection.apiKey,
      instance: selection.instance,
      model: selection.model,
    },
    options.input
  );
  return { output: output as Output, selection };
}

export function evaluateCapabilityTarget(
  options: ResolveConfiguredCapabilityOptions,
  target: CapabilityTarget,
  additionalClaims: readonly ProviderCapabilityClaim[] = []
): EffectiveModelCapability {
  const instance = findProviderInstance(
    { providers: options.config?.providers ?? [] },
    target.providerId
  );
  if (!instance) {
    return {
      availability: "adapter-missing",
      capabilityId: options.capabilityId,
      claim: unknownClaim(),
      reasons: ["provider-instance-missing"],
      selectable: false,
    };
  }
  const modelClaim = findCustomModel(instance.customModels, target.modelId)
    ?.capabilities?.[options.capabilityId];
  const providerOverride = instance.capabilityOverrides?.[options.capabilityId];
  const instanceClaim = options.registry.resolveInstanceCapabilityClaims(
    instance,
    target.modelId
  )[options.capabilityId];
  const apiKey = options.readApiKey(instance);

  return options.registry.resolveModelCapability({
    additionalClaims: [
      ...additionalClaims,
      modelClaim,
      instanceClaim,
      providerOverride,
    ].filter((claim) => claim !== undefined),
    capabilityId: options.capabilityId,
    credentialsAvailable: options.registry.credentialsAreAvailable(
      instance,
      apiKey
    ),
    modelId: target.modelId,
    providerType: instance.type,
  });
}

function unknownClaim(): ProviderCapabilityClaim {
  return {
    source: "static-manifest",
    status: "unknown",
    verified: false,
  };
}
