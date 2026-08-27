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
import { fetchOllamaModels } from "../ollama/models";
import {
  fetchOpenCodeGoGatewayModels,
  withLiveOpenCodeGoCatalog,
} from "../opencode-go/catalog";
import type {
  ProviderModelDiscoveryContext,
  ProviderModelDiscoveryHandler,
} from "./registry";

interface OpenAICompatibleDiscoveryOptions {
  allowLocalEndpoint?: boolean;
  defaultBaseUrl?: (
    context: ProviderModelDiscoveryContext
  ) => string | undefined;
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
    const baseUrl = resolveDiscoveryBaseUrl(context, options.defaultBaseUrl);
    const entries = await fetchRemoteOpenAIModels(baseUrl, context.apiKey, {
      localAccess: options.allowLocalEndpoint
        ? { kind: "openai-compatible-local" }
        : undefined,
      signal: context.signal,
    });
    const remoteInstance = {
      ...context.instance,
      baseUrl,
      customModels: entries,
    };

    return {
      baseUrl,
      catalog: AVAILABLE_MODELS,
      customModels: entries,
      displayName: configuredDisplayName(context),
      models: getModelsForProviderInstance(remoteInstance),
    };
  };
}

export const discoverOpenAIModels: ProviderModelDiscoveryHandler = async (
  context
) => {
  if (!context.apiKey.trim()) {
    throw new Error("Add an API key before discovering models.");
  }

  const baseUrl =
    context.baseUrl?.trim() ||
    context.instance.baseUrl?.trim() ||
    "https://api.openai.com/v1";
  const entries = await fetchRemoteOpenAIModels(baseUrl, context.apiKey, {
    signal: context.signal,
  });
  const staticModels = AVAILABLE_MODELS.filter(
    (model) => model.provider === "openai"
  );

  return {
    catalog: AVAILABLE_MODELS,
    displayName: null,
    models: catalogCustomModelsToCatalog(entries, staticModels, "openai"),
  };
};

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
