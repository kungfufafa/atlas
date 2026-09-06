import type {
  ConfigureProviderRequest,
  CreateProviderRequest,
  CustomModelEntry,
  OllamaHostMode,
  ProviderModelOption,
  WireApi,
} from "@atlas/core/contract";
import {
  OLLAMA_CLOUD_DEFAULT_BASE_URL,
  OLLAMA_LOCAL_DEFAULT_BASE_URL,
} from "@atlas/core/ollama-provider-config";
import { PROVIDER_CAPABILITY_IDS } from "@atlas/core/provider-capabilities";
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  type BuiltinProviderDefinition,
  getBuiltinProviderDefinition,
  isSubscriptionProvider,
  providerApiKeyIsRequired,
  providerUsesGenericCustomModelSetup,
} from "@atlas/core/provider-catalog";
import { formatConfiguredProviderLabel } from "@atlas/core/provider-label";
import type { UserProviderName } from "@atlas/core/provider-resolution";

export type SelectedProvider = UserProviderName;

export const OPENROUTER_MODEL_SLUG_PATTERN = /^[\w.-]+\/[\w.:-]+$/;

export function isOpenRouterModelSlug(model: string): boolean {
  return OPENROUTER_MODEL_SLUG_PATTERN.test(model.trim());
}

export function filterModelsByProvider(
  models: ProviderModelOption[],
  provider: SelectedProvider | null | undefined
): ProviderModelOption[] {
  if (!provider) {
    return models;
  }

  return models.filter((model) => model.provider === provider);
}

export function defaultModelForProvider(
  models: ProviderModelOption[],
  provider: SelectedProvider
): string {
  const providerModels = filterModelsByProvider(models, provider);
  return (
    providerModels.find((model) => model.default)?.id ??
    providerModels[0]?.id ??
    ""
  );
}

export function formatProviderLabel(
  provider: string | null | undefined,
  displayName?: string | null
): string {
  if (provider && getBuiltinProviderDefinition(provider)) {
    return formatConfiguredProviderLabel(
      provider as SelectedProvider,
      displayName
    );
  }

  return provider ?? "Provider";
}

export const PROVIDER_OPTIONS: Array<{ id: SelectedProvider; label: string }> =
  BUILTIN_PROVIDER_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.displayName,
  }));

export function shouldRenderGenericCustomModelEditor(
  definition:
    | Pick<BuiltinProviderDefinition, "discoveryModels" | "setup">
    | undefined
): boolean {
  return providerUsesGenericCustomModelSetup(definition);
}

/** Custom OpenAI-compatible endpoints can be added more than once; builtins are one instance each. */
export function allowsMultipleProviderInstances(
  provider: SelectedProvider
): boolean {
  return (
    getBuiltinProviderDefinition(provider)?.allowMultipleInstances === true
  );
}

export function isProviderTypeAlreadyConfigured(
  provider: SelectedProvider,
  configuredTypes: ReadonlySet<string>
): boolean {
  if (allowsMultipleProviderInstances(provider)) {
    return false;
  }

  return configuredTypes.has(provider);
}

export function firstAvailableProviderOption(
  configuredTypes: ReadonlySet<string>,
  preferred: SelectedProvider = "openai"
): SelectedProvider {
  if (!isProviderTypeAlreadyConfigured(preferred, configuredTypes)) {
    return preferred;
  }

  const next = PROVIDER_OPTIONS.find(
    (option) => !isProviderTypeAlreadyConfigured(option.id, configuredTypes)
  );

  return next?.id ?? "openai_compatible";
}

/** OpenCode Zen free catalog — not OpenCode Go (`/zen/go`). */
export function isOpenCodeZenBaseUrl(
  baseUrl: string | null | undefined
): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "opencode.ai") {
      return false;
    }

    const path = url.pathname.toLowerCase();
    return /\/zen(\/|$)/.test(path) && !/\/zen\/go(\/|$)/.test(path);
  } catch {
    const normalized = trimmed.toLowerCase();
    return (
      normalized.includes("opencode.ai/zen") &&
      !normalized.includes("opencode.ai/zen/go")
    );
  }
}

export function hasOpenCodeZenProvider(
  providers: ReadonlyArray<{
    type: string;
    baseUrl?: string | null;
    label?: string | null;
  }>
): boolean {
  return providers.some((provider) => {
    if (provider.type !== "openai_compatible") {
      return false;
    }

    if (isOpenCodeZenBaseUrl(provider.baseUrl)) {
      return true;
    }

    return provider.label?.trim().toLowerCase() === "opencode zen";
  });
}

