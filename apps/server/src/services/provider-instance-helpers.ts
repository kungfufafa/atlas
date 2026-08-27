import {
  AtlasApiError,
  apiKeyEnvVarForProvider,
  createProviderInstanceId,
  defaultOllamaBaseUrl,
  defaultOllamaLabel,
  findProviderInstance,
  getBuiltinProviderDefinition,
  isSubscriptionProvider,
  isValidBaseUrl,
  normalizeBaseUrl,
  normalizeProviderInstanceLabel,
  type OllamaHostMode,
  type ProviderCapabilityClaims,
  type ProviderCapabilityOverridePatch,
  type ProviderInstance,
  parseWireApi,
  readEnvValue,
  resolveOllamaHostMode,
  validateCustomModels,
  validateDisplayName,
  validateProviderCustomModelId,
  validateProviderInstanceLabel,
} from "@atlas/core";
import type {
  CreateProviderRequest,
  ProviderInstanceSummary,
  ProviderModelOption,
  UpdateProviderRequest,
} from "@atlas/core/contract";
import {
  getDefaultModel,
  getModelById,
  getModelByIdForProvider,
  getModelsForProviderInstance,
  resolveModel,
} from "../providers";
import { builtinProviderAdapterRegistry } from "../providers/capabilities/builtin-adapters";

export function toProviderInstanceSummary(
  instance: ProviderInstance,
  modelCount: number,
  env: Record<string, string | undefined> = process.env
): ProviderInstanceSummary {
  return {
    baseUrl: instance.baseUrl ?? null,
    ...(instance.capabilityOverrides
      ? { capabilityOverrides: instance.capabilityOverrides }
      : {}),
    hasApiKey: builtinProviderAdapterRegistry.credentialsAreAvailable(
      instance,
      resolveProviderApiKey(instance, env)
    ),
    hostMode:
      getBuiltinProviderDefinition(instance.type)?.setup?.hostMode === "ollama"
        ? resolveOllamaHostMode(instance)
        : null,
    id: instance.id,
    label: normalizeProviderInstanceLabel(instance.type, instance.label, []),
    type: instance.type,
    wireApi: instance.wireApi ?? null,
    ...(instance.customModels?.length
      ? { customModels: instance.customModels }
      : {}),
    createdAt: instance.createdAt,
    modelCount,
  };
}

function resolveProviderApiKey(
  instance: ProviderInstance,
  env: Record<string, string | undefined>
): string | undefined {
  if (instance.apiKey.trim()) {
    return instance.apiKey;
  }

  const envVar = apiKeyEnvVarForProvider(instance.type);
  return envVar ? readEnvValue(env, envVar)?.trim() : undefined;
}

export function isProviderInstanceUsable(
  instance: ProviderInstance,
  env: Record<string, string | undefined> = process.env
): boolean {
  return builtinProviderAdapterRegistry.credentialsAreAvailable(
    instance,
    resolveProviderApiKey(instance, env)
  );
}

export function countModelsForInstance(
  instance: ProviderInstance,
  env: Record<string, string | undefined> = process.env
): number {
  if (!isProviderInstanceUsable(instance, env)) {
    return 0;
  }
  return getModelsForProviderInstance(instance).length;
}

export function resolveInitialModel(
  instance: ProviderInstance,
  requestedModel?: string
): string {
  const trimmed = requestedModel?.trim();

  if (trimmed) {
    return resolveModel(instance.type, trimmed, instance.customModels);
  }

  return getDefaultModel(instance.type, instance.customModels);
}

export function modelExistsOnInstance(
  instance: ProviderInstance,
  modelId: string
): boolean {
  const trimmed = modelId.trim();

  if (!trimmed) {
    return false;
  }

  const catalog = getModelsForProviderInstance(instance);
  if (catalog.some((model) => model.id === trimmed)) {
    return true;
  }

  const definition = getBuiltinProviderDefinition(instance.type);
  if (
    definition?.modelIdPolicy === "provider-qualified" &&
    validateProviderCustomModelId(instance.type, trimmed) === null
  ) {
    return true;
  }

  return (
    definition?.modelIdPolicy === "passthrough" &&
    !instance.customModels?.length
  );
}

