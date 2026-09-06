import type { ProviderInstance, ProviderName } from "@atlas/core";
import {
  type CustomModelEntry,
  createTimeoutAbortSignal,
  findCustomModel,
  isDiscoveryModelProvider,
  LLM_FETCH_TIMEOUT_MS,
  normalizeBaseUrl,
  PROVIDER_CAPABILITY_IDS,
  parseRemoteOpenAIModelEntry,
  resolveCompatibleModelCapabilities,
  withDisabledFetchIdle,
} from "@atlas/core";
import OpenAI from "openai";
import type { ProviderModelOption } from "./models";
import { AVAILABLE_MODELS, resolveModel } from "./models";
import { documentedNativeModelMetadata } from "./native-model-metadata";
import {
  fetchSafeProviderDiscoveryEndpoint,
  type ProviderDiscoveryDnsResolver,
  type ProviderDiscoveryFetch,
  type ProviderDiscoveryLocalAccess,
  ProviderDiscoverySafetyError,
} from "./provider-discovery-safety";
import { DEFAULT_USER_AGENT } from "./shared";

/** A missing field is unknown, not a reason to substitute another model's limits. */
function modelFromEntry(
  entry: CustomModelEntry,
  provider: ProviderName,
  name?: string
): ProviderModelOption {
  const reasoning = resolveCompatibleModelCapabilities(entry.id, entry);
  const model: ProviderModelOption = {
    ...entry,
    ...reasoning,
    name: entry.name?.trim() || name || entry.id,
    provider,
  };
  if (entry.supportsThinking === false) {
    delete model.defaultReasoningEffort;
    model.reasoningEffortValues = [];
  }
  return model;
}

function withLegacyModelCapabilityClaims(
  model: ProviderModelOption
): ProviderModelOption {
  if (model.supportsVision === undefined) {
    return model;
  }
  const capabilities = { ...model.capabilities };
  const visionClaim = {
    source: "legacy-migration" as const,
    status: model.supportsVision
      ? ("supported" as const)
      : ("unsupported" as const),
    verified: false,
  };
  capabilities[PROVIDER_CAPABILITY_IDS.chatInputImage] ??= visionClaim;
  capabilities[PROVIDER_CAPABILITY_IDS.imageUnderstanding] ??= visionClaim;
  return { ...model, capabilities };
}

function mergeDocumentedMetadata(
  entry: CustomModelEntry,
  documented: Omit<CustomModelEntry, "id"> | undefined
): CustomModelEntry {
  const capabilities = { ...documented?.capabilities, ...entry.capabilities };
  // An explicit saved vision flag must replace documentary vision claims too.
  // The normal legacy conversion below supplies a claim for that saved field.
  if (entry.supportsVision !== undefined) {
    for (const id of [
      PROVIDER_CAPABILITY_IDS.chatInputImage,
      PROVIDER_CAPABILITY_IDS.imageUnderstanding,
    ]) {
      if (!entry.capabilities?.[id]) {
        delete capabilities[id];
      }
    }
  }
  return {
    ...documented,
    ...entry,
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
  };
}

export function openRouterCustomModelsToCatalog(
  entries: CustomModelEntry[]
): ProviderModelOption[] {
  return entries.map((entry) => modelFromEntry(entry, "openrouter"));
}

export function cerebrasCustomModelsToCatalog(
  entries: CustomModelEntry[]
): ProviderModelOption[] {
  return entries.map((entry) => modelFromEntry(entry, "cerebras"));
}

export function fireworksCustomModelsToCatalog(
  entries: CustomModelEntry[]
): ProviderModelOption[] {
  return entries.map((entry) => modelFromEntry(entry, "fireworks"));
}

export function catalogCustomModelsToCatalog(
  entries: CustomModelEntry[],
  staticModels: ProviderModelOption[],
  provider: ProviderName
): ProviderModelOption[] {
  const staticById = new Map(
    staticModels
      .filter((model) => model.provider === provider)
      .map((model) => [model.id, model])
  );
  return entries.map((entry) => {
    const existing = staticById.get(entry.id);
    // Only documented, exact OpenAI API metadata is used when the list API
    // supplies identifiers alone. Other catalogs are display choices, not evidence.
    const documented = provider === "openai" ? existing : undefined;
    return modelFromEntry(
      mergeDocumentedMetadata(entry, documented),
      provider,
      existing?.name
    );
  });
}

