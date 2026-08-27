import {
  type CapabilityRuntimeAvailability,
  type CapabilitySupportStatus,
  type CustomModelEntry,
  type OllamaHostMode,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityClaim,
  type ProviderCapabilityClaims,
  type ProviderCapabilityDefinition,
  type ProviderCapabilityId,
  type ProviderCapabilityManifestV1,
  type ProviderClient,
  type ProviderInstance,
  type ProviderModelOption,
  resolveCapabilityClaimsBySource,
  validateProviderCapabilityManifest,
} from "@atlas/core";
import {
  type CapabilityErrorCode,
  type CapabilityUnavailableReason,
  ProviderCapabilityError,
} from "./errors";

export type ProviderCapabilityExecutor = (
  context: ProviderCapabilityExecutionContext,
  input: unknown
) => Promise<unknown>;

export interface ProviderCapabilityExecutionContext {
  apiKey: string;
  instance: ProviderInstance;
  model: string;
}

export interface ProviderChatFactoryContext {
  apiKey: string;
  cloudflareAccountId?: string;
  instance: ProviderInstance | null;
  model: string;
  providerReplayRevision: string;
  supportsThinking?: boolean;
}

export interface ProviderModelDiscoveryContext {
  apiKey: string;
  baseUrl?: string;
  configured: boolean;
  hostMode?: OllamaHostMode;
  instance: ProviderInstance;
  signal?: AbortSignal;
}

export interface ProviderModelDiscoveryResult {
  baseUrl?: string;
  catalog: ProviderModelOption[];
  customModels?: CustomModelEntry[];
  displayName: string | null;
  models: ProviderModelOption[];
}

export interface ProviderInstanceCapabilityContext {
  instance: ProviderInstance;
  modelId: string;
}

export type ProviderModelDiscoveryHandler = (
  context: ProviderModelDiscoveryContext
) => Promise<ProviderModelDiscoveryResult>;

export interface ProviderAdapterRegistration {
  chatCapabilities?: readonly ProviderCapabilityId[];
  createChatClient?: (context: ProviderChatFactoryContext) => ProviderClient;
  credentialsRequired?: (instance: ProviderInstance) => boolean;
  discoverModels?: ProviderModelDiscoveryHandler;
  executors?: Readonly<
    Record<ProviderCapabilityId, ProviderCapabilityExecutor>
  >;
  listConfiguredModels?: (
    instance: ProviderInstance
  ) => Promise<ProviderModelOption[]>;
  manifest: ProviderCapabilityManifestV1;
  missingCredentialMessage?: (
    instance: ProviderInstance,
    operation: ProviderCredentialOperation
  ) => string;
  modelDiscoveryOnCatalogRefresh?: boolean;
  resolveInstanceCapabilityClaims?: (
    context: ProviderInstanceCapabilityContext
  ) => ProviderCapabilityClaims;
}

export type ProviderCredentialOperation =
  | "configuration"
  | "connection-validation";

export interface EffectiveModelCapability {
  availability: CapabilityRuntimeAvailability;
  capabilityId: ProviderCapabilityId;
  claim: ProviderCapabilityClaim;
  reasons: CapabilityUnavailableReason[];
  selectable: boolean;
}

export interface ResolveModelCapabilityInput {
  additionalClaims?: ProviderCapabilityClaim[];
  capabilityId: ProviderCapabilityId;
  credentialsAvailable: boolean;
  modelId: string;
  providerType: string;
}