export function resolveDefaultModelForInstance(
  instance: ProviderInstance | null | undefined
): string {
  return instance ? getDefaultModel(instance.type, instance.customModels) : "";
}

export function buildProviderInstanceFromCreateRequest(
  // apiKey and type are widened here on purpose: request bodies reach this
  // unvalidated, so an absent field has to name itself rather than throw a
  // TypeError, and the type is what stops the guard being deleted later.
  request: Omit<CreateProviderRequest, "apiKey" | "type"> & {
    apiKey?: string;
    type?: CreateProviderRequest["type"];
  },
  existing: ProviderInstance[]
): ProviderInstance {
  const type = request.type;

  if (!type) {
    throw new AtlasApiError("Provider type is required.", 400);
  }

  const apiKey = request.apiKey?.trim() ?? "";
  assertSubscriptionApiKeyIsEmpty(type, apiKey);
  assertSubscriptionRuntimeManagedFields(type, request);
  assertProviderMultiplicity(type, existing);
  const credentialProbe: ProviderInstance = {
    apiKey,
    ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}),
    createdAt: "",
    ...(request.hostMode ? { hostMode: request.hostMode } : {}),
    id: "credential-probe",
    label: "Credential probe",
    type,
  };
  if (
    !builtinProviderAdapterRegistry.credentialsAreAvailable(
      credentialProbe,
      apiKey
    )
  ) {
    throw new AtlasApiError(
      builtinProviderAdapterRegistry.missingCredentialMessage(credentialProbe),
      400
    );
  }

  const normalizedRequest: CreateProviderRequest = isSubscriptionProvider(type)
    ? { label: request.label, model: request.model, type }
    : {
        apiKey,
        baseUrl: request.baseUrl,
        customModels: request.customModels,
        hostMode: request.hostMode,
        label: request.label,
        model: request.model,
        skipValidation: request.skipValidation,
        type,
        wireApi: request.wireApi,
      };
  const fields = buildProviderFieldsFromRequest(normalizedRequest);
  const rawLabel = request.label?.trim()
    ? validateProviderInstanceLabel(request.label, type)
    : fields.label;
  const label =
    getBuiltinProviderDefinition(type)?.setup?.hostMode === "ollama" &&
    fields.hostMode
      ? normalizeProviderInstanceLabel(type, rawLabel, existing, {
          hostMode: fields.hostMode,
        })
      : normalizeProviderInstanceLabel(type, rawLabel, existing);

  return {
    apiKey,
    id: createProviderInstanceId(),
    replayRevision: crypto.randomUUID(),
    type,
    ...fields,
    createdAt: new Date().toISOString(),
    label,
  };
}