export function openCodeGoCustomModelsToCatalog(
  entries: CustomModelEntry[],
  staticModels: ProviderModelOption[]
): ProviderModelOption[] {
  return catalogCustomModelsToCatalog(entries, staticModels, "opencode_go");
}

export function mergeOpenRouterCatalog(
  staticModels: ProviderModelOption[],
  customEntries: CustomModelEntry[]
): ProviderModelOption[] {
  const byId = new Map(
    staticModels
      .filter((model) => model.provider === "openrouter")
      .map((model) => [model.id, model])
  );
  for (const entry of customEntries) {
    byId.set(
      entry.id,
      modelFromEntry(entry, "openrouter", byId.get(entry.id)?.name)
    );
  }
  return [...byId.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

/** @deprecated Effort options must be supplied by the provider or configuration. */
export function inferReasoningEffortValues(
  _modelId: string,
  _provider?: ProviderName,
  _providerLabel?: string,
  _baseUrl?: string
): string[] {
  return [];
}

export function customModelsToCatalog(
  entries: CustomModelEntry[],
  provider: ProviderName = "openai_compatible",
  _providerLabel?: string,
  _baseUrl?: string
): ProviderModelOption[] {
  return entries.map((entry) => modelFromEntry(entry, provider));
}

export function ensureCurrentModelInCatalog(
  catalog: ProviderModelOption[],
  currentModel: string | null | undefined,
  provider: ProviderName = "openai_compatible"
): ProviderModelOption[] {
  const trimmed = currentModel?.trim();
  return !trimmed || catalog.some((model) => model.id === trimmed)
    ? catalog
    : [...catalog, { id: trimmed, name: trimmed, provider }];
}

export function getModelsForProviderInstance(
  instance: ProviderInstance,
  currentModel?: string | null
): ProviderModelOption[] {
  const entries = instance.customModels ?? [];
  const staticModels = AVAILABLE_MODELS.filter(
    (model) => model.provider === instance.type
  );
  const canUseDocumentedMetadata =
    instance.type === "openai" && isOfficialOpenAIEndpoint(instance.baseUrl);
  let models: ProviderModelOption[];
  if (entries.length) {
    models = catalogCustomModelsToCatalog(
      entries,
      canUseDocumentedMetadata ? staticModels : [],
      instance.type
    );
  } else if (
    isDiscoveryModelProvider(instance.type) ||
    instance.type === "openrouter" ||
    instance.type === "ollama" ||
    instance.type === "chatgpt" ||
    instance.type === "claude"
  ) {
    models = [];
  } else {
    models = canUseDocumentedMetadata
      ? staticModels
      : staticModels.map(({ id, name, provider, default: isDefault }) => ({
          id,
          name,
          provider,
          ...(isDefault ? { default: true } : {}),
        }));
  }
  return ensureCurrentModelInCatalog(models, currentModel, instance.type).map(
    (model) => ({
      ...withLegacyModelCapabilityClaims({
        ...model,
        ...mergeDocumentedMetadata(
          model,
          documentedNativeModelMetadata(instance, model.id)
        ),
      }),
      providerId: instance.id,
      providerLabel: instance.label,
    })
  );
}

export function isOfficialOpenAIEndpoint(baseUrl?: string | null): boolean {
  if (!baseUrl?.trim()) {
    return true;
  }
  try {
    const url = new URL(baseUrl.trim());
    return (
      url.protocol === "https:" &&
      url.hostname === "api.openai.com" &&
      !url.port &&
      url.pathname.replace(/\/$/, "") === "/v1" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function getModelsForConfiguredProvider(
  provider: ProviderName | null,
  instance: ProviderInstance | null | undefined,
  currentModel?: string | null
): ProviderModelOption[] {
  if (!instance) {
    return provider
      ? AVAILABLE_MODELS.filter((model) => model.provider === provider)
      : AVAILABLE_MODELS;
  }

  return getModelsForProviderInstance(instance, currentModel);
}

export function resolveOpenRouterDefaultModel(
  customModels: CustomModelEntry[] | undefined,
  model?: string
): string {
  const trimmed = model?.trim();

  if (trimmed) {
    return resolveModel("openrouter", trimmed, customModels);
  }

  const catalog = openRouterCustomModelsToCatalog(customModels ?? []);
  return (
    catalog.find((entry) => entry.default)?.id ??
    catalog[0]?.id ??
    "anthropic/claude-sonnet-4-6"
  );
}

export function resolveCerebrasDefaultModel(
  customModels: CustomModelEntry[] | undefined,
  model?: string
): string {
  const trimmed = model?.trim();

  if (trimmed) {
    return resolveModel("cerebras", trimmed, customModels);
  }

  const catalog = cerebrasCustomModelsToCatalog(customModels ?? []);
  return (
    catalog.find((entry) => entry.default)?.id ??
    catalog[0]?.id ??
    "gpt-oss-120b"
  );
}

export function resolveFireworksDefaultModel(
  customModels: CustomModelEntry[] | undefined,
  model?: string
): string {
  const trimmed = model?.trim();

  if (trimmed) {
    return resolveModel("fireworks", trimmed, customModels);
  }

  const catalog = fireworksCustomModelsToCatalog(customModels ?? []);
  return (
    catalog.find((entry) => entry.default)?.id ??
    catalog[0]?.id ??
    "accounts/fireworks/models/kimi-k2p6"
  );
}

export function resolveOllamaDefaultModel(
  customModels: CustomModelEntry[] | undefined,
  model?: string
): string {
  const trimmed = model?.trim();

  if (trimmed) {
    return resolveModel("ollama", trimmed, customModels);
  }

  const catalog = customModelsToCatalog(customModels ?? [], "ollama");
  const fallback = catalog.find((entry) => entry.default)?.id ?? catalog[0]?.id;

  if (!fallback) {
    throw new Error("At least one Ollama model is required.");
  }

  return fallback;
}

export async function fetchRemoteOpenAIModels(
  baseUrl: string,
  apiKey: string,
  options: {
    fetch?: ProviderDiscoveryFetch;
    localAccess?: ProviderDiscoveryLocalAccess;
    resolveDns?: ProviderDiscoveryDnsResolver;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}
): Promise<CustomModelEntry[]> {
  const normalized = normalizeBaseUrl(baseUrl);
  const timeout = createTimeoutAbortSignal(
    options.timeoutMs ?? LLM_FETCH_TIMEOUT_MS
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal;
  const fetchImpl: ProviderDiscoveryFetch = options.fetch ?? fetch;
  const boundedFetch: ProviderDiscoveryFetch = (input, init) => {
    const requestInit =
      input instanceof Request
        ? { headers: input.headers, method: input.method, ...init }
        : init;
    const requestUrl = input instanceof Request ? input.url : input;
    return fetchSafeProviderDiscoveryEndpoint(
      requestUrl,
      withDisabledFetchIdle({
        ...requestInit,
        signal,
      }),
      {
        fetchImpl,
        localAccess: options.localAccess,
        resolveDns: options.resolveDns,
      }
    );
  };

  try {
    try {
      const fromRaw = await fetchRemoteOpenAIModelsRaw(
        normalized,
        apiKey,
        boundedFetch
      );
      if (fromRaw.length > 0) {
        return fromRaw;
      }
    } catch (error) {
      if (
        signal.aborted ||
        isAbortOrTimeoutError(error) ||
        error instanceof ProviderDiscoverySafetyError ||
        isRemoteModelsAuthError(error)
      ) {
        throw error;
      }
      // Fall through to the SDK for hosts that only speak the official list API.
    }

    const client = new OpenAI({
      apiKey: apiKey || "not-needed",
      baseURL: normalized,
      defaultHeaders: {
        "User-Agent": DEFAULT_USER_AGENT,
      },
      fetch: boundedFetch,
      maxRetries: 0,
    });

    const page = await client.models.list();
    const ids = new Set<string>();

    for await (const model of page) {
      const id = model.id?.trim();

      if (id) {
        ids.add(id);
      }
    }

    if (ids.size === 0) {
      throw new Error("Remote models response did not include any model ids.");
    }

    return [...ids]
      .sort((left, right) => left.localeCompare(right))
      .map((id) =>
        toDiscoveredCustomModel({ id, name: id }, { baseUrl: normalized })
      );
  } finally {
    timeout.dispose();
  }
}

async function fetchRemoteOpenAIModelsRaw(
  baseUrl: string,
  apiKey: string,
  fetchImpl: ProviderDiscoveryFetch
): Promise<CustomModelEntry[]> {
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      Accept: "application/json",
      "User-Agent": DEFAULT_USER_AGENT,
    },
  });

  if (!response.ok) {
    const endpointOrigin = new URL(baseUrl).origin;
    console.warn(
      `Could not fetch models (${response.status}) from ${endpointOrigin}.`
    );

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Add an API key before discovering models from this endpoint."
      );
    }

    throw new Error(
      `Could not fetch models from the remote endpoint (${response.status}).`
    );
  }

  const payload = (await response.json()) as {
    data?: unknown[];
  };

  const models = new Map<string, CustomModelEntry>();

  for (const entry of payload.data ?? []) {
    const parsed = parseRemoteOpenAIModelEntry(entry);
    if (!parsed) {
      continue;
    }

    models.set(parsed.id, toDiscoveredCustomModel(parsed, { baseUrl }));
  }

  if (models.size === 0) {
    throw new Error("Remote models response did not include any model ids.");
  }

  return [...models.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
}

function isAbortOrTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function toDiscoveredCustomModel(
  parsed: CustomModelEntry,
  _context: { baseUrl: string }
): CustomModelEntry {
  return {
    ...parsed,
    ...resolveCompatibleModelCapabilities(parsed.id, parsed),
    name: parsed.name?.trim() || parsed.id,
  };
}

function isRemoteModelsAuthError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Add an API key before discovering models")
  );
}

