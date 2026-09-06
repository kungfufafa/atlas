import {
  type CustomModelEntry,
  createTimeoutAbortSignal,
  LLM_FETCH_TIMEOUT_MS,
  normalizeBaseUrl,
  type OllamaHostMode,
  parseRemoteOpenAIModelEntry,
  withDisabledFetchIdle,
} from "@atlas/core";
import { fetchRemoteOpenAIModels } from "../compatible-models";
import {
  fetchSafeProviderDiscoveryEndpoint,
  type ProviderDiscoveryDnsResolver,
  type ProviderDiscoveryFetch,
  ProviderDiscoverySafetyError,
} from "../provider-discovery-safety";

const OLLAMA_METADATA_BATCH_SIZE = 4;
const NUM_CTX_PARAMETER = /^\s*num_ctx\s+(\d+)\s*$/m;

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

function ollamaNativeUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(normalizeBaseUrl(baseUrl));
  url.pathname = `${url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "")}/api/${endpoint}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchOllamaTagsModels(
  baseUrl: string,
  apiKey: string,
  options: FetchOllamaModelsOptions
): Promise<CustomModelEntry[]> {
  const timeout = createTimeoutAbortSignal(
    options.timeoutMs ?? LLM_FETCH_TIMEOUT_MS
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal;

  try {
    const response = await fetchSafeProviderDiscoveryEndpoint(
      ollamaNativeUrl(baseUrl, "tags"),
      withDisabledFetchIdle({
        headers: {
          ...(apiKey.trim()
            ? { Authorization: `Bearer ${apiKey.trim()}` }
            : {}),
          Accept: "application/json",
        },
        signal,
      }),
      {
        fetchImpl: options.fetch,
        localAccess:
          options.hostMode === "local" ? { kind: "ollama-local" } : undefined,
        resolveDns: options.resolveDns,
      }
    );

    if (!response.ok) {
      throw new Error(
        `Could not fetch Ollama models from /api/tags (${response.status}).`
      );
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    const ids = (payload.models ?? [])
      .map((entry) => entry.name?.trim() || entry.model?.trim())
      .filter((id): id is string => Boolean(id));

    if (ids.length === 0) {
      throw new Error(
        "Ollama /api/tags response did not include any model names."
      );
    }

    return [...new Set(ids)]
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({ id, name: id }));
  } finally {
    timeout.dispose();
  }
}

export interface FetchOllamaModelsOptions {
  fetch?: ProviderDiscoveryFetch;
  hostMode: OllamaHostMode;
  resolveDns?: ProviderDiscoveryDnsResolver;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function fetchOllamaModels(
  baseUrl: string,
  apiKey: string,
  options: FetchOllamaModelsOptions
): Promise<CustomModelEntry[]> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const localAccess =
    options.hostMode === "local"
      ? ({ kind: "ollama-local" } as const)
      : undefined;

  let entries: CustomModelEntry[] = [];
  try {
    entries = await fetchRemoteOpenAIModels(normalizedBaseUrl, apiKey, {
      fetch: options.fetch,
      localAccess,
      resolveDns: options.resolveDns,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    if (
      error instanceof ProviderDiscoverySafetyError ||
      options.signal?.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      throw error;
    }
    // Fall through to native /api/tags.
  }

  if (entries.length === 0) {
    entries = await fetchOllamaTagsModels(normalizedBaseUrl, apiKey, options);
  }
  return enrichOllamaModels(entries, normalizedBaseUrl, apiKey, options);
}

async function fetchOllamaMetadata(
  baseUrl: string,
  apiKey: string,
  endpoint: "ps" | "show",
  options: FetchOllamaModelsOptions,
  model?: string
): Promise<Record<string, unknown> | undefined> {
  const timeout = createTimeoutAbortSignal(
    options.timeoutMs ?? LLM_FETCH_TIMEOUT_MS
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal;
  try {
    const response = await fetchSafeProviderDiscoveryEndpoint(
      ollamaNativeUrl(baseUrl, endpoint),
      withDisabledFetchIdle({
        ...(model ? { body: JSON.stringify({ model }), method: "POST" } : {}),
        headers: {
          Accept: "application/json",
          ...(model ? { "Content-Type": "application/json" } : {}),
          ...(apiKey.trim()
            ? { Authorization: `Bearer ${apiKey.trim()}` }
            : {}),
        },
        signal,
      }),
      {
        fetchImpl: options.fetch,
        localAccess:
          options.hostMode === "local" ? { kind: "ollama-local" } : undefined,
        resolveDns: options.resolveDns,
      }
    );
    if (!response.ok) {
      return;
    }
    return asRecord(await response.json());
  } catch (error) {
    if (error instanceof ProviderDiscoverySafetyError || signal.aborted) {
      throw error;
    }
    // Some cloud/proxy installations expose only the compatible models API.
    // Unavailable native metadata remains unknown.
  } finally {
    timeout.dispose();
  }
}

async function enrichOllamaModels(
  entries: CustomModelEntry[],
  baseUrl: string,
  apiKey: string,
  options: FetchOllamaModelsOptions
): Promise<CustomModelEntry[]> {
  const running = await fetchOllamaMetadata(baseUrl, apiKey, "ps", options);
  const runningWindows = new Map<string, number>();
  for (const entry of Array.isArray(running?.models) ? running.models : []) {
    const model = asRecord(entry);
    const contextWindow = readTokenLimit(model?.context_length);
    if (contextWindow !== undefined) {
      for (const id of [model?.name, model?.model]) {
        if (typeof id === "string" && id.trim()) {
          runningWindows.set(id.trim(), contextWindow);
        }
      }
    }
  }
  const enriched: CustomModelEntry[] = [];
  for (
    let start = 0;
    start < entries.length;
    start += OLLAMA_METADATA_BATCH_SIZE
  ) {
    const batch = await Promise.all(
      entries
        .slice(start, start + OLLAMA_METADATA_BATCH_SIZE)
        .map(async (entry) => {
          const details = await fetchOllamaMetadata(
            baseUrl,
            apiKey,
            "show",
            options,
            entry.id
          );
          const parsed = parseOllamaModelDetails(entry.id, details);
          const contextWindow =
            runningWindows.get(entry.id) ?? parsed.contextWindow;
          return {
            ...entry,
            ...parsed,
            ...(parsed.capabilities
              ? {
                  capabilities: {
                    ...entry.capabilities,
                    ...parsed.capabilities,
                  },
                }
              : {}),
            ...(contextWindow === undefined ? {} : { contextWindow }),
          };
        })
    );
    enriched.push(...batch);
  }
  return enriched;
}

export function parseOllamaModelDetails(
  id: string,
  details: Record<string, unknown> | undefined
): CustomModelEntry {
  const capabilities =
    Array.isArray(details?.capabilities) &&
    details.capabilities.every((value) => typeof value === "string")
      ? details.capabilities
      : undefined;
  const parameters =
    typeof details?.parameters === "string" ? details.parameters : "";
  const configuredContext = NUM_CTX_PARAMETER.exec(parameters)?.[1];
  const contextWindow = configuredContext
    ? readTokenLimit(Number(configuredContext))
    : undefined;
  // model_info.<architecture>.context_length is the trained maximum, not the
  // host's configured window. /api/ps and an explicit num_ctx are runtime data.
  return {
    ...parseRemoteOpenAIModelEntry({
      id,
      ...(capabilities === undefined
        ? {}
        : {
            capabilities: {
              completion: capabilities.includes("completion"),
              tools: capabilities.includes("tools"),
            },
            supportsThinking: capabilities.includes("thinking"),
            supportsVision: capabilities.includes("vision"),
          }),
    }),
    id,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}
