import { AtlasApiError } from "@atlas/core/api-error";
import { validateCustomModels } from "@atlas/core/compatible-provider-config";
import type {
  CustomModelEntry,
  ProviderModelOption,
  TestProviderRequest,
} from "@atlas/core/contract";
import {
  defaultDiscoveryBaseUrl,
  isDiscoveryModelProvider,
} from "@atlas/core/discovery-providers";
import {
  getBuiltinProviderDefinition,
  isSubscriptionProvider,
} from "@atlas/core/provider-catalog";
import type { ProviderInstance } from "@atlas/core/user-config";
import { builtinProviderAdapterRegistry } from "../providers/capabilities/builtin-adapters";
import { fetchRemoteOpenAIModels } from "../providers/compatible-models";
import { createProviderForInstance } from "../providers/create";
import {
  getSubscriptionRuntime,
  parseSubscriptionProviderKind,
} from "../providers/subscription";
import { resolveInitialModel } from "./provider-instance-helpers";

const PROVIDER_PROBE_TIMEOUT_MS = 10_000;

export async function validateProviderConnection(
  request: TestProviderRequest
): Promise<CustomModelEntry[] | undefined> {
  const type = request.type;
  if (isSubscriptionProvider(type)) {
    if (request.apiKey?.trim()) {
      throw new AtlasApiError(
        `${type} subscription authentication does not accept an API key.`,
        400
      );
    }
    const kind = parseSubscriptionProviderKind(type);
    if (!kind) {
      throw new Error(`Unknown subscription provider "${type}".`);
    }
    const runtime = getSubscriptionRuntime(kind);
    const state = await runtime.getAuthState();
    const label = type === "chatgpt" ? "ChatGPT" : "Claude";
    if (state.status === "not_installed") {
      throw new AtlasApiError(
        `${label} runtime is not available on this Atlas host. Ask a Superadmin to check the subscription runtime.`,
        503
      );
    }
    if (!state.authenticated) {
      throw new AtlasApiError(
        `${label} is not connected on this Atlas host. Ask a Superadmin to connect the subscription.`,
        409
      );
    }

    const models = await runtime.listModels();
    if (models.length === 0) {
      throw new AtlasApiError(
        `No models are available for the ${type} subscription on this Atlas host.`,
        503
      );
    }

    const requestedModel = request.model?.trim();
    if (
      requestedModel &&
      !models.some((model) => model.id === requestedModel)
    ) {
      throw new AtlasApiError(
        `Model "${requestedModel}" is not available for the ${type} subscription.`,
        400
      );
    }
    return canonicalSubscriptionModelSnapshot(models, requestedModel);
  }
  const apiKey = request.apiKey?.trim() ?? "";
  const baseUrl =
    request.baseUrl?.trim() || defaultDiscoveryBaseUrl(type) || undefined;
  const hostMode = request.hostMode;
  const setup = getBuiltinProviderDefinition(type)?.setup;

  const credentialProbe: ProviderInstance = {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    createdAt: new Date(0).toISOString(),
    ...(hostMode ? { hostMode } : {}),
    id: "probe-credential-validation",
    label: "Probe",
    type,
  };
  if (
    !builtinProviderAdapterRegistry.credentialsAreAvailable(
      credentialProbe,
      apiKey
    )
  ) {
    throw new Error(
      builtinProviderAdapterRegistry.missingCredentialMessage(
        credentialProbe,
        "connection-validation"
      )
    );
  }

  let customModels = request.customModels;
  const shouldDiscoverCompatibleModels =
    isDiscoveryModelProvider(type) &&
    Boolean(baseUrl) &&
    !request.model?.trim() &&
    !customModels?.length;

  if (shouldDiscoverCompatibleModels && baseUrl) {
    customModels = await fetchRemoteOpenAIModels(baseUrl, apiKey, {
      localAccess: setup?.allowLocalDiscovery
        ? { kind: "openai-compatible-local" }
        : undefined,
    });
  }

  const probeInstance: ProviderInstance = {
    apiKey,
    createdAt: new Date(0).toISOString(),
    customModels,
    id: "probe-validation",
    label: "Probe",
    type,
    ...(baseUrl ? { baseUrl } : {}),
    ...(hostMode ? { hostMode } : {}),
    ...(setup?.wireApi && request.wireApi ? { wireApi: request.wireApi } : {}),
  };

  const modelsToProbe = probeModels(probeInstance, request.model, customModels);
  let lastError: Error | null = null;

  for (const model of modelsToProbe) {
    const client = createProviderForInstance(probeInstance, model);
    if (!client) {
      throw new Error(`Could not initialize provider client for ${type}.`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      PROVIDER_PROBE_TIMEOUT_MS
    );

    try {
      await client.generateText({
        format: "text",
        prompt: "ping",
        signal: controller.signal,
        system: "Respond with ok",
      });
      return;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `Connection to ${type} timed out. Please check network connectivity and base URL.`
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      lastError = new Error(
        `API key or connection validation failed: ${message}`
      );
      if (!(shouldDiscoverCompatibleModels && isRetryableProbeError(message))) {
        throw lastError;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new Error("API key or connection validation failed.");
}

export function canonicalSubscriptionModelSnapshot(
  models: ProviderModelOption[],
  preferredModelId?: string
): CustomModelEntry[] {
  const preferredIndex = preferredModelId
    ? models.findIndex((model) => model.id === preferredModelId)
    : -1;
  const declaredDefaultIndex = models.findIndex((model) => model.default);
  const defaultIndex = declaredDefaultIndex >= 0 ? declaredDefaultIndex : 0;
  const selectedDefaultIndex =
    preferredIndex >= 0 ? preferredIndex : defaultIndex;

  return validateCustomModels(
    models.map((model, index) => ({
      ...(model.capabilities ? { capabilities: model.capabilities } : {}),
      ...(index === selectedDefaultIndex ? { default: true } : {}),
      ...(model.defaultReasoningEffort
        ? { defaultReasoningEffort: model.defaultReasoningEffort }
        : {}),
      id: model.id,
      name: model.name,
      ...(model.reasoningEffortValues?.length
        ? { reasoningEffortValues: model.reasoningEffortValues }
        : {}),
      ...(model.supportsThinking === undefined
        ? {}
        : { supportsThinking: model.supportsThinking }),
      ...(model.supportsVision === undefined
        ? {}
        : { supportsVision: model.supportsVision }),
    }))
  );
}

function probeModels(
  instance: ProviderInstance,
  requestedModel: string | undefined,
  customModels: CustomModelEntry[] | undefined
): string[] {
  const requested = requestedModel?.trim();
  if (requested) {
    return [resolveInitialModel(instance, requested)];
  }

  const ids = (customModels ?? [])
    .map((entry) => entry.id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    return [resolveInitialModel(instance)];
  }

  const preferred = ids.filter((id) => /(?:^|[/:-])free(?:$|[/:-])/i.test(id));
  const rest = ids.filter((id) => !preferred.includes(id));
  return [...preferred, ...rest];
}

function isRetryableProbeError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("no access") ||
    normalized.includes("insufficient") ||
    normalized.includes("quota") ||
    normalized.includes("credit")
  );
}