export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapterRegistration>();
  private capabilityDefinitions = new Map<
    ProviderCapabilityId,
    { definition: ProviderCapabilityDefinition; explicit: boolean }
  >();

  register(registration: ProviderAdapterRegistration): void {
    const manifest = validateProviderCapabilityManifest(registration.manifest);
    const providerId = manifest.provider.id;
    if (this.adapters.has(providerId)) {
      throw new Error(
        `Provider adapter "${providerId}" is already registered.`
      );
    }

    const validatedRegistration = { ...registration, manifest };
    validateRegisteredHandlers(validatedRegistration);
    const capabilityDefinitions = mergeCapabilityDefinitions(
      this.capabilityDefinitions,
      manifest
    );
    this.adapters.set(providerId, freezeRegistration(validatedRegistration));
    this.capabilityDefinitions = capabilityDefinitions;
  }

  get(providerType: string): ProviderAdapterRegistration | undefined {
    return this.adapters.get(providerType);
  }

  require(providerType: string): ProviderAdapterRegistration {
    const adapter = this.get(providerType);
    if (!adapter) {
      throw new ProviderCapabilityError({
        capabilityId: PROVIDER_CAPABILITY_IDS.chatCompletion,
        code: "CAPABILITY_ADAPTER_MISSING",
        message: `Provider adapter "${providerType}" is not installed.`,
      });
    }
    return adapter;
  }

  list(): ProviderAdapterRegistration[] {
    return [...this.adapters.values()];
  }

  getCapabilityDefinition(
    capabilityId: ProviderCapabilityId
  ): ProviderCapabilityDefinition | undefined {
    return this.capabilityDefinitions.get(capabilityId)?.definition;
  }

  listCapabilityDefinitions(): ProviderCapabilityDefinition[] {
    return [...this.capabilityDefinitions.values()].map(({ definition }) => ({
      ...definition,
    }));
  }

  resolveModelCapability(
    input: ResolveModelCapabilityInput
  ): EffectiveModelCapability {
    const adapter = this.get(input.providerType);
    if (!adapter) {
      return unavailableCapability(
        input.capabilityId,
        "adapter-missing",
        "adapter-missing"
      );
    }

    const manifestEntry = adapter.manifest.capabilities[input.capabilityId];
    const staticModelClaim = adapter.manifest.models?.find(
      (model) => model.id === input.modelId
    )?.capabilities[input.capabilityId];
    const claim = resolveCapabilityClaimsBySource(
      manifestEntry?.modelDefault,
      staticModelClaim,
      ...(input.additionalClaims ?? [])
    );
    const hasHandler = hasRegisteredHandler(adapter, input.capabilityId);

    if (claim.status === "unknown") {
      return {
        availability: hasHandler ? "ready" : "handler-missing",
        capabilityId: input.capabilityId,
        claim,
        reasons: ["model-unknown"],
        selectable: false,
      };
    }
    if (claim.status === "unsupported") {
      return {
        availability: hasHandler ? "ready" : "handler-missing",
        capabilityId: input.capabilityId,
        claim,
        reasons: ["model-unsupported"],
        selectable: false,
      };
    }
    if (!hasHandler) {
      return {
        availability: "handler-missing",
        capabilityId: input.capabilityId,
        claim,
        reasons: ["handler-missing"],
        selectable: false,
      };
    }
    if (!input.credentialsAvailable) {
      return {
        availability: "credentials-missing",
        capabilityId: input.capabilityId,
        claim,
        reasons: ["credentials-missing"],
        selectable: false,
      };
    }

    return {
      availability: "ready",
      capabilityId: input.capabilityId,
      claim,
      reasons: [],
      selectable: true,
    };
  }

  credentialsAreAvailable(
    instance: ProviderInstance,
    apiKey: string | undefined
  ): boolean {
    const adapter = this.get(instance.type);
    if (!adapter) {
      return false;
    }
    const required = adapter.credentialsRequired?.(instance) ?? true;
    return !required || Boolean(apiKey?.trim());
  }

  missingCredentialMessage(
    instance: ProviderInstance,
    operation: ProviderCredentialOperation = "configuration"
  ): string {
    return (
      this.get(instance.type)?.missingCredentialMessage?.(
        instance,
        operation
      ) ?? "API key is required."
    );
  }

  resolveInstanceCapabilityClaims(
    instance: ProviderInstance,
    modelId: string
  ): ProviderCapabilityClaims {
    return (
      this.get(instance.type)?.resolveInstanceCapabilityClaims?.({
        instance,
        modelId,
      }) ?? {}
    );
  }

  async listModelsForInstance(
    instance: ProviderInstance,
    fallback: () => ProviderModelOption[]
  ): Promise<ProviderModelOption[]> {
    const handler = this.get(instance.type)?.listConfiguredModels;
    return handler ? handler(instance) : fallback();
  }

  async execute(
    capabilityId: ProviderCapabilityId,
    context: ProviderCapabilityExecutionContext,
    input: unknown
  ): Promise<unknown> {
    const adapter = this.get(context.instance.type);
    if (!adapter) {
      throw capabilityExecutionError(
        capabilityId,
        "CAPABILITY_ADAPTER_MISSING",
        `Provider adapter "${context.instance.type}" is not installed.`
      );
    }
    const executor = adapter.executors?.[capabilityId];
    if (!executor) {
      throw capabilityExecutionError(
        capabilityId,
        "CAPABILITY_UNSUPPORTED",
        `Provider "${adapter.manifest.provider.displayName}" has no Atlas executor for "${capabilityId}".`
      );
    }
    return executor(context, input);
  }

  async discoverModels(
    providerType: string,
    context: ProviderModelDiscoveryContext
  ): Promise<ProviderModelDiscoveryResult> {
    const adapter = this.get(providerType);
    if (!adapter?.discoverModels) {
      throw new Error(
        `Remote model discovery is not supported for ${providerType}.`
      );
    }

    return adapter.discoverModels(context);
  }
}

