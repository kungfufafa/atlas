import type { CustomModelEntry, SubscriptionProviderKind } from "@atlas/core";
import {
  defaultOllamaBaseUrl,
  ollamaRequiresApiKey,
  resolveOllamaHostMode,
} from "@atlas/core";
import {
  catalogCustomModelsToCatalog,
  fetchRemoteOpenAIModels,
  getModelsForProviderInstance,
} from "../compatible-models";
import { fetchFireworksGatewayModels } from "../fireworks/catalog";
import { AVAILABLE_MODELS } from "../models";
import { fetchAnthropicModels, fetchGeminiModels } from "../native-models";
import { fetchOllamaModels } from "../ollama/models";
import {
  fetchOpenCodeGoGatewayModels,
  withLiveOpenCodeGoCatalog,
} from "../opencode-go/catalog";
import {
  type ProviderDiscoveryDnsResolver,
  type ProviderDiscoveryFetch,
  ProviderDiscoverySafetyError,
} from "../provider-discovery-safety";
import { getSubscriptionRuntime } from "../subscription";
import type {
  ProviderModelDiscoveryContext,
  ProviderModelDiscoveryHandler,
  ProviderModelDiscoveryResult,
} from "./registry";

interface DiscoveryDependencies {
  fetch?: ProviderDiscoveryFetch;
  resolveDns?: ProviderDiscoveryDnsResolver;
}

interface OpenAICompatibleDiscoveryOptions extends DiscoveryDependencies {
  allowLocalEndpoint?: boolean;
  defaultBaseUrl?: (
    context: ProviderModelDiscoveryContext
  ) => string | undefined;
  requiresApiKey?: boolean;
}

function configuredDisplayName(
  context: ProviderModelDiscoveryContext
): string | null {
  return context.configured ? context.instance.label : null;
}

function resolveDiscoveryBaseUrl(
  context: ProviderModelDiscoveryContext,
  defaultBaseUrl?: OpenAICompatibleDiscoveryOptions["defaultBaseUrl"]
): string {
  const baseUrl =
    context.baseUrl?.trim() ||
    context.instance.baseUrl?.trim() ||
    defaultBaseUrl?.(context)?.trim();

  if (!baseUrl) {
    throw new Error(
      context.configured
        ? "A base URL is required to discover models."
        : "baseUrl or providerId is required."
    );
  }

  return baseUrl;
}

export function createOpenAICompatibleModelDiscovery(
  options: OpenAICompatibleDiscoveryOptions = {}
): ProviderModelDiscoveryHandler {
  return async (context) => {
    if (options.requiresApiKey && !context.apiKey.trim()) {
      throw new Error("Add an API key before discovering models.");
    }
    const baseUrl = resolveDiscoveryBaseUrl(context, options.defaultBaseUrl);
    const entries = await fetchRemoteOpenAIModels(baseUrl, context.apiKey, {
      fetch: options.fetch,
      localAccess: options.allowLocalEndpoint
        ? { kind: "openai-compatible-local" }
        : undefined,
      resolveDns: options.resolveDns,
      signal: context.signal,
    });
    return buildDiscoveryResult(context, baseUrl, entries);
  };
}

function buildDiscoveryResult(
  context: ProviderModelDiscoveryContext,
  baseUrl: string,
  entries: CustomModelEntry[]
): ProviderModelDiscoveryResult {
  return {
    baseUrl,
    catalog: AVAILABLE_MODELS,
    customModels: entries,
    displayName: configuredDisplayName(context),
    models: getModelsForProviderInstance({
      ...context.instance,
      baseUrl,
      customModels: entries,
    }),
  };
}

export const discoverOpenAIModels = createOpenAICompatibleModelDiscovery({
  defaultBaseUrl: () => "https://api.openai.com/v1",
  requiresApiKey: true,
});

export const discoverOpenRouterModels = createOpenAICompatibleModelDiscovery({
  defaultBaseUrl: () => "https://openrouter.ai/api/v1",
});

export function createNativeModelDiscovery(
  options: {
    baseUrl: string;
    fetchModels: typeof fetchAnthropicModels;
  } & DiscoveryDependencies
): ProviderModelDiscoveryHandler {
  return async (context) => {
    const baseUrl = resolveDiscoveryBaseUrl(context, () => options.baseUrl);
    const entries = await options.fetchModels(baseUrl, context.apiKey, {
      fetch: options.fetch,
      resolveDns: options.resolveDns,
      signal: context.signal,
    });
    return buildDiscoveryResult(context, baseUrl, entries);
  };
}

export const discoverAnthropicModels = createNativeModelDiscovery({
  baseUrl: "https://api.anthropic.com",
  fetchModels: fetchAnthropicModels,
});

export const discoverGeminiModels = createNativeModelDiscovery({
  baseUrl: "https://generativelanguage.googleapis.com",
  fetchModels: fetchGeminiModels,
});