export function applyProviderInstanceUpdate(
  instance: ProviderInstance,
  request: UpdateProviderRequest,
  env: Record<string, string | undefined> = process.env
): ProviderInstance {
  const subscriptionProvider = isSubscriptionProvider(instance.type);
  const requestedApiKey = request.apiKey?.trim() ?? "";
  assertSubscriptionApiKeyIsEmpty(instance.type, requestedApiKey);
  assertSubscriptionRuntimeManagedFields(instance.type, request);
  const next: ProviderInstance = {
    ...instance,
    ...(subscriptionProvider ? { apiKey: "" } : {}),
  };

  if (request.label !== undefined) {
    next.label = validateProviderInstanceLabel(request.label, instance.type);
  }

  if (!subscriptionProvider && requestedApiKey) {
    next.apiKey = requestedApiKey;
  }

  if (request.baseUrl !== undefined) {
    const normalized = normalizeBaseUrl(request.baseUrl);
    if (!isValidBaseUrl(normalized)) {
      throw new Error("A valid http(s) base URL is required.");
    }
    const previousBaseUrl = instance.baseUrl
      ? normalizeBaseUrl(instance.baseUrl)
      : "";
    const endpointChanged = normalized !== previousBaseUrl;
    if (endpointChanged && instance.apiKey.trim() && !request.apiKey?.trim()) {
      throw new Error(
        "Re-enter the API key when changing a provider base URL."
      );
    }
    next.baseUrl = normalized;
  }

  const setup = getBuiltinProviderDefinition(instance.type)?.setup;

  if (request.hostMode !== undefined && setup?.hostMode === "ollama") {
    next.hostMode = request.hostMode;
  }

  if (request.wireApi !== undefined && setup?.wireApi) {
    next.wireApi = parseWireApi(request.wireApi);
  }

  if (request.customModels !== undefined) {
    next.customModels = validateProviderCustomModels(
      instance.type,
      request.customModels
    );
  }

  if (request.capabilityOverrides !== undefined) {
    next.capabilityOverrides = applyAdminCapabilityOverridePatch(
      instance.capabilityOverrides,
      request.capabilityOverrides
    );
  }

  if (
    !builtinProviderAdapterRegistry.credentialsAreAvailable(
      next,
      resolveProviderApiKey(next, env)
    )
  ) {
    throw new Error(
      builtinProviderAdapterRegistry.missingCredentialMessage(next)
    );
  }

  const connectionSemanticsChanged =
    next.apiKey !== instance.apiKey ||
    next.baseUrl !== instance.baseUrl ||
    next.hostMode !== instance.hostMode ||
    next.wireApi !== instance.wireApi;
  if (connectionSemanticsChanged) {
    next.replayRevision = crypto.randomUUID();
  }

  return next;
}

function assertSubscriptionRuntimeManagedFields(
  type: ProviderInstance["type"],
  request: {
    baseUrl?: unknown;
    customModels?: unknown;
    hostMode?: unknown;
    wireApi?: unknown;
  }
): void {
  if (!isSubscriptionProvider(type)) {
    return;
  }

  if (
    request.baseUrl !== undefined ||
    request.customModels !== undefined ||
    request.hostMode !== undefined ||
    request.wireApi !== undefined
  ) {
    throw new AtlasApiError(
      "Subscription connection settings and models are managed by the authenticated runtime.",
      400
    );
  }
}

export function applyAdminCapabilityOverridePatch(
  existing: ProviderCapabilityClaims | undefined,
  patch: ProviderCapabilityOverridePatch,
  verifiedAt = new Date().toISOString()
): ProviderCapabilityClaims | undefined {
  const next: ProviderCapabilityClaims = { ...existing };

  for (const [rawCapabilityId, status] of Object.entries(patch)) {
    const capabilityId = rawCapabilityId.trim();
    if (!capabilityId) {
      throw new Error("Capability overrides cannot contain an empty id.");
    }

    if (status === null) {
      delete next[capabilityId];
      continue;
    }

    if (
      status !== "supported" &&
      status !== "unsupported" &&
      status !== "unknown"
    ) {
      throw new Error(
        `Capability override "${capabilityId}" has an invalid status.`
      );
    }

    next[capabilityId] = {
      source: "admin-override",
      status,
      verified: status !== "unknown",
      ...(status === "unknown" ? {} : { verifiedAt }),
    };
  }

  return Object.keys(next).length ? next : undefined;
}

function buildProviderFieldsFromRequest(request: CreateProviderRequest): Pick<
  ProviderInstance,
  "baseUrl" | "customModels" | "hostMode" | "wireApi"
