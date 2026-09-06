import {
  type CustomModelEntry,
  type ProviderCapabilityClaims,
  type ProviderInstance,
  parseRemoteOpenAIModelEntry,
  resolveCapabilityClaimsBySource,
} from "@atlas/core";
import {
  catalogCustomModelsToCatalog,
  ensureCurrentModelInCatalog,
} from "../compatible-models";
import type { ProviderModelOption } from "../models";
import {
  AVAILABLE_MODELS,
  isOpenCodeGoModelId,
  toOpenCodeGoApiModelId,
} from "../models";
import { DEFAULT_USER_AGENT } from "../shared";

export const OPENCODE_GO_CHAT_BASE_URL = "https://opencode.ai/zen/go/v1";
export const OPENCODE_GO_MESSAGES_BASE_URL = "https://opencode.ai/zen/go";
export const OPENCODE_GO_MODELS_URL = `${OPENCODE_GO_CHAT_BASE_URL}/models`;

export const DEFAULT_OPENCODE_GO_API_MODEL_ID = "kimi-k2.7-code";
export const DEFAULT_OPENCODE_GO_CATALOG_MODEL_ID = `opencode-go/${DEFAULT_OPENCODE_GO_API_MODEL_ID}`;

const CACHE_TTL_MS = 1000 * 60 * 30;

type CatalogCache = {
  entries: CustomModelEntry[];
  fetchedAt: number;
};

let catalogCache: CatalogCache | null = null;

export function resetOpenCodeGoCatalogCacheForTests(): void {
  catalogCache = null;
}

export function toOpenCodeGoCatalogModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return trimmed;
  }

  return isOpenCodeGoModelId(trimmed)
    ? trimmed
    : `opencode-go/${toOpenCodeGoApiModelId(trimmed)}`;
}

export async function fetchOpenCodeGoGatewayModels(
  options: { signal?: AbortSignal } = {}
): Promise<CustomModelEntry[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CACHE_TTL_MS) {
    return catalogCache.entries;
  }

  const response = await fetch(OPENCODE_GO_MODELS_URL, {
    headers: { "User-Agent": DEFAULT_USER_AGENT },
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(
      `OpenCode Go models request failed (${response.status}): ${await response.text()}`
    );
  }

  const payload: unknown = await response.json();
  const models = parseOpenCodeGoModels(payload);

  if (models.length === 0) {
    throw new Error(
      "OpenCode Go models response did not include any model ids."
    );
  }

  const staticByApiId = new Map(
    AVAILABLE_MODELS.filter((model) => model.provider === "opencode_go").map(
      (model) => [toOpenCodeGoApiModelId(model.id), model]
    )
  );
  const hasDefault = models.some(
    (model) => model.id === DEFAULT_OPENCODE_GO_API_MODEL_ID
  );

  const entries = models
    .map((model) => {
      const { id } = model;
      const existing = staticByApiId.get(id);
      const catalogId = toOpenCodeGoCatalogModelId(id);

      return {
        ...model,
        id: catalogId,
        name: model.name || existing?.name?.trim() || id,
        ...(existing?.inputPerMillionUsd === undefined
          ? {}
          : { inputPerMillionUsd: existing.inputPerMillionUsd }),
        ...(existing?.outputPerMillionUsd === undefined
          ? {}
          : { outputPerMillionUsd: existing.outputPerMillionUsd }),
        ...((
          hasDefault
            ? id === DEFAULT_OPENCODE_GO_API_MODEL_ID
            : id === models[0]?.id
        )
          ? { default: true as const }
          : {}),
      } satisfies CustomModelEntry;
    })
    .sort((left, right) =>
      (left.name ?? left.id).localeCompare(right.name ?? right.id)
    );

  catalogCache = { entries, fetchedAt: Date.now() };
  return entries;
}

export async function getLiveOpenCodeGoCatalog(
  fallback: ProviderModelOption[] = AVAILABLE_MODELS.filter(
    (model) => model.provider === "opencode_go"
  )
): Promise<ProviderModelOption[]> {
  try {
    const entries = await fetchOpenCodeGoGatewayModels();
    return catalogCustomModelsToCatalog(entries, fallback, "opencode_go");
  } catch {
    return fallback;
  }
}

export async function getModelsForOpenCodeGoInstance(
  instance: ProviderInstance,
  currentModel?: string | null
): Promise<ProviderModelOption[]> {
  const live = await getLiveOpenCodeGoCatalog();
  const preferred =
    instance.customModels?.find((entry) => entry.default)?.id ??
    instance.customModels?.[0]?.id;
  const preferredCatalogId = preferred
    ? toOpenCodeGoCatalogModelId(preferred)
    : undefined;
  const configuredById = new Map(
    (instance.customModels ?? []).map((entry) => [
      toOpenCodeGoCatalogModelId(entry.id),
      entry,
    ])
  );
  const entries = live.map((model) => {
    const configured = configuredById.get(model.id);
    const capabilities = mergeLiveCapabilityClaims(
      configured?.capabilities,
      model.capabilities
    );
    return {
      ...configured,
      ...model,
      id: model.id,
      name: configured?.name?.trim() || model.name,
      ...(capabilities ? { capabilities } : {}),
    };
  });
  const annotated = catalogCustomModelsToCatalog(
    entries,
    [],
    "opencode_go"
  ).map((model) => ({
    ...model,
    ...(preferredCatalogId ? { default: model.id === preferredCatalogId } : {}),
    providerId: instance.id,
    providerLabel: instance.label,
  }));

  return ensureCurrentModelInCatalog(
    annotated,
    currentModel ?? preferred,
    "opencode_go"
  );
}

function mergeLiveCapabilityClaims(
  configured: ProviderCapabilityClaims | undefined,
  live: ProviderCapabilityClaims | undefined
): ProviderCapabilityClaims | undefined {
  if (!(configured || live)) {
    return;
  }
  const merged = { ...configured };
  for (const [id, claim] of Object.entries(live ?? {})) {
    merged[id] = resolveCapabilityClaimsBySource(configured?.[id], claim);
  }
  return merged;
}

export async function withLiveOpenCodeGoCatalog(
  catalog: ProviderModelOption[]
): Promise<ProviderModelOption[]> {
  const others = catalog.filter((model) => model.provider !== "opencode_go");
  const fallback = catalog.filter((model) => model.provider === "opencode_go");
  const live = await getLiveOpenCodeGoCatalog(fallback);
  return [...others, ...live];
}

function parseOpenCodeGoModels(payload: unknown): CustomModelEntry[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && "data" in payload
      ? (payload as { data?: unknown }).data
      : undefined;

  if (!Array.isArray(rows)) {
    return [];
  }

  const models: CustomModelEntry[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const parsed = parseRemoteOpenAIModelEntry(
      typeof row === "string" ? { id: row } : row
    );
    if (!parsed) {
      continue;
    }
    const id = toOpenCodeGoApiModelId(parsed.id).trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({ ...parsed, id });
  }
  return models;
}
