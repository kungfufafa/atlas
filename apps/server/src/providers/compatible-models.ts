import type { ProviderInstance, ProviderName } from "@atlas/core";
import {
  type CustomModelEntry,
  findCustomModel,
  inferCompatibleReasoningEffortValues,
  normalizeBaseUrl,
  parseRemoteOpenAIModelEntry,
  resolveCompatibleModelCapabilities,
} from "@atlas/core";
import OpenAI from "openai";
import type { ProviderModelOption } from "./models";
import { AVAILABLE_MODELS } from "./models";
import { openRouterSlugSupportsThinking } from "./openrouter/thinking";
import { DEFAULT_USER_AGENT } from "./shared";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT = 8192;

function resolveOpenRouterCatalogThinking(entry: CustomModelEntry): boolean {
  if (entry.supportsThinking !== undefined) {
    return entry.supportsThinking;
  }

  return openRouterSlugSupportsThinking(entry.id);
}

export function openRouterCustomModelsToCatalog(
  entries: CustomModelEntry[]
): ProviderModelOption[] {
  return entries.map((entry) => ({
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    id: entry.id,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    name: entry.name?.trim() || entry.id,
    provider: "openrouter" as const,
    supportsThinking: resolveOpenRouterCatalogThinking(entry),
    ...(entry.default ? { default: true } : {}),
    ...(entry.reasoningEffortValues
      ? { reasoningEffortValues: entry.reasoningEffortValues }
      : {}),
    ...(entry.inputPerMillionUsd === undefined
      ? {}
      : { inputPerMillionUsd: entry.inputPerMillionUsd }),
    ...(entry.outputPerMillionUsd === undefined
      ? {}
      : { outputPerMillionUsd: entry.outputPerMillionUsd }),
  }));
}

function resolveCerebrasCatalogThinking(entry: CustomModelEntry): boolean {
  if (entry.supportsThinking !== undefined) {
    return entry.supportsThinking;
  }

  return false;
}

export function cerebrasCustomModelsToCatalog(
  entries: CustomModelEntry[]
): ProviderModelOption[] {
  return entries.map((entry) => ({
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    id: entry.id,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    name: entry.name?.trim() || entry.id,
    provider: "cerebras" as const,
    supportsThinking: resolveCerebrasCatalogThinking(entry),
    ...(entry.supportsVision === undefined
      ? {}
      : { supportsVision: entry.supportsVision }),
    ...(entry.default ? { default: true } : {}),
    ...(entry.reasoningEffortValues
      ? { reasoningEffortValues: entry.reasoningEffortValues }
      : {}),
    ...(entry.inputPerMillionUsd === undefined
      ? {}
      : { inputPerMillionUsd: entry.inputPerMillionUsd }),
    ...(entry.outputPerMillionUsd === undefined
      ? {}
      : { outputPerMillionUsd: entry.outputPerMillionUsd }),
  }));
}

function resolveFireworksCatalogThinking(entry: CustomModelEntry): boolean {
  if (entry.supportsThinking !== undefined) {
    return entry.supportsThinking;
  }

  return false;
}

export function fireworksCustomModelsToCatalog(
  entries: CustomModelEntry[]
): ProviderModelOption[] {
  const staticModels = AVAILABLE_MODELS.filter(
    (model) => model.provider === "fireworks"
  );

  return catalogCustomModelsToCatalog(entries, staticModels, "fireworks").map(
    (model) => ({
      ...model,
      supportsThinking:
        model.supportsThinking === undefined
          ? resolveFireworksCatalogThinking(
              entries.find((entry) => entry.id === model.id) ?? { id: model.id }
            )
          : model.supportsThinking,
    })
  );
}