export function apiKeyPlaceholder(provider: SelectedProvider): string {
  return getBuiltinProviderDefinition(provider)?.apiKey.placeholder ?? "sk-…";
}

export function isApiKeyRequiredForProvider(
  provider: SelectedProvider,
  setupValues: Readonly<Record<string, string | undefined>> = {}
): boolean {
  const policy = getBuiltinProviderDefinition(provider)?.apiKey;
  return policy ? providerApiKeyIsRequired(policy, setupValues) : true;
}

export function shouldShowApiKeyDashboardHint(
  provider: SelectedProvider
): boolean {
  return (
    getBuiltinProviderDefinition(provider)?.apiKey.requirement === "required"
  );
}

export function validateApiKeyForProvider(
  apiKey: string,
  provider: SelectedProvider,
  setupValues: Readonly<Record<string, string | undefined>> = {}
): string | null {
  if (!isApiKeyRequiredForProvider(provider, setupValues)) {
    return null;
  }

  if (!apiKey.trim()) {
    return "API key is required.";
  }

  return null;
}

export function validateDisplayNameInput(displayName: string): string | null {
  const trimmed = displayName.trim();

  if (!trimmed) {
    return "Provider name is required.";
  }

  return null;
}

export function validateBaseUrlInput(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();

  if (!trimmed) {
    return "Base URL is required.";
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Base URL must use http or https.";
    }
  } catch {
    return "Enter a valid base URL.";
  }

  return null;
}

export function validateCustomModelsInput(
  models: Array<{ id: string }>
): string | null {
  const valid = models.filter((model) => model.id.trim());

  if (valid.length === 0) {
    return "Add at least one model.";
  }

  const seenModelIds = new Set<string>();
  for (const model of valid) {
    const id = model.id.trim();
    if (seenModelIds.has(id)) {
      return `Model IDs must be unique ("${id}" is duplicated).`;
    }
    seenModelIds.add(id);
  }

  return null;
}

export function validateOpenRouterModelsInput(
  models: Array<{
    id: string;
    inputPerMillionUsd?: number;
    outputPerMillionUsd?: number;
  }>
): string | null {
  const listError = validateCustomModelsInput(models);
  if (listError) {
    return listError;
  }

  for (const row of models) {
    const slugError = validateCustomOpenRouterModel(row.id);
    if (slugError) {
      return slugError;
    }

    const hasInput = row.inputPerMillionUsd !== undefined;
    const hasOutput = row.outputPerMillionUsd !== undefined;
    if (hasInput !== hasOutput) {
      return `Model "${row.id.trim()}" must set both input and output $/1M rates, or leave both blank.`;
    }
  }

  return null;
}

export function validateShortlistCapabilityModelsInput(
  models: Array<{
    id: string;
    inputPerMillionUsd?: number;
    outputPerMillionUsd?: number;
  }>
): string | null {
  const listError = validateCustomModelsInput(models);
  if (listError) {
    return listError;
  }

  for (const row of models) {
    const hasInput = row.inputPerMillionUsd !== undefined;
    const hasOutput = row.outputPerMillionUsd !== undefined;
    if (hasInput !== hasOutput) {
      return `Model "${row.id.trim()}" must set both input and output $/1M rates, or leave both blank.`;
    }
  }

  return null;
}

export function defaultOllamaSetupBaseUrl(hostMode: OllamaHostMode): string {
  return hostMode === "cloud"
    ? OLLAMA_CLOUD_DEFAULT_BASE_URL
    : OLLAMA_LOCAL_DEFAULT_BASE_URL;
}

const OPENCODE_GO_MODEL_ID_PATTERN = /^opencode-go\/[\w.-]+$/;

export function validateOpenCodeGoModelId(model: string): string | null {
  const trimmed = model.trim();

  if (!trimmed) {
    return null;
  }

  if (!OPENCODE_GO_MODEL_ID_PATTERN.test(trimmed)) {
    return "Use opencode-go/model format, e.g. opencode-go/kimi-k2.7-code";
  }

  return null;
}

export function validateOpenCodeGoModelsInput(
  models: Array<{ id: string }>
): string | null {
  const valid = models.filter((model) => model.id.trim());
  if (valid.length === 0) {
    return null;
  }

  for (const row of valid) {
    const idError = validateOpenCodeGoModelId(row.id);
    if (idError) {
      return idError;
    }
  }

  return null;
}

