import {
  AtlasApiError,
  apiKeyEnvVarForProvider,
  createProviderInstanceId,
  defaultDiscoveryBaseUrl,
  defaultOllamaBaseUrl,
  defaultOllamaLabel,
  findCustomModel,
  findProviderInstance,
  isDiscoveryModelProvider,
  isOllamaCloudInstance,
  isValidBaseUrl,
  normalizeBaseUrl,
  normalizeProviderInstanceLabel,
  type OllamaHostMode,
  ollamaRequiresApiKey,
  type ProviderInstance,
  parseWireApi,
  readEnvValue,
  resolveOllamaHostMode,
  validateCustomModels,
  validateDisplayName,
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
  getModelsForProviderInstance,
  isCompatibleModelId,
  isOpenRouterModelSlug,
  resolveModel,
  validateCerebrasCustomModels,
  validateCloudflareCustomModels,
  validateFireworksCustomModels,
  validateOllamaCustomModels,
  validateOpenCodeGoCustomModels,
  validateOpenRouterCustomModels,
} from "../providers";
import { getModelsForOpenCodeGoInstance } from "../providers/opencode-go/catalog";

export function toProviderInstanceSummary(
  instance: ProviderInstance,
  modelCount: number,
  env: Record<string, string | undefined> = process.env
): ProviderInstanceSummary {
  return {
    baseUrl: instance.baseUrl ?? null,
    hasApiKey:
      hasResolvedProviderApiKey(instance, env) ||
      instance.type === "openai_compatible" ||
      (instance.type === "ollama" && !isOllamaCloudInstance(instance)),
    hostMode:
      instance.type === "ollama" ? resolveOllamaHostMode(instance) : null,
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

function hasResolvedProviderApiKey(
  instance: ProviderInstance,
  env: Record<string, string | undefined>
): boolean {
  if (instance.apiKey.trim()) {
    return true;
  }

  const envVar = apiKeyEnvVarForProvider(instance.type);
  return Boolean(envVar && readEnvValue(env, envVar)?.trim());
}

export function isProviderInstanceUsable(
  instance: ProviderInstance,
  env: Record<string, string | undefined> = process.env
): boolean {
  return (
    hasResolvedProviderApiKey(instance, env) ||
    instance.type === "openai_compatible" ||
    (instance.type === "ollama" && !isOllamaCloudInstance(instance))
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

  if (instance.type === "openrouter" && isOpenRouterModelSlug(trimmed)) {
    return true;
  }

  if (instance.type === "cerebras") {
    if (instance.customModels?.length) {
      return findCustomModel(instance.customModels, trimmed) !== undefined;
    }

    return Boolean(getModelById(trimmed)?.provider === "cerebras");
  }

  if (instance.type === "fireworks") {
    if (instance.customModels?.length) {
      return findCustomModel(instance.customModels, trimmed) !== undefined;
    }

    return Boolean(getModelById(trimmed)?.provider === "fireworks");
  }

  if (instance.type === "ollama") {
    if (instance.customModels?.length) {
      return findCustomModel(instance.customModels, trimmed) !== undefined;
    }

    return false;
  }

  if (isDiscoveryModelProvider(instance.type)) {
    return isCompatibleModelId(trimmed, instance.customModels);
  }

  if (instance.type === "opencode_go" && trimmed.startsWith("opencode-go/")) {
    if (instance.customModels?.length) {
      return findCustomModel(instance.customModels, trimmed) !== undefined;
    }
    return true;
  }

  if (
    instance.type === "openai" ||
    instance.type === "anthropic" ||
    instance.type === "gemini" ||
    instance.type === "deepseek"
  ) {
    if (instance.customModels?.length) {
      return findCustomModel(instance.customModels, trimmed) !== undefined;
    }
    return Boolean(getModelById(trimmed)?.provider === instance.type);
  }

  return Boolean(getModelById(trimmed)?.provider === instance.type);
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

  if (!apiKey && type !== "openai_compatible" && type !== "ollama") {
    throw new AtlasApiError("API key is required.", 400);
  }

  if (type === "ollama") {
    const hostMode = resolveOllamaHostMode({
      baseUrl: request.baseUrl,
      hostMode: request.hostMode,
    });

    if (ollamaRequiresApiKey(hostMode) && !apiKey) {
      throw new AtlasApiError("API key is required for Ollama Cloud.", 400);
    }
  }

  const fields = buildProviderFieldsFromRequest({ ...request, apiKey, type });
  const rawLabel = request.label?.trim()
    ? validateProviderInstanceLabel(request.label, type)
    : fields.label;
  const label =
    type === "ollama" && fields.hostMode
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
  request: UpdateProviderRequest
): ProviderInstance {
  const next: ProviderInstance = { ...instance };

  if (request.label !== undefined) {
    next.label = validateProviderInstanceLabel(request.label, instance.type);
  }

  if (request.apiKey !== undefined && request.apiKey.trim()) {
    next.apiKey = request.apiKey.trim();
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

  if (request.hostMode !== undefined && instance.type === "ollama") {
    next.hostMode = request.hostMode;
  }

  if (request.wireApi !== undefined && instance.type === "openai_compatible") {
    next.wireApi = parseWireApi(request.wireApi);
  }

  if (request.customModels !== undefined) {
    if (isDiscoveryModelProvider(instance.type)) {
      next.customModels = validateCustomModels(request.customModels);
      if (!next.customModels.length) {
        throw new Error("At least one model is required.");
      }
    } else if (instance.type === "openrouter") {
      next.customModels = validateOpenRouterCustomModels(request.customModels);
    } else if (instance.type === "cerebras") {
      next.customModels = validateCerebrasCustomModels(request.customModels);
    } else if (instance.type === "fireworks") {
      next.customModels = validateFireworksCustomModels(request.customModels);
    } else if (instance.type === "ollama") {
      next.customModels = validateOllamaCustomModels(request.customModels);
    } else if (instance.type === "cloudflare") {
      next.customModels = validateCloudflareCustomModels(request.customModels);
    } else if (instance.type === "opencode_go") {
      next.customModels = request.customModels.length
        ? validateOpenCodeGoCustomModels(request.customModels)
        : undefined;
    } else if (
      instance.type === "openai" ||
      instance.type === "anthropic" ||
      instance.type === "gemini" ||
      instance.type === "deepseek"
    ) {
      next.customModels = validateCustomModels(request.customModels);
    }
  }

  if (next.type === "ollama") {
    const hostMode = resolveOllamaHostMode(next);

    if (ollamaRequiresApiKey(hostMode) && !next.apiKey.trim()) {
      throw new Error("API key is required for Ollama Cloud.");
    }
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

function buildProviderFieldsFromRequest(request: CreateProviderRequest): Pick<
  ProviderInstance,
  "baseUrl" | "customModels" | "hostMode" | "wireApi"
> & {
  label?: string;
} {
  const type = request.type;

  if (type === "ollama") {
    const resolvedHostMode: OllamaHostMode =
      request.hostMode ??
      (request.baseUrl?.includes("ollama.com") ? "cloud" : "local");
    const baseUrl = normalizeBaseUrl(
      request.baseUrl?.trim() || defaultOllamaBaseUrl(resolvedHostMode)
    );

    if (!isValidBaseUrl(baseUrl)) {
      throw new Error("A valid http(s) base URL is required.");
    }

    const customModels = request.customModels?.length
      ? validateOllamaCustomModels(request.customModels)
      : request.model?.trim()
        ? validateOllamaCustomModels([
            { default: true, id: request.model.trim() },
          ])
        : undefined;

    if (!customModels?.length) {
      throw new Error("At least one Ollama model is required.");
    }

    return {
      baseUrl,
      customModels,
      hostMode: resolvedHostMode,
      label: defaultOllamaLabel(resolvedHostMode),
    };
  }

  if (type === "opencode_go") {
    const customModels = request.customModels?.length
      ? validateOpenCodeGoCustomModels(request.customModels)
      : undefined;

    return { ...(customModels ? { customModels } : {}) };
  }

  if (type === "openai_compatible") {
    const label = validateDisplayName(request.label ?? "");
    const baseUrl = normalizeBaseUrl(request.baseUrl ?? "");
    if (!isValidBaseUrl(baseUrl)) {
      throw new Error("A valid http(s) base URL is required.");
    }

    let customModels = request.customModels?.length
      ? validateCustomModels(request.customModels)
      : undefined;

    if (!customModels?.length && request.model?.trim()) {
      customModels = validateCustomModels([
        { default: true, id: request.model.trim() },
      ]);
    }

    if (!customModels?.length) {
      throw new Error("At least one model is required.");
    }

    return {
      baseUrl,
      customModels,
      label,
      wireApi: parseWireApi(request.wireApi),
    };
  }

  if (isDiscoveryModelProvider(type)) {
    const baseUrl = normalizeBaseUrl(
      request.baseUrl?.trim() || defaultDiscoveryBaseUrl(type) || ""
    );
    if (!isValidBaseUrl(baseUrl)) {
      throw new Error("A valid http(s) base URL is required.");
    }

    let customModels = request.customModels?.length
      ? validateCustomModels(request.customModels)
      : undefined;
    if (!customModels?.length && request.model?.trim()) {
      customModels = validateCustomModels([
        { default: true, id: request.model.trim() },
      ]);
    }
    if (!customModels?.length) {
      throw new Error("At least one discovered model is required.");
    }

    return { baseUrl, customModels };
  }

  if (type === "openrouter") {
    const customModels = request.customModels?.length
      ? validateOpenRouterCustomModels(request.customModels)
      : undefined;
    return { ...(customModels ? { customModels } : {}) };
  }

  if (type === "cerebras") {
    const customModels = request.customModels?.length
      ? validateCerebrasCustomModels(request.customModels)
      : undefined;
    return { ...(customModels ? { customModels } : {}) };
  }

  if (type === "fireworks") {
    let customModels = request.customModels?.length
      ? validateFireworksCustomModels(request.customModels)
      : undefined;

    if (!customModels?.length && request.model?.trim()) {
      const catalogModel = getModelById(request.model.trim());
      customModels = validateFireworksCustomModels([
        {
          default: true,
          id: request.model.trim(),
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
      ]);
    }

    if (!customModels?.length) {
      throw new Error("At least one Fireworks model is required.");
    }

    return { customModels };
  }

  if (type === "cloudflare") {
    const baseUrl = normalizeBaseUrl(request.baseUrl ?? "");
    if (!isValidBaseUrl(baseUrl)) {
      throw new Error("A valid Cloudflare Workers AI base URL is required.");
    }

    const customModels = request.customModels?.length
      ? validateCloudflareCustomModels(request.customModels)
      : undefined;
    return { baseUrl, ...(customModels ? { customModels } : {}) };
  }

  const rawBaseUrl = request.baseUrl?.trim();
  if (!rawBaseUrl) {
    return {};
  }

  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  if (!isValidBaseUrl(baseUrl)) {
    throw new Error("A valid http(s) base URL is required.");
  }

  return { baseUrl };
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

    if (instance.type === "opencode_go") {
      models.push(...(await getModelsForOpenCodeGoInstance(instance)));
      continue;
    }

    models.push(...getModelsForProviderInstance(instance));
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
      return {
        instance: explicit,
        model: resolveModel(
          explicit.type,
          decoded.modelId,
          explicit.customModels
        ),
      };
    }
  }

  const selectedModel = extractStoredModelId(profileModel);

  if (selectedModel) {
    const matchingProviders = providers.filter((instance) =>
      modelExistsOnInstance(instance, selectedModel)
    );

    const catalogProvider = getModelById(selectedModel)?.provider;
    const preferred =
      matchingProviders.find((instance) => instance.type === catalogProvider) ??
      (active && matchingProviders.some((instance) => instance.id === active.id)
        ? active
        : undefined) ??
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