function mergeCapabilityDefinitions(
  current: ReadonlyMap<
    ProviderCapabilityId,
    { definition: ProviderCapabilityDefinition; explicit: boolean }
  >,
  manifest: ProviderCapabilityManifestV1
): Map<
  ProviderCapabilityId,
  { definition: ProviderCapabilityDefinition; explicit: boolean }
> {
  const merged = new Map(current);

  for (const [capabilityId, entry] of Object.entries(manifest.capabilities)) {
    const existing = merged.get(capabilityId);
    const incoming = entry.metadata
      ? {
          definition: { id: capabilityId, ...entry.metadata },
          explicit: true,
        }
      : {
          definition: inferCapabilityDefinition(capabilityId),
          explicit: false,
        };

    if (!existing || (!existing.explicit && incoming.explicit)) {
      merged.set(capabilityId, incoming);
      continue;
    }
    if (!(existing.explicit && incoming.explicit)) {
      continue;
    }
    if (
      !capabilityDefinitionsAreEqual(existing.definition, incoming.definition)
    ) {
      throw new Error(
        `Provider adapter "${manifest.provider.id}" declares conflicting metadata for capability "${capabilityId}".`
      );
    }
  }

  return merged;
}

function inferCapabilityDefinition(
  capabilityId: ProviderCapabilityId
): ProviderCapabilityDefinition {
  const words = capabilityId
    .split(/[.\-_]+/u)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
  return {
    description: `Capability ${capabilityId}.`,
    id: capabilityId,
    label: words.join(" ") || capabilityId,
    routable: false,
  };
}

function capabilityDefinitionsAreEqual(
  left: ProviderCapabilityDefinition,
  right: ProviderCapabilityDefinition
): boolean {
  return (
    left.description === right.description &&
    left.id === right.id &&
    left.label === right.label &&
    left.routable === right.routable
  );
}

function validateRegisteredHandlers(
  registration: ProviderAdapterRegistration
): void {
  for (const [capabilityId, entry] of Object.entries(
    registration.manifest.capabilities
  )) {
    const hasExecutor = hasRegisteredHandler(registration, capabilityId);
    const isAvailable = entry.implementation.status === "available";

    if (isAvailable && !hasExecutor) {
      throw new Error(
        `Provider adapter "${registration.manifest.provider.id}" marks "${capabilityId}" available without a handler.`
      );
    }
    if (!isAvailable && hasExecutor) {
      throw new Error(
        `Provider adapter "${registration.manifest.provider.id}" has a handler for "${capabilityId}" but marks it unavailable.`
      );
    }
  }

  for (const capabilityId of Object.keys(registration.executors ?? {})) {
    if (!registration.manifest.capabilities[capabilityId]) {
      throw new Error(
        `Provider adapter "${registration.manifest.provider.id}" registers undeclared executor "${capabilityId}".`
      );
    }
  }

  for (const capabilityId of registration.chatCapabilities ?? []) {
    if (!capabilityId.startsWith("chat.")) {
      throw new Error(
        `Provider adapter "${registration.manifest.provider.id}" declares non-chat capability "${capabilityId}" as a chat capability.`
      );
    }
    if (!registration.manifest.capabilities[capabilityId]) {
      throw new Error(
        `Provider adapter "${registration.manifest.provider.id}" declares missing chat capability "${capabilityId}".`
      );
    }
  }
}

function hasRegisteredHandler(
  registration: ProviderAdapterRegistration,
  capabilityId: ProviderCapabilityId
): boolean {
  return Boolean(
    registration.executors?.[capabilityId] ??
      (registration.createChatClient &&
        registration.chatCapabilities?.includes(capabilityId))
  );
}

function freezeRegistration(
  registration: ProviderAdapterRegistration
): ProviderAdapterRegistration {
  return Object.freeze({
    ...registration,
    chatCapabilities: registration.chatCapabilities
      ? Object.freeze([...registration.chatCapabilities])
      : undefined,
    executors: registration.executors
      ? Object.freeze({ ...registration.executors })
      : undefined,
    manifest: Object.freeze(registration.manifest),
  });
}

function unavailableCapability(
  capabilityId: ProviderCapabilityId,
  availability: CapabilityRuntimeAvailability,
  reason: CapabilityUnavailableReason
): EffectiveModelCapability {
  return {
    availability,
    capabilityId,
    claim: {
      source: "static-manifest",
      status: "unknown",
      verified: false,
    },
    reasons: [reason],
    selectable: false,
  };
}

function capabilityExecutionError(
  capabilityId: ProviderCapabilityId,
  code: CapabilityErrorCode,
  message: string
): ProviderCapabilityError {
  return new ProviderCapabilityError({ capabilityId, code, message });
}

export function capabilityStatusIsSelectable(
  status: CapabilitySupportStatus
): boolean {
  return status === "supported";
}