export type ShortlistCapabilityProvider = Extract<
  SelectedProvider,
  "cerebras" | "fireworks"
>;

export function isShortlistCapabilityProvider(
  provider: SelectedProvider
): provider is ShortlistCapabilityProvider {
  return provider === "cerebras" || provider === "fireworks";
}

type ShortlistModelRow = CustomModelEntry;

export function modelsFromShortlistRows(
  provider: ShortlistCapabilityProvider,
  rows: ShortlistModelRow[]
): ProviderModelOption[] {
  const models: ProviderModelOption[] = [];

  for (const row of rows) {
    const id = row.id.trim();
    if (!id) {
      continue;
    }

    models.push({
      ...row,
      ...(row.capabilities ? { capabilities: row.capabilities } : {}),
      id,
      name: row.name?.trim() || id,
      provider,
      ...(row.default ? { default: true } : {}),
      ...(row.supportsThinking === undefined
        ? {}
        : { supportsThinking: row.supportsThinking }),
      ...(row.supportsVision === undefined
        ? {}
        : { supportsVision: row.supportsVision }),
      ...(row.inputPerMillionUsd === undefined
        ? {}
        : { inputPerMillionUsd: row.inputPerMillionUsd }),
      ...(row.outputPerMillionUsd === undefined
        ? {}
        : { outputPerMillionUsd: row.outputPerMillionUsd }),
    });
  }

  return models;
}

export function modelsFromOpenRouterRows(
  rows: CustomModelEntry[]
): ProviderModelOption[] {
  const models: ProviderModelOption[] = [];

  for (const row of rows) {
    const id = row.id.trim();
    if (!id) {
      continue;
    }

    models.push({
      ...row,
      id,
      name: row.name?.trim() || id,
      provider: "openrouter" as const,
      ...(row.default ? { default: true } : {}),
      ...(row.inputPerMillionUsd === undefined
        ? {}
        : { inputPerMillionUsd: row.inputPerMillionUsd }),
      ...(row.outputPerMillionUsd === undefined
        ? {}
        : { outputPerMillionUsd: row.outputPerMillionUsd }),
    });
  }

  return models;
}

export function appendOpenRouterModelRow(
  rows: CustomModelEntry[],
  modelId: string,
  modelName: string,
  metadata?: Omit<CustomModelEntry, "id" | "name" | "default">
): CustomModelEntry[] {
  const existing = rows
    .filter((row) => row.id.trim())
    .map((row) => ({ ...row, default: row.id === modelId }));
  if (existing.some((row) => row.id === modelId)) {
    return existing.map((row) =>
      row.id === modelId ? { ...row, ...metadata, name: modelName } : row
    );
  }
  return [
    ...existing,
    { ...metadata, default: true, id: modelId, name: modelName },
  ];
}

export function resolveOpenRouterSetupModel(
  rows: Array<{ id: string; default?: boolean }>,
  selectedModel: string
): string {
  const trimmed = selectedModel.trim();
  const valid = rows.filter((row) => row.id.trim());

  if (trimmed && valid.some((row) => row.id === trimmed)) {
    return trimmed;
  }

  return valid.find((row) => row.default)?.id ?? valid[0]?.id ?? "";
}

export function validateCustomOpenRouterModel(model: string): string | null {
  const trimmed = model.trim();

  if (!trimmed) {
    return null;
  }

  if (!isOpenRouterModelSlug(trimmed)) {
    return "Use vendor/model format, e.g. anthropic/claude-sonnet-4-6";
  }

  return null;
}

export function getModelDisplayName(
  models: ProviderModelOption[],
  modelId: string | null | undefined
): string {
  if (!modelId) {
    return "Unknown";
  }

  return models.find((model) => model.id === modelId)?.name ?? modelId;
}

