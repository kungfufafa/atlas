import {
  type CustomModelEntry,
  createTimeoutAbortSignal,
  LLM_FETCH_TIMEOUT_MS,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityClaims,
  withDisabledFetchIdle,
} from "@atlas/core";
import {
  fetchSafeProviderDiscoveryEndpoint,
  type ProviderDiscoveryDnsResolver,
  type ProviderDiscoveryFetch,
} from "./provider-discovery-safety";

interface DiscoveryOptions {
  fetch?: ProviderDiscoveryFetch;
  resolveDns?: ProviderDiscoveryDnsResolver;
  signal?: AbortSignal;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function capabilitySupport(value: unknown): boolean | undefined {
  const supported = asRecord(value).supported;
  return typeof supported === "boolean" ? supported : undefined;
}

function setClaim(
  claims: ProviderCapabilityClaims,
  id: string,
  supported: boolean | undefined
): void {
  if (supported !== undefined) {
    claims[id] = {
      source: "provider-discovery",
      status: supported ? "supported" : "unsupported",
      verified: true,
    };
  }
}

/** https://platform.claude.com/docs/en/api/http/models/list */
export function parseAnthropicModel(value: unknown): CustomModelEntry | null {
  const record = asRecord(value);
  const id = nonEmptyString(record.id);
  if (!id) {
    return null;
  }
  const contextWindow = positiveInteger(record.max_input_tokens);
  const maxOutputTokens = positiveInteger(record.max_tokens);
  const advertised = asRecord(record.capabilities);
  const supportsThinking = capabilitySupport(advertised.thinking);
  const supportsVision = capabilitySupport(advertised.image_input);
  const effort = asRecord(advertised.effort);
  const supportsEffort = capabilitySupport(effort);
  const reasoningEffortValues =
    supportsEffort === undefined
      ? undefined
      : supportsEffort
        ? ["low", "medium", "high", "xhigh", "max"].filter(
            (level) => capabilitySupport(effort[level]) === true
          )
        : [];
  const capabilities: ProviderCapabilityClaims = {};
  setClaim(
    capabilities,
    PROVIDER_CAPABILITY_IDS.chatReasoning,
    supportsThinking
  );
  setClaim(
    capabilities,
    PROVIDER_CAPABILITY_IDS.chatInputImage,
    supportsVision
  );
  setClaim(
    capabilities,
    PROVIDER_CAPABILITY_IDS.imageUnderstanding,
    supportsVision
  );
  setClaim(
    capabilities,
    PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
    capabilitySupport(advertised.structured_outputs)
  );
  const thinkingTypes = asRecord(asRecord(advertised.thinking).types);
  const supportedTypes = Object.entries(thinkingTypes)
    .filter(([, support]) => capabilitySupport(support) === true)
    .map(([type]) => type);
  const reasoningClaim = capabilities[PROVIDER_CAPABILITY_IDS.chatReasoning];
  if (reasoningClaim && Object.keys(thinkingTypes).length > 0) {
    reasoningClaim.constraints = {
      supportedValues: { "thinking.type": supportedTypes },
    };
  }
  return {
    id,
    name: nonEmptyString(record.display_name) ?? id,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(supportsThinking === undefined ? {} : { supportsThinking }),
    ...(supportsVision === undefined ? {} : { supportsVision }),
    ...(reasoningEffortValues === undefined ? {} : { reasoningEffortValues }),
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
  };
}

/** https://ai.google.dev/api/models — limits and thinking are model fields. */
export function parseGeminiModel(value: unknown): CustomModelEntry | null {
  const record = asRecord(value);
  const name = nonEmptyString(record.name);
  if (!name) {
    return null;
  }
  const methods = record.supportedGenerationMethods;
  if (!(Array.isArray(methods) && methods.includes("generateContent"))) {
    return null;
  }
  const id = name.startsWith("models/") ? name.slice("models/".length) : name;
  const contextWindow = positiveInteger(record.inputTokenLimit);
  const maxOutputTokens = positiveInteger(record.outputTokenLimit);
  const supportsThinking =
    typeof record.thinking === "boolean" ? record.thinking : undefined;
  const capabilities: ProviderCapabilityClaims = {};
  setClaim(capabilities, PROVIDER_CAPABILITY_IDS.chatCompletion, true);
  setClaim(
    capabilities,
    PROVIDER_CAPABILITY_IDS.chatReasoning,
    supportsThinking
  );
  return {
    capabilities,
    id,
    name: nonEmptyString(record.displayName) ?? id,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(supportsThinking === undefined ? {} : { supportsThinking }),
  };
}

async function fetchNativeModels(
  kind: "anthropic" | "gemini",
  baseUrl: string,
  apiKey: string,
  options: DiscoveryOptions
): Promise<CustomModelEntry[]> {
  if (!apiKey.trim()) {
    throw new Error("Add an API key before discovering models.");
  }
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/models`);
  const headers: Record<string, string> =
    kind === "anthropic"
      ? { "anthropic-version": "2023-06-01", "x-api-key": apiKey }
      : { "x-goog-api-key": apiKey };
  const timeout = createTimeoutAbortSignal(LLM_FETCH_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal;
  const models = new Map<string, CustomModelEntry>();
  const cursors = new Set<string>();
  try {
    for (let page = 0; page < 100; page += 1) {
      const response = await fetchSafeProviderDiscoveryEndpoint(
        url,
        withDisabledFetchIdle({ headers, signal }),
        { fetchImpl: options.fetch, resolveDns: options.resolveDns }
      );
      if (!response.ok) {
        throw new Error(
          `Could not discover ${kind} models (${response.status}).`
        );
      }
      const payload = asRecord(await response.json());
      const entries = kind === "anthropic" ? payload.data : payload.models;
      if (!Array.isArray(entries)) {
        throw new Error(`Invalid ${kind} model catalog.`);
      }
      for (const value of entries) {
        const entry =
          kind === "anthropic"
            ? parseAnthropicModel(value)
            : parseGeminiModel(value);
        if (entry) {
          models.set(entry.id, entry);
        }
      }
      const next =
        kind === "anthropic"
          ? payload.has_more === true
            ? nonEmptyString(payload.last_id)
            : undefined
          : nonEmptyString(payload.nextPageToken);
      if (!next) {
        if (kind === "anthropic" && payload.has_more === true) {
          throw new Error(
            "Anthropic model catalog has an invalid pagination cursor."
          );
        }
        return [...models.values()];
      }
      if (cursors.has(next)) {
        throw new Error(`Repeated ${kind} model catalog cursor.`);
      }
      cursors.add(next);
      url.searchParams.set(
        kind === "anthropic" ? "after_id" : "pageToken",
        next
      );
    }
    throw new Error(`${kind} model catalog exceeded the pagination limit.`);
  } finally {
    timeout.dispose();
  }
}

export async function fetchAnthropicModels(
  baseUrl: string,
  apiKey: string,
  options: DiscoveryOptions = {}
): Promise<CustomModelEntry[]> {
  const normalized = baseUrl.replace(/\/$/, "");
  return await fetchNativeModels(
    "anthropic",
    normalized.endsWith("/v1") ? normalized : `${normalized}/v1`,
    apiKey,
    options
  );
}

export async function fetchGeminiModels(
  baseUrl: string,
  apiKey: string,
  options: DiscoveryOptions = {}
): Promise<CustomModelEntry[]> {
  const normalized = baseUrl.replace(/\/$/, "");
  return await fetchNativeModels(
    "gemini",
    /\/v1(?:beta)?$/.test(normalized) ? normalized : `${normalized}/v1beta`,
    apiKey,
    options
  );
}