export function resolveCompatibleDefaultModel(
  customModels: CustomModelEntry[] | undefined,
  model?: string
): string {
  const trimmed = model?.trim();

  if (trimmed) {
    return resolveModel("openai_compatible", trimmed, customModels);
  }

  const catalog = customModelsToCatalog(customModels ?? []);
  return (
    catalog.find((entry) => entry.default)?.id ??
    catalog[0]?.id ??
    "custom-model"
  );
}

export function isCompatibleModelId(
  modelId: string,
  customModels: CustomModelEntry[] | undefined
): boolean {
  return Boolean(findCustomModel(customModels, modelId));
}

export function compatibleModelSupportsThinking(
  modelId: string,
  customModels: CustomModelEntry[] | undefined
): boolean {
  const custom = findCustomModel(customModels, modelId);

  if (custom?.supportsThinking !== undefined) {
    return custom.supportsThinking;
  }

  return (
    resolveCompatibleModelCapabilities(modelId, {
      reasoningEffortValues: custom?.reasoningEffortValues,
    }).supportsThinking === true
  );
}

export function compatibleModelSupportsVision(
  modelId: string,
  customModels: CustomModelEntry[] | undefined
): boolean {
  return findCustomModel(customModels, modelId)?.supportsVision === true;
}

export function compatibleModelReasoningEffortValues(
  modelId: string,
  customModels: CustomModelEntry[] | undefined,
  context: { baseUrl?: string; providerLabel?: string } = {}
): string[] | undefined {
  const custom = findCustomModel(customModels, modelId);

  return resolveCompatibleModelCapabilities(
    modelId,
    {
      reasoningEffortValues: custom?.reasoningEffortValues,
      supportsThinking: custom?.supportsThinking,
    },
    context
  ).reasoningEffortValues;
}