> & {
  label?: string;
} {
  const type = request.type;
  const definition = getBuiltinProviderDefinition(type);
  const setup = definition?.setup;
  const fields: ProviderSetupFields = {};

  if (setup?.hostMode === "ollama") {
    const hostMode: OllamaHostMode =
      request.hostMode ??
      (request.baseUrl?.includes("ollama.com") ? "cloud" : "local");
    fields.hostMode = hostMode;
    fields.label = defaultOllamaLabel(hostMode);
  }

  if (setup?.displayName) {
    fields.label = validateDisplayName(request.label ?? "");
  }

  if (setup?.configureBaseUrl !== "omit") {
    const defaultBaseUrl =
      setup?.hostMode === "ollama" && fields.hostMode
        ? defaultOllamaBaseUrl(fields.hostMode)
        : definition?.discoveryBaseUrl;
    const rawBaseUrl = request.baseUrl?.trim() || defaultBaseUrl || "";
    if (rawBaseUrl) {
      const baseUrl = normalizeBaseUrl(rawBaseUrl);
      if (!isValidBaseUrl(baseUrl)) {
        throw new Error(providerBaseUrlError(definition?.displayName));
      }
      fields.baseUrl = baseUrl;
    } else if (setup?.baseUrlRequired) {
      throw new Error(providerBaseUrlError(definition?.displayName));
    }
  }

  if (setup?.customModels) {
    const entries = requestedCustomModels(
      request,
      setup.customModelsRequired === true
    );
    fields.customModels = validateProviderCustomModels(type, entries);
  }

  if (setup?.wireApi) {
    fields.wireApi = parseWireApi(request.wireApi);
  }

  return fields;
}

type ProviderSetupFields = Pick<
  ProviderInstance,
  "baseUrl" | "customModels" | "hostMode" | "wireApi"
> & { label?: string };

function providerBaseUrlError(displayName: string | undefined): string {
  return displayName
    ? `A valid ${displayName} base URL is required.`
    : "A valid http(s) base URL is required.";
}

function assertSubscriptionApiKeyIsEmpty(
  type: CreateProviderRequest["type"],
  apiKey: string
): void {
  if (isSubscriptionProvider(type) && apiKey) {
    throw new AtlasApiError(
      `${type} subscription authentication does not accept an API key.`,
      400
    );
  }
}

function assertProviderMultiplicity(
  type: CreateProviderRequest["type"],
  existing: ProviderInstance[]
): void {
  const definition = getBuiltinProviderDefinition(type);
  if (
    definition?.allowMultipleInstances === true ||
    !existing.some((instance) => instance.type === type)
  ) {
    return;
  }

  throw new AtlasApiError(
    `${definition?.displayName ?? type} is already configured.`,
    409
  );
}

function requestedCustomModels(
  request: CreateProviderRequest,
  seedSelectedModel: boolean
): CreateProviderRequest["customModels"] {
  if (request.customModels?.length) {
    return request.customModels;
  }

  if (!seedSelectedModel) {
    return [];
  }

  const modelId = request.model?.trim();
  if (!modelId) {
    return [];
  }

  const catalogModel =
    getModelByIdForProvider(modelId, request.type) ?? getModelById(modelId);
  return [
    {
      default: true,
      id: modelId,
      ...(catalogModel?.supportsThinking === undefined
        ? {}
        : { supportsThinking: catalogModel.supportsThinking }),
      ...(catalogModel?.supportsVision === undefined
        ? {}
        : { supportsVision: catalogModel.supportsVision }),
      ...(catalogModel?.inputPerMillionUsd === undefined
        ? {}
        : { inputPerMillionUsd: catalogModel.inputPerMillionUsd }),
      ...(catalogModel?.outputPerMillionUsd === undefined
        ? {}
        : { outputPerMillionUsd: catalogModel.outputPerMillionUsd }),
    },
  ];
}

function validateProviderCustomModels(
  type: ProviderInstance["type"],
  entries: unknown
): ProviderInstance["customModels"] {
  const definition = getBuiltinProviderDefinition(type);
  if (!Array.isArray(entries) || entries.length === 0) {
    if (definition?.setup?.customModelsRequired) {
      throw new Error(
        `At least one ${definition.displayName} model is required.`
      );
    }
    return;
  }

  const models = validateCustomModels(entries);
  for (const model of models) {
    const error = validateProviderCustomModelId(type, model.id);
    if (error) {
      throw new Error(error);
    }
  }

  return models;
}