export function catalogCustomModelsToCatalog(
  entries: CustomModelEntry[],
  staticModels: ProviderModelOption[],
  provider: ProviderName
): ProviderModelOption[] {
  const staticById = new Map(staticModels.map((model) => [model.id, model]));

  return entries.map((entry) => {
    const existing = staticById.get(entry.id);
    const model: ProviderModelOption = {
      ...(existing ?? {
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        id: entry.id,
        maxOutputTokens: DEFAULT_MAX_OUTPUT,
        provider,
      }),
      id: entry.id,
      name: entry.name?.trim() || existing?.name || entry.id,
      provider,
    };

    if (entry.default) {
      model.default = true;
    }
    if (entry.supportsVision !== undefined) {
      model.supportsVision = entry.supportsVision;
    }
    if (entry.supportsThinking !== undefined) {
      model.supportsThinking = entry.supportsThinking;
    } else if (provider === "deepseek") {
      model.supportsThinking = false;
    }
    if (entry.reasoningEffortValues !== undefined) {
      model.reasoningEffortValues = entry.reasoningEffortValues;
    }
    if (entry.inputPerMillionUsd !== undefined) {
      model.inputPerMillionUsd = entry.inputPerMillionUsd;
    }
    if (entry.outputPerMillionUsd !== undefined) {
      model.outputPerMillionUsd = entry.outputPerMillionUsd;
    }

    return model;
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
  const byId = new Map(staticModels.map((model) => [model.id, { ...model }]));

  for (const entry of customEntries) {
    const existing = byId.get(entry.id);
    byId.set(entry.id, {
      ...(existing ?? {
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        id: entry.id,
        maxOutputTokens: DEFAULT_MAX_OUTPUT,
        provider: "openrouter" as const,
      }),
      id: entry.id,
      name: entry.name?.trim() || existing?.name || entry.id,
      provider: "openrouter",
      supportsThinking: resolveOpenRouterCatalogThinking(entry),
      ...(entry.default
        ? { default: true }
        : existing?.default
          ? { default: true }
          : {}),
      ...(entry.reasoningEffortValues
        ? { reasoningEffortValues: entry.reasoningEffortValues }
        : {}),
      ...(entry.inputPerMillionUsd === undefined
        ? {}
        : { inputPerMillionUsd: entry.inputPerMillionUsd }),
      ...(entry.outputPerMillionUsd === undefined
        ? {}
        : { outputPerMillionUsd: entry.outputPerMillionUsd }),
    });
  }

  return [...byId.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

export function inferReasoningEffortValues(
  modelId: string,
  provider?: ProviderName,
  providerLabel?: string,
  baseUrl?: string
): string[] {
  return inferCompatibleReasoningEffortValues(modelId, {
    baseUrl,
    provider,
    providerLabel,
  });
}

export function customModelsToCatalog(
  entries: CustomModelEntry[],
  provider: ProviderName = "openai_compatible",
  providerLabel?: string,
  baseUrl?: string
): ProviderModelOption[] {
  return entries.map((entry) => {
    const inferred = resolveCompatibleModelCapabilities(
      entry.id,
      {
        reasoningEffortValues: entry.reasoningEffortValues,
        supportsThinking: entry.supportsThinking,
      },
      { baseUrl, provider, providerLabel }
    );
    const model: ProviderModelOption = {
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      id: entry.id,
      maxOutputTokens: DEFAULT_MAX_OUTPUT,
      name: entry.name?.trim() || entry.id,
      provider,
    };

    if (entry.default) {
      model.default = true;
    }
    if (inferred.supportsThinking !== undefined) {
      model.supportsThinking = inferred.supportsThinking;
    }
    if (inferred.reasoningEffortValues !== undefined) {
      model.reasoningEffortValues = inferred.reasoningEffortValues;
    }
    if (entry.supportsVision !== undefined) {
      model.supportsVision = entry.supportsVision;
    }
    if (entry.inputPerMillionUsd !== undefined) {
      model.inputPerMillionUsd = entry.inputPerMillionUsd;
    }
    if (entry.outputPerMillionUsd !== undefined) {
      model.outputPerMillionUsd = entry.outputPerMillionUsd;
    }

    return model;
  });
}

export function ensureCurrentModelInCatalog(
  catalog: ProviderModelOption[],
  currentModel: string | null | undefined,
  provider: ProviderName = "openai_compatible"
): ProviderModelOption[] {
  const trimmed = currentModel?.trim();

  if (!trimmed || catalog.some((model) => model.id === trimmed)) {
    return catalog;
  }

  return [
    ...catalog,
    {
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      id: trimmed,
      maxOutputTokens: DEFAULT_MAX_OUTPUT,
      name: trimmed,
      provider,
      ...(provider === "openrouter"
        ? { supportsThinking: openRouterSlugSupportsThinking(trimmed) }
        : {}),
    },
  ];
}

export function getModelsForProviderInstance(
  instance: ProviderInstance,
  currentModel?: string | null
): ProviderModelOption[] {
  const annotate = (models: ProviderModelOption[]): ProviderModelOption[] =>
    models.map((model) => ({
      ...model,
      providerId: instance.id,
      providerLabel: instance.label,
    }));

  if (instance.type === "openai_compatible") {
    const entries = instance.customModels ?? [];
    const models = customModelsToCatalog(
      entries,
      "openai_compatible",
      instance.label,
      instance.baseUrl
    );

    return annotate(
      ensureCurrentModelInCatalog(models, currentModel, "openai_compatible")
    );
  }

  if (instance.type === "openrouter") {
    const entries = instance.customModels ?? [];
    const catalog = entries.length
      ? openRouterCustomModelsToCatalog(entries)
      : [];
    return annotate(
      ensureCurrentModelInCatalog(catalog, currentModel, "openrouter")
    );
  }

  if (instance.type === "cerebras") {
    const entries = instance.customModels ?? [];
    const staticModels = AVAILABLE_MODELS.filter(
      (model) => model.provider === "cerebras"
    );
    const catalog = entries.length
      ? cerebrasCustomModelsToCatalog(entries)
      : staticModels;
    return annotate(
      ensureCurrentModelInCatalog(catalog, currentModel, "cerebras")
    );
  }

  if (instance.type === "fireworks") {
    const entries = instance.customModels ?? [];
    const staticModels = AVAILABLE_MODELS.filter(
      (model) => model.provider === "fireworks"
    );
    const catalog = entries.length
      ? fireworksCustomModelsToCatalog(entries)
      : staticModels;
    return annotate(
      ensureCurrentModelInCatalog(catalog, currentModel, "fireworks")
    );
  }

  if (instance.type === "ollama") {
    const entries = instance.customModels ?? [];
    return annotate(
      ensureCurrentModelInCatalog(
        customModelsToCatalog(entries, "ollama"),
        currentModel,
        "ollama"
      )
    );
  }

  if (
    instance.type === "openai" ||
    instance.type === "anthropic" ||
    instance.type === "gemini" ||
    instance.type === "deepseek" ||
    instance.type === "opencode_go"
  ) {
    const entries = instance.customModels ?? [];
    if (entries.length) {
      const staticModels = AVAILABLE_MODELS.filter(
        (model) => model.provider === instance.type
      );
      return annotate(
        ensureCurrentModelInCatalog(
          catalogCustomModelsToCatalog(entries, staticModels, instance.type),
          currentModel,
          instance.type
        )
      );
    }
  }

  return annotate(
    AVAILABLE_MODELS.filter((model) => model.provider === instance.type)
  );
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

  if (trimmed && findCustomModel(customModels, trimmed)) {
    return trimmed;
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

  if (trimmed && findCustomModel(customModels, trimmed)) {
    return trimmed;
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

  if (trimmed && findCustomModel(customModels, trimmed)) {
    return trimmed;
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

  if (trimmed && findCustomModel(customModels, trimmed)) {
    return trimmed;
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
  apiKey: string
): Promise<CustomModelEntry[]> {
  const normalized = normalizeBaseUrl(baseUrl);

  try {
    const fromRaw = await fetchRemoteOpenAIModelsRaw(normalized, apiKey);
    if (fromRaw.length > 0) {
      return fromRaw;
    }
  } catch (error) {
    if (isRemoteModelsAuthError(error)) {
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
}

async function fetchRemoteOpenAIModelsRaw(
  baseUrl: string,
  apiKey: string
): Promise<CustomModelEntry[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      Accept: "application/json",
      "User-Agent": DEFAULT_USER_AGENT,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    console.warn(
      `Could not fetch models (${response.status}) from ${baseUrl}/models:`,
      body
    );

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Add an API key before discovering models from this endpoint."
      );
    }

    throw new Error(`Could not fetch models (${response.status}): ${body}`);
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

function toDiscoveredCustomModel(
  parsed: {
    id: string;
    name?: string;
    reasoningEffortValues?: string[];
    supportsThinking?: boolean;
    supportsVision?: boolean;
  },
  context: { baseUrl: string }
): CustomModelEntry {
  const capabilities = resolveCompatibleModelCapabilities(
    parsed.id,
    {
      reasoningEffortValues: parsed.reasoningEffortValues,
      supportsThinking: parsed.supportsThinking,
    },
    context
  );

  return {
    id: parsed.id,
    name: parsed.name?.trim() || parsed.id,
    ...capabilities,
    ...(parsed.supportsVision === undefined
      ? {}
      : { supportsVision: parsed.supportsVision }),
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

  if (trimmed && findCustomModel(customModels, trimmed)) {
    return trimmed;
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