export function buildCreateProviderRequest(options: {
  apiKey: string;
  provider: SelectedProvider;
  model?: string;
  displayName?: string;
  baseUrl?: string;
  hostMode?: OllamaHostMode;
  customModels?: ConfigureProviderRequest["customModels"];
  wireApi?: WireApi;
}): CreateProviderRequest {
  const request = buildConfigureProviderRequest(options);
  if (isSubscriptionProvider(request.provider)) {
    return {
      ...(request.model ? { model: request.model } : {}),
      type: request.provider,
    };
  }
  const setup = getBuiltinProviderDefinition(options.provider)?.setup;

  const fields = {
    type: request.provider,
    ...(request.model ? { model: request.model } : {}),
    ...(setup?.displayName && options.displayName?.trim()
      ? { label: options.displayName.trim() }
      : {}),
    ...(options.baseUrl?.trim() ? { baseUrl: options.baseUrl.trim() } : {}),
    ...(setup?.hostMode && options.hostMode
      ? { hostMode: options.hostMode }
      : {}),
    ...(request.customModels ? { customModels: request.customModels } : {}),
    ...(request.wireApi ? { wireApi: request.wireApi } : {}),
  };
  return {
    ...fields,
    apiKey: request.apiKey ?? "",
    type: request.provider,
  };
}

export function buildConfigureProviderRequest(options: {
  apiKey: string;
  provider: SelectedProvider;
  model?: string;
  displayName?: string;
  baseUrl?: string;
  hostMode?: OllamaHostMode;
  customModels?: ConfigureProviderRequest["customModels"];
  wireApi?: WireApi;
}): ConfigureProviderRequest {
  if (isSubscriptionProvider(options.provider)) {
    return {
      ...(options.model ? { model: options.model } : {}),
      provider: options.provider,
    };
  }
  const setup = getBuiltinProviderDefinition(options.provider)?.setup;
  const request: ConfigureProviderRequest = {
    apiKey: options.apiKey,
    provider: options.provider,
    ...(options.model ? { model: options.model } : {}),
    ...(setup?.configureBaseUrl !== "omit" && options.baseUrl?.trim()
      ? { baseUrl: options.baseUrl.trim() }
      : {}),
    ...(setup?.customModels && options.customModels?.length
      ? { customModels: options.customModels }
      : {}),
    ...(setup?.displayName && options.displayName?.trim()
      ? { displayName: options.displayName.trim() }
      : {}),
    ...(setup?.hostMode && options.hostMode
      ? { hostMode: options.hostMode }
      : {}),
    ...(setup?.wireApi && options.wireApi ? { wireApi: options.wireApi } : {}),
  };
  return request;
}

export function encodeModelSelection(
  providerId: string,
  modelId: string
): string {
  return `${providerId}::${modelId}`;
}

export function decodeModelSelection(
  value: string
): { providerId: string; modelId: string } | null {
  const separator = value.indexOf("::");

  if (separator <= 0) {
    return null;
  }

  return {
    modelId: value.slice(separator + 2),
    providerId: value.slice(0, separator),
  };
}

export function extractModelId(
  value: string | null | undefined
): string | null {
  if (!value) {
    return null;
  }

  return decodeModelSelection(value)?.modelId ?? value;
}

export function groupModelsByProvider(models: ProviderModelOption[]): Array<{
  providerId: string;
  providerLabel: string;
  models: ProviderModelOption[];
}> {
  const groups = new Map<
    string,
    { providerId: string; providerLabel: string; models: ProviderModelOption[] }
  >();

  for (const rawModel of models) {
    const providerId = rawModel.providerId ?? rawModel.provider;
    const providerLabel =
      rawModel.providerLabel ?? formatProviderLabel(rawModel.provider);
    const model = { ...rawModel, providerId, providerLabel };
    const existing = groups.get(providerId);

    if (existing) {
      existing.models.push(model);
      continue;
    }

    groups.set(providerId, {
      models: [model],
      providerId,
      providerLabel,
    });
  }

  return [...groups.values()];
}

export const UNSET_MODEL_VALUE = "";

export function profileModelSelectionValue(
  modelId: string | null,
  groups: ReturnType<typeof groupModelsByProvider>
): string {
  if (!modelId) {
    return UNSET_MODEL_VALUE;
  }

  const decoded = decodeModelSelection(modelId);

  if (decoded && decoded.providerId !== "__unknown__") {
    const group = groups.find(
      (entry) => entry.providerId === decoded.providerId
    );

    // Keep a stored provider-qualified selection even when its model is newer
    // than the catalog currently returned by that provider.
    if (group) {
      return modelId;
    }
  }

  const resolvedModelId = decoded?.modelId ?? modelId;

  for (const group of groups) {
    if (group.models.some((model) => model.id === resolvedModelId)) {
      return encodeModelSelection(group.providerId, resolvedModelId);
    }
  }

  return encodeModelSelection("__unknown__", resolvedModelId);
}