export function createCerebrasModelDiscovery(
  options: DiscoveryDependencies = {}
): ProviderModelDiscoveryHandler {
  return async (context) => {
    if (!context.apiKey.trim()) {
      throw new Error("Add an API key before discovering models.");
    }
    const baseUrl = resolveDiscoveryBaseUrl(
      context,
      () => "https://api.cerebras.ai/v1"
    );
    const entries = await fetchRemoteOpenAIModels(baseUrl, context.apiKey, {
      ...options,
      signal: context.signal,
    });
    if (baseUrl.replace(/\/+$/, "") !== "https://api.cerebras.ai/v1") {
      return buildDiscoveryResult(context, baseUrl, entries);
    }
    let publicEntries: CustomModelEntry[] = [];
    try {
      // The public catalog carries limits/capabilities, while /v1/models scopes
      // availability to the account. Do not send account credentials publicly.
      publicEntries = await fetchRemoteOpenAIModels(
        "https://api.cerebras.ai/public/v1",
        "",
        { ...options, signal: context.signal }
      );
    } catch (error) {
      if (
        context.signal?.aborted ||
        error instanceof ProviderDiscoverySafetyError ||
        (error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError"))
      ) {
        throw error;
      }
      // Discovery still returns account metadata when the public catalog is unavailable.
    }
    const publicById = new Map(publicEntries.map((entry) => [entry.id, entry]));
    const enriched = entries.map((entry) => {
      const metadata = publicById.get(entry.id);
      return {
        ...metadata,
        ...entry,
        ...(metadata?.capabilities || entry.capabilities
          ? {
              capabilities: {
                ...metadata?.capabilities,
                ...entry.capabilities,
              },
            }
          : {}),
      };
    });
    return buildDiscoveryResult(context, baseUrl, enriched);
  };
}

export const discoverCerebrasModels = createCerebrasModelDiscovery();

export const discoverFireworksModels: ProviderModelDiscoveryHandler = async (
  context
) => {
  if (!context.apiKey.trim()) {
    throw new Error(
      context.configured
        ? "Add an API key before discovering Fireworks models."
        : "API key is required to discover Fireworks models."
    );
  }

  const entries = await fetchFireworksGatewayModels(context.apiKey, {
    signal: context.signal,
  });
  const remoteInstance = {
    ...context.instance,
    customModels: entries,
    label: context.configured ? context.instance.label : "Fireworks",
  };
  const staticModels = AVAILABLE_MODELS.filter(
    (model) => model.provider === "fireworks"
  );
  const discoveredModels = catalogCustomModelsToCatalog(
    entries,
    staticModels,
    "fireworks"
  );

  return {
    catalog: AVAILABLE_MODELS,
    customModels: entries,
    displayName: configuredDisplayName(context),
    models: context.configured
      ? getModelsForProviderInstance(remoteInstance)
      : discoveredModels.length
        ? discoveredModels
        : getModelsForProviderInstance(remoteInstance),
  };
};

export const discoverOpenCodeGoModels: ProviderModelDiscoveryHandler = async (
  context
) => {
  const entries = await fetchOpenCodeGoGatewayModels({
    signal: context.signal,
  });
  const remoteInstance = { ...context.instance, customModels: entries };
  const staticModels = AVAILABLE_MODELS.filter(
    (model) => model.provider === "opencode_go"
  );

  return {
    catalog: await withLiveOpenCodeGoCatalog(AVAILABLE_MODELS),
    customModels: entries,
    displayName: configuredDisplayName(context),
    models: context.configured
      ? getModelsForProviderInstance(remoteInstance)
      : catalogCustomModelsToCatalog(entries, staticModels, "opencode_go"),
  };
};

export const discoverOllamaModels: ProviderModelDiscoveryHandler = async (
  context
) => {
  const hostMode =
    context.hostMode ??
    resolveOllamaHostMode({
      baseUrl: context.baseUrl ?? context.instance.baseUrl,
      hostMode: context.instance.hostMode,
    });
  const configuredBaseUrl =
    context.baseUrl?.trim() || context.instance.baseUrl?.trim();
  if (!(context.configured || configuredBaseUrl)) {
    throw new Error("baseUrl or providerId is required.");
  }
  const baseUrl = configuredBaseUrl || defaultOllamaBaseUrl(hostMode);

  if (ollamaRequiresApiKey(hostMode) && !context.apiKey.trim()) {
    throw new Error("Add an API key before discovering Ollama Cloud models.");
  }

  const entries = await fetchOllamaModels(baseUrl, context.apiKey, {
    hostMode,
    signal: context.signal,
  });
  const remoteInstance = {
    ...context.instance,
    baseUrl,
    customModels: entries,
    hostMode,
    label: context.configured ? context.instance.label : "Ollama",
  };

  return {
    baseUrl,
    catalog: AVAILABLE_MODELS,
    customModels: entries,
    displayName: configuredDisplayName(context),
    models: getModelsForProviderInstance(remoteInstance),
  };
};

export function createSubscriptionModelDiscovery(
  kind: SubscriptionProviderKind
): ProviderModelDiscoveryHandler {
  return async (context) => {
    const runtime = getSubscriptionRuntime(kind);
    const models = await runtime.listModels();
    const catalog = AVAILABLE_MODELS.filter((model) => model.provider === kind);
    return {
      catalog: catalog.length > 0 ? catalog : models,
      displayName: configuredDisplayName(context),
      models,
    };
  };
}
