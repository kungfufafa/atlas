import {
  type CustomModelEntry,
  createTimeoutAbortSignal,
  LLM_FETCH_TIMEOUT_MS,
  normalizeBaseUrl,
  type OllamaHostMode,
  withDisabledFetchIdle,
} from "@atlas/core";
import { fetchRemoteOpenAIModels } from "../compatible-models";
import {
  fetchSafeProviderDiscoveryEndpoint,
  type ProviderDiscoveryDnsResolver,
  type ProviderDiscoveryFetch,
  ProviderDiscoverySafetyError,
} from "../provider-discovery-safety";

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

function ollamaTagsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);

  try {
    const url = new URL(normalized);
    return `${url.origin}/api/tags`;
  } catch {
    return `${normalized.replace(/\/v1\/?$/, "")}/api/tags`;
  }
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
      ollamaTagsUrl(baseUrl),
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

  try {
    const remote = await fetchRemoteOpenAIModels(normalizedBaseUrl, apiKey, {
      fetch: options.fetch,
      localAccess,
      resolveDns: options.resolveDns,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });

    if (remote.length > 0) {
      return remote;
    }
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

  return fetchOllamaTagsModels(normalizedBaseUrl, apiKey, options);
}