export function profileModelLabel(
  modelId: string | null,
  groups: ReturnType<typeof groupModelsByProvider>
): string {
  if (!modelId) {
    return "";
  }

  const decoded = decodeModelSelection(modelId);
  const resolvedModelId = decoded?.modelId ?? modelId;

  if (decoded && decoded.providerId !== "__unknown__") {
    const group = groups.find(
      (entry) => entry.providerId === decoded.providerId
    );
    const match = group?.models.find((model) => model.id === resolvedModelId);
    if (match) {
      return match.name || match.id;
    }
  }

  for (const group of groups) {
    const match = group.models.find((model) => model.id === resolvedModelId);
    if (match) {
      return match.name || match.id;
    }
  }

  return resolvedModelId;
}

export function firstAvailableModelSelection(
  groups: ReturnType<typeof groupModelsByProvider>
): string | null {
  const group = groups[0];
  const model =
    group?.models.find((entry) => entry.default === true) ?? group?.models[0];

  if (!(group && model)) {
    return null;
  }

  return encodeModelSelection(group.providerId, model.id);
}

export function effectiveProfileModelSelection(
  profileModel: string | null | undefined,
  groups: ReturnType<typeof groupModelsByProvider>
): string | null {
  if (profileModel) {
    return profileModelSelectionValue(profileModel, groups);
  }

  return firstAvailableModelSelection(groups);
}

/** A qualified selection must never borrow metadata from another provider. */
function resolveSelectedModel(
  selection: string | null | undefined,
  groups: ReturnType<typeof groupModelsByProvider>
): ProviderModelOption | undefined {
  const effectiveSelection = selection || firstAvailableModelSelection(groups);
  if (!effectiveSelection) {
    return;
  }
  const decoded = decodeModelSelection(effectiveSelection);
  if (decoded) {
    return groups
      .find((group) => group.providerId === decoded.providerId)
      ?.models.find((model) => model.id === decoded.modelId);
  }
  const matches = groups.flatMap((group) =>
    group.models.filter((model) => model.id === effectiveSelection)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveModelThinkingSupport(
  selection: string | null | undefined,
  groups: ReturnType<typeof groupModelsByProvider>
): boolean | undefined {
  const model = resolveSelectedModel(selection, groups);
  if (!model) {
    return;
  }
  const capability =
    model.capabilities?.[PROVIDER_CAPABILITY_IDS.chatReasoning];
  if (
    model.supportsThinking === false ||
    capability?.status === "unsupported"
  ) {
    return false;
  }
  if (capability?.status === "unknown") {
    return;
  }
  if (capability?.status === "supported" || model.supportsThinking === true) {
    return true;
  }
  return model.reasoningEffortValues?.length ? true : undefined;
}

export function resolveModelReasoningEffortValues(
  selection: string | null | undefined,
  groups: ReturnType<typeof groupModelsByProvider>
): string[] | undefined {
  const model = resolveSelectedModel(selection, groups);
  if (resolveModelThinkingSupport(selection, groups) !== true) {
    return model?.supportsThinking === false ? [] : undefined;
  }
  return model?.reasoningEffortValues;
}

export function resolveModelDefaultReasoningEffort(
  selection: string | null | undefined,
  groups: ReturnType<typeof groupModelsByProvider>
): string | undefined {
  const model = resolveSelectedModel(selection, groups);
  const values = resolveModelReasoningEffortValues(selection, groups);
  return model?.defaultReasoningEffort &&
    values?.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : undefined;
}

export function resolveModelVisionSupport(
  selection: string | null | undefined,
  groups: ReturnType<typeof groupModelsByProvider>
): boolean | undefined {
  if (!selection) {
    return;
  }
  const model = resolveSelectedModel(selection, groups);
  const capability =
    model?.capabilities?.[PROVIDER_CAPABILITY_IDS.chatInputImage];
  if (model?.supportsVision === false || capability?.status === "unsupported") {
    return false;
  }
  if (capability?.status === "unknown") {
    return;
  }
  return capability?.status === "supported" ? true : model?.supportsVision;
}

export function modelsFromCustomRows(
  rows: CustomModelEntry[]
): ProviderModelOption[] {
  const models: ProviderModelOption[] = [];

  for (const row of rows) {
    const id = row.id.trim();
    if (!id) {
      continue;
    }

    models.push({
      ...row,
      id,
      name: row.name?.trim() || id,
      provider: "openai_compatible" as const,
      ...(row.default ? { default: true } : {}),
    });
  }

  return models;
}