export function mergeModelsForConfig(
  providers: ProviderInstance[],
  env: Record<string, string | undefined> = process.env
): ProviderModelOption[] {
  const models: ProviderModelOption[] = [];

  for (const instance of providers) {
    if (!isProviderInstanceUsable(instance, env)) {
      continue;
    }
    models.push(...getModelsForProviderInstance(instance));
  }

  return models;
}

export async function mergeModelsForConfigAsync(
  providers: ProviderInstance[],
  env: Record<string, string | undefined> = process.env
): Promise<ProviderModelOption[]> {
  const models: ProviderModelOption[] = [];

  for (const instance of providers) {
    if (!isProviderInstanceUsable(instance, env)) {
      continue;
    }

    models.push(
      ...(await builtinProviderAdapterRegistry.listModelsForInstance(
        instance,
        () => getModelsForProviderInstance(instance)
      ))
    );
  }

  return models;
}

export interface ResolvedProfileProviderSelection {
  instance: ProviderInstance;
  model: string;
}

export function decodeStoredModelSelection(
  value: string | null | undefined
): { providerId: string; modelId: string } | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  const separator = trimmed.indexOf("::");

  if (separator <= 0) {
    return null;
  }

  return {
    modelId: trimmed.slice(separator + 2),
    providerId: trimmed.slice(0, separator),
  };
}

export function extractStoredModelId(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  return decodeStoredModelSelection(trimmed)?.modelId ?? trimmed;
}

export function resolveProfileProviderSelection(options: {
  providers: ProviderInstance[];
  defaultProviderId: string | null | undefined;
  profileModel: string | null | undefined;
}): ResolvedProfileProviderSelection | null {
  const { providers, defaultProviderId, profileModel } = options;
  const active = defaultProviderId
    ? findProviderInstance({ providers }, defaultProviderId)
    : null;
  const fallbackInstance = active ?? providers[0] ?? null;

  if (!fallbackInstance) {
    return null;
  }

  const decoded = decodeStoredModelSelection(profileModel);

  if (decoded && decoded.providerId !== "__unknown__") {
    const explicit = findProviderInstance({ providers }, decoded.providerId);

    // A qualified selection records the provider decision itself. Native
    // providers accept model ids newer than Atlas' static catalog, so do not
    // reroute that selection merely because the catalog has not caught up yet.
    if (explicit) {
      const explicitModelId = decoded.modelId.trim();
      if (
        isSubscriptionProvider(explicit.type) &&
        !explicit.customModels?.some((model) => model.id === explicitModelId)
      ) {
        throw new AtlasApiError(
          `Model "${explicitModelId}" is no longer available for the ${explicit.label} subscription. Select an available model.`,
          409
        );
      }
      return {
        instance: explicit,
        model: isSubscriptionProvider(explicit.type)
          ? explicitModelId
          : resolveModel(explicit.type, explicitModelId, explicit.customModels),
      };
    }
  }

  const selectedModel = extractStoredModelId(profileModel);

  if (selectedModel) {
    const matchingProviders = providers.filter((instance) =>
      modelExistsOnInstance(instance, selectedModel)
    );

    const catalogProvider = getModelById(selectedModel)?.provider;
    const activeMatch = active
      ? matchingProviders.find((instance) => instance.id === active.id)
      : undefined;
    const preferred =
      (activeMatch?.type === catalogProvider ? activeMatch : undefined) ??
      matchingProviders.find((instance) => instance.type === catalogProvider) ??
      activeMatch ??
      matchingProviders[0];

    if (preferred) {
      return {
        instance: preferred,
        model: resolveModel(
          preferred.type,
          selectedModel,
          preferred.customModels
        ),
      };
    }
  }

  return {
    instance: fallbackInstance,
    model: resolveDefaultModelForInstance(fallbackInstance),
  };
}
