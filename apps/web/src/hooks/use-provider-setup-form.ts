import { AtlasApiError } from "@atlas/core/api-error";
import { resolveCloudflareAccountInput } from "@atlas/core/cloudflare-provider-config";
import type {
  CreateProviderResponse,
  OllamaHostMode,
  ProviderModelOption,
  SubscriptionProviderKind,
  TestProviderRequest,
  WireApi,
} from "@atlas/core/contract";
import {
  defaultDiscoveryBaseUrl,
  isDiscoveryModelProvider,
} from "@atlas/core/discovery-providers";
import {
  getBuiltinProviderDefinition,
  isSubscriptionProvider,
} from "@atlas/core/provider-catalog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelListRow } from "@/components/ModelListEditor";
import { normalizeModelListRows } from "@/components/model-list-editor.shared";
import { isCurrentProviderOperation } from "@/components/provider-setup-form.shared";
import { useAppContext } from "@/context/use-app-context";
import { useAuth } from "@/context/use-auth";
import { useModelsQuery, useProvidersQuery } from "@/hooks/use-app-queries";
import type { ModelsDevRow } from "@/hooks/use-models-dev";
import { client, formatError } from "@/lib/client";
import {
  appendOpenRouterModelRow,
  buildCreateProviderRequest,
  defaultModelForProvider,
  defaultOllamaSetupBaseUrl,
  filterModelsByProvider,
  firstAvailableProviderOption,
  formatProviderLabel,
  getModelDisplayName,
  hasOpenCodeZenProvider,
  isProviderTypeAlreadyConfigured,
  isShortlistCapabilityProvider,
  modelsFromCustomRows,
  modelsFromOpenRouterRows,
  modelsFromShortlistRows,
  resolveOpenRouterSetupModel,
  type SelectedProvider,
  shouldRenderGenericCustomModelEditor,
  validateApiKeyForProvider,
  validateBaseUrlInput,
  validateCustomModelsInput,
  validateDisplayNameInput,
  validateOpenRouterModelsInput,
  validateShortlistCapabilityModelsInput,
} from "@/lib/models";
import { queryKeys } from "@/lib/query-keys";

interface UseProviderSetupFormOptions {
  onSuccess?: (result: CreateProviderResponse) => void;
}

const EMPTY_CATALOG: ProviderModelOption[] = [];

export type SubscriptionModelSelectionIssue =
  | "not-authenticated"
  | "loading"
  | "load-failed"
  | "no-models"
  | "invalid-model";

export function getSubscriptionModelSelectionIssue({
  authenticated,
  loadFailed,
  loading,
  models,
  selectedModel,
}: {
  authenticated: boolean;
  loadFailed: boolean;
  loading: boolean;
  models: readonly Pick<ProviderModelOption, "id">[];
  selectedModel: string;
}): SubscriptionModelSelectionIssue | null {
  if (!authenticated) {
    return "not-authenticated";
  }
  if (loading) {
    return "loading";
  }
  if (loadFailed) {
    return "load-failed";
  }
  if (models.length === 0) {
    return "no-models";
  }
  return models.some((model) => model.id === selectedModel)
    ? null
    : "invalid-model";
}

function subscriptionModelSelectionMessage(
  issue: SubscriptionModelSelectionIssue | null,
  loadError: unknown
): string | null {
  switch (issue) {
    case "not-authenticated":
      return "Connect the subscription before continuing.";
    case "loading":
      return "Wait for the subscription models to finish loading.";
    case "load-failed":
      return `Could not load subscription models: ${formatError(loadError)}`;
    case "no-models":
      return "No subscription models are available for this account.";
    case "invalid-model":
      return "Select an available subscription model.";
    default:
      return null;
  }
}

export function reconcileTrackedSubscriptionIssue(
  trackedIssue: SubscriptionModelSelectionIssue | null,
  currentIssue: SubscriptionModelSelectionIssue | null
): SubscriptionModelSelectionIssue | null {
  return trackedIssue === null ? null : currentIssue;
}

export function resolveAutomaticProviderModelSelection({
  currentModel,
  models,
  provider,
  subscriptionProvider,
  subscriptionReady,
}: {
  currentModel: string;
  models: ProviderModelOption[];
  provider: SelectedProvider;
  subscriptionProvider: boolean;
  subscriptionReady: boolean;
}): string {
  if (subscriptionProvider && (!subscriptionReady || models.length === 0)) {
    return "";
  }
  if (models.length === 0) {
    return currentModel;
  }
  if (currentModel && models.some((model) => model.id === currentModel)) {
    return currentModel;
  }
  return defaultModelForProvider(models, provider);
}

export function providerSetupFailureFocusId(
  provider: SelectedProvider
): "api-key" | "model" {
  return provider === "chatgpt" || provider === "claude" ? "model" : "api-key";
}

export function isProviderSetupOperationCurrent({
  currentGeneration,
  currentOrgId,
  operationGeneration,
  operationOrgId,
}: {
  currentGeneration: number;
  currentOrgId: string | null;
  operationGeneration: number;
  operationOrgId: string | null;
}): boolean {
  return (
    currentOrgId === operationOrgId &&
    isCurrentProviderOperation(operationGeneration, currentGeneration)
  );
}

export function subscriptionModelErrorRequiresAuthRefresh(
  error: unknown
): boolean {
  return error instanceof AtlasApiError && error.status === 409;
}

export function useProviderSetupForm(
  options: UseProviderSetupFormOptions = {}
) {
  const { createProvider } = useAppContext();
  const queryClient = useQueryClient();
  const { activeOrg, isAuthenticated } = useAuth();
  const activeOrgId = activeOrg?.id ?? null;
  const { data: catalogResponse, error: catalogQueryError } = useModelsQuery({
    enabled: isAuthenticated,
  });
  const { data: providersResponse } = useProvidersQuery({
    enabled: isAuthenticated,
  });
  const catalog =
    catalogResponse?.catalog ?? catalogResponse?.models ?? EMPTY_CATALOG;
  const catalogError = catalogQueryError
    ? formatError(catalogQueryError)
    : null;

  const configuredTypes = useMemo(() => {
    const types = new Set<string>();
    for (const provider of providersResponse?.providers ?? []) {
      types.add(provider.type);
    }
    return types;
  }, [providersResponse?.providers]);

  const openCodeZenConfigured = useMemo(
    () => hasOpenCodeZenProvider(providersResponse?.providers ?? []),
    [providersResponse?.providers]
  );

  const [providerSelection, setSelectedProvider] =
    useState<SelectedProvider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [openRouterModels, setOpenRouterModels] = useState<ModelListRow[]>([]);
  const [openRouterModelsError, setOpenRouterModelsError] = useState<
    string | null
  >(null);
  const [shortlistModels, setShortlistModels] = useState<ModelListRow[]>([]);
  const [shortlistModelsError, setShortlistModelsError] = useState<
    string | null
  >(null);
  const [ollamaHostMode, setOllamaHostMode] = useState<OllamaHostMode>("local");
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [wireApi, setWireApi] = useState<WireApi>("chat");
  const [customModels, setCustomModels] = useState<ModelListRow[]>([]);
  const [extraModels, setExtraModels] = useState<ProviderModelOption[]>([]);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testSuccess, setTestSuccess] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [remoteCredentialRevision, setRemoteCredentialRevision] = useState(0);
  const [authenticatedSubscriptionKind, setAuthenticatedSubscriptionKind] =
    useState<SubscriptionProviderKind | null>(null);
  const authenticatedSubscriptionKindRef =
    useRef<SubscriptionProviderKind | null>(null);
  const providerGenerationRef = useRef(0);
  const formSubscriptionIssueRef =
    useRef<SubscriptionModelSelectionIssue | null>(null);
  const testSubscriptionIssueRef =
    useRef<SubscriptionModelSelectionIssue | null>(null);
  const currentOrgIdRef = useRef(activeOrgId);
  const formOrgIdRef = useRef(activeOrgId);
  const mountedRef = useRef(true);
  currentOrgIdRef.current = activeOrgId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      providerGenerationRef.current += 1;
    };
  }, []);

  const invalidateConnectionTest = useCallback(
    (clearDiscoveryCache = false) => {
      providerGenerationRef.current += 1;
      testSubscriptionIssueRef.current = null;
      setTestSuccess(null);
      setTestError(null);
      setTestingConnection(false);

      if (clearDiscoveryCache) {
        void queryClient.cancelQueries({
          queryKey: ["remoteModelDiscovery"],
        });
        queryClient.removeQueries({ queryKey: ["remoteModelDiscovery"] });
        setRemoteCredentialRevision((current) => current + 1);
      }
    },
    [queryClient]
  );

  const resetProviderSensitiveState = useCallback(() => {
    invalidateConnectionTest(true);
    formSubscriptionIssueRef.current = null;
    setApiKey("");
    setShowApiKey(false);
    setApiKeyTouched(false);
    setApiKeyError(null);
    setFormError(null);
    setTestSuccess(null);
    setTestError(null);
    setTestingConnection(false);
    setDisplayNameError(null);
    setBaseUrlError(null);
    setModelsError(null);
    authenticatedSubscriptionKindRef.current = null;
    setAuthenticatedSubscriptionKind(null);
  }, [invalidateConnectionTest]);

  const resetForOrganizationChange = useCallback(() => {
    resetProviderSensitiveState();
    setSelectedProvider("openai");
    setSelectedModel("");
    setOpenRouterModels([]);
    setOpenRouterModelsError(null);
    setShortlistModels([]);
    setShortlistModelsError(null);
    setOllamaHostMode("local");
    setDisplayName("");
    setBaseUrl("");
    setWireApi("chat");
    setCustomModels([]);
    setExtraModels([]);
    setBusy(false);
  }, [resetProviderSensitiveState]);

  useEffect(() => {
    if (formOrgIdRef.current === activeOrgId) {
      return;
    }
    formOrgIdRef.current = activeOrgId;
    resetForOrganizationChange();
  }, [activeOrgId, resetForOrganizationChange]);

  const selectedProvider = isProviderTypeAlreadyConfigured(
    providerSelection,
    configuredTypes
  )
    ? firstAvailableProviderOption(configuredTypes, providerSelection)
    : providerSelection;
  const selectedProviderDefinition =
    getBuiltinProviderDefinition(selectedProvider);
  const subscriptionKind: SubscriptionProviderKind | null =
    selectedProvider === "chatgpt" || selectedProvider === "claude"
      ? selectedProvider
      : null;
  const subscriptionReady =
    subscriptionKind !== null &&
    authenticatedSubscriptionKind === subscriptionKind;
  const setSubscriptionReady = useCallback(
    (authenticated: boolean) => {
      const nextAuthenticatedKind =
        authenticated && subscriptionKind ? subscriptionKind : null;
      if (nextAuthenticatedKind === authenticatedSubscriptionKindRef.current) {
        return;
      }
      authenticatedSubscriptionKindRef.current = nextAuthenticatedKind;
      const clearFormIssue = formSubscriptionIssueRef.current !== null;
      const clearTestIssue = testSubscriptionIssueRef.current !== null;
      formSubscriptionIssueRef.current = null;
      testSubscriptionIssueRef.current = null;
      if (clearFormIssue) {
        setFormError(null);
      }
      if (clearTestIssue) {
        setTestError(null);
      }
      setTestSuccess(null);
      setAuthenticatedSubscriptionKind(nextAuthenticatedKind);
    },
    [subscriptionKind]
  );
  const subscriptionModelsQuery = useQuery({
    enabled: isAuthenticated && subscriptionReady && subscriptionKind !== null,
    queryFn: async () => {
      if (!subscriptionKind) {
        throw new Error("Unknown subscription provider.");
      }
      return client.listSubscriptionModels(subscriptionKind);
    },
    queryKey: queryKeys.subscription.models(subscriptionKind ?? "none"),
  });
  const { refetch: refetchSubscriptionModels } = subscriptionModelsQuery;
  const subscriptionModels = useMemo(
    () =>
      subscriptionKind && subscriptionReady
        ? filterModelsByProvider(
            subscriptionModelsQuery.data?.models ?? EMPTY_CATALOG,
            subscriptionKind
          )
        : EMPTY_CATALOG,
    [subscriptionKind, subscriptionModelsQuery.data?.models, subscriptionReady]
  );
  const subscriptionModelSelectionIssue = subscriptionKind
    ? getSubscriptionModelSelectionIssue({
        authenticated: subscriptionReady,
        loadFailed: subscriptionModelsQuery.isError,
        loading: subscriptionModelsQuery.isFetching,
        models: subscriptionModels,
        selectedModel,
      })
    : null;
  const subscriptionModelError = subscriptionModelSelectionMessage(
    subscriptionModelSelectionIssue,
    subscriptionModelsQuery.error
  );
  const subscriptionModelsRefreshing =
    subscriptionReady && subscriptionModelsQuery.isFetching;
  const subscriptionModelsFailed =
    subscriptionReady && subscriptionModelsQuery.isError;
  const subscriptionSetupBlocked =
    subscriptionKind !== null && subscriptionModelSelectionIssue !== null;
  const retrySubscriptionModels = useCallback(() => {
    if (!(subscriptionKind && subscriptionReady)) {
      return;
    }
    void refetchSubscriptionModels();
  }, [refetchSubscriptionModels, subscriptionKind, subscriptionReady]);

  useEffect(() => {
    if (
      !(
        subscriptionKind &&
        subscriptionModelErrorRequiresAuthRefresh(subscriptionModelsQuery.error)
      )
    ) {
      return;
    }

    setSubscriptionReady(false);
    void queryClient.invalidateQueries({
      queryKey: queryKeys.subscription.auth(subscriptionKind),
    });
  }, [
    queryClient,
    setSubscriptionReady,
    subscriptionKind,
    subscriptionModelsQuery.error,
  ]);
  const usesGenericCustomModelEditor = shouldRenderGenericCustomModelEditor(
    selectedProviderDefinition
  );
  const usesEditableCustomModels =
    isDiscoveryModelProvider(selectedProvider) ||
    selectedProviderDefinition?.setup?.hostMode === "ollama" ||
    usesGenericCustomModelEditor;

  useEffect(() => {
    if (selectedProvider === providerSelection) {
      return;
    }
    resetProviderSensitiveState();
  }, [providerSelection, resetProviderSensitiveState, selectedProvider]);

  useEffect(() => {
    const trackedFormIssue = formSubscriptionIssueRef.current;
    if (trackedFormIssue !== null) {
      const nextFormIssue = reconcileTrackedSubscriptionIssue(
        trackedFormIssue,
        subscriptionModelSelectionIssue
      );
      formSubscriptionIssueRef.current = nextFormIssue;
      setFormError(nextFormIssue === null ? null : subscriptionModelError);
    }

    const trackedTestIssue = testSubscriptionIssueRef.current;
    if (trackedTestIssue !== null) {
      const nextTestIssue = reconcileTrackedSubscriptionIssue(
        trackedTestIssue,
        subscriptionModelSelectionIssue
      );
      testSubscriptionIssueRef.current = nextTestIssue;
      setTestError(nextTestIssue === null ? null : subscriptionModelError);
    }
  }, [subscriptionModelError, subscriptionModelSelectionIssue]);

  const filteredModels = useMemo(() => {
    if (subscriptionKind) {
      return subscriptionModels;
    }

    if (usesEditableCustomModels) {
      return modelsFromCustomRows(customModels).map((model) => ({
        ...model,
        provider: selectedProvider,
      }));
    }

    if (selectedProvider === "openrouter") {
      return modelsFromOpenRouterRows(openRouterModels);
    }

    if (isShortlistCapabilityProvider(selectedProvider)) {
      return modelsFromShortlistRows(selectedProvider, shortlistModels);
    }

    const catalogModels = filterModelsByProvider(catalog, selectedProvider);
    const catalogIds = new Set(catalogModels.map((model) => model.id));
    const extras = extraModels.filter(
      (model) =>
        model.provider === selectedProvider && !catalogIds.has(model.id)
    );
    return [...catalogModels, ...extras];
  }, [
    catalog,
    selectedProvider,
    customModels,
    openRouterModels,
    shortlistModels,
    extraModels,
    subscriptionKind,
    subscriptionModels,
    usesEditableCustomModels,
  ]);

  const providerApiKeySetupValues = useMemo(
    () => ({ hostMode: ollamaHostMode }),
    [ollamaHostMode]
  );

  const automaticSelectedModel = resolveAutomaticProviderModelSelection({
    currentModel: selectedModel,
    models: filteredModels,
    provider: selectedProvider,
    subscriptionProvider: subscriptionKind !== null,
    subscriptionReady,
  });

  useEffect(() => {
    if (automaticSelectedModel === selectedModel) {
      return;
    }
    invalidateConnectionTest();
    setSelectedModel(automaticSelectedModel);
  }, [automaticSelectedModel, invalidateConnectionTest, selectedModel]);

  const handleApiKeyBlur = useCallback(() => {
    setApiKeyTouched(true);
    setApiKeyError(
      validateApiKeyForProvider(
        apiKey,
        selectedProvider,
        providerApiKeySetupValues
      )
    );
  }, [apiKey, selectedProvider, providerApiKeySetupValues]);

  const handleApiKeyChange = useCallback(
    (value: string) => {
      invalidateConnectionTest(true);
      setApiKey(value);

      if (formError) {
        formSubscriptionIssueRef.current = null;
        setFormError(null);
      }

      if (testSuccess || testError) {
        setTestSuccess(null);
        setTestError(null);
      }

      if (apiKeyTouched) {
        setApiKeyError(
          validateApiKeyForProvider(
            value,
            selectedProvider,
            providerApiKeySetupValues
          )
        );
      } else if (apiKeyError) {
        setApiKeyError(null);
      }
    },
    [
      apiKeyTouched,
      apiKeyError,
      formError,
      selectedProvider,
      providerApiKeySetupValues,
      invalidateConnectionTest,
      testError,
      testSuccess,
    ]
  );

  const handleProviderSelect = useCallback(
    (provider: SelectedProvider) => {
      if (isProviderTypeAlreadyConfigured(provider, configuredTypes)) {
        return;
      }

      resetProviderSensitiveState();
      setSelectedProvider(provider);
      setWireApi("chat");
      const definition = getBuiltinProviderDefinition(provider);
      const usesGenericEditor =
        shouldRenderGenericCustomModelEditor(definition);

      if (provider === "openrouter" && openRouterModels.length === 0) {
        setOpenRouterModels([{ id: "", name: "" }]);
      }

      if (
        isShortlistCapabilityProvider(provider) &&
        shortlistModels.length === 0
      ) {
        setShortlistModels([{ id: "", name: "" }]);
      }

      if (definition?.setup?.hostMode === "ollama") {
        setOllamaHostMode("local");
        setBaseUrl(defaultOllamaSetupBaseUrl("local"));
        setCustomModels([{ id: "", name: "" }]);
      }

      if (usesGenericEditor) {
        setCustomModels([{ id: "", name: "" }]);
      }

      if (
        !definition?.setup?.displayName &&
        isDiscoveryModelProvider(provider)
      ) {
        setBaseUrl(defaultDiscoveryBaseUrl(provider) ?? "");
        setDisplayName(formatProviderLabel(provider));
        setCustomModels([]);
      }

      if (provider !== "openrouter") {
        setOpenRouterModels([]);
        setOpenRouterModelsError(null);
      }

      if (!isShortlistCapabilityProvider(provider)) {
        setShortlistModels([]);
        setShortlistModelsError(null);
      }

      if (
        !(
          definition?.setup?.displayName ||
          definition?.setup?.hostMode ||
          usesGenericEditor ||
          isDiscoveryModelProvider(provider)
        )
      ) {
        setBaseUrl("");
        setDisplayName("");
        setCustomModels([]);
        setDisplayNameError(null);
        setBaseUrlError(null);
        setModelsError(null);
      }

      if (definition?.setup?.displayName) {
        setBaseUrl("");
        setDisplayName("");
        setCustomModels([]);
      }
    },
    [
      configuredTypes,
      openRouterModels.length,
      resetProviderSensitiveState,
      shortlistModels.length,
    ]
  );

  const selectOpenRouterModel = useCallback(
    (
      modelId: string,
      modelName: string,
      pricing?: { inputPerMillionUsd?: number; outputPerMillionUsd?: number }
    ) => {
      setOpenRouterModels((current) =>
        appendOpenRouterModelRow(current, modelId, modelName, pricing)
      );
      setSelectedModel(modelId);
      setOpenRouterModelsError(null);
    },
    []
  );

  const handleBrowseSelect = useCallback(
    (provider: SelectedProvider, modelId: string, row: ModelsDevRow) => {
      if (isProviderTypeAlreadyConfigured(provider, configuredTypes)) {
        return;
      }

      if (row.isZen && openCodeZenConfigured) {
        return;
      }

      handleProviderSelect(provider);
      if (provider === "openrouter") {
        selectOpenRouterModel(modelId, row.modelName);
      } else if (provider === "openai_compatible") {
        setDisplayName(row.providerName);
        setBaseUrl(row.apiUrl.replace(/\/$/, ""));
        setCustomModels([
          {
            id: modelId,
            name: row.modelName,
            ...(row.reasoning ? { supportsThinking: true } : {}),
            ...(row.vision ? { supportsVision: true } : {}),
          },
        ]);
        setSelectedModel(modelId);
        if (row.isZen && row.isFree && !row.deprecated) {
          setApiKey("public");
        }
      } else if (isDiscoveryModelProvider(provider)) {
        setDisplayName(formatProviderLabel(provider));
        setBaseUrl(
          row.apiUrl.replace(/\/$/, "") ||
            defaultDiscoveryBaseUrl(provider) ||
            ""
        );
        setCustomModels([
          {
            id: modelId,
            name: row.modelName,
            ...(row.reasoning ? { supportsThinking: true } : {}),
            ...(row.vision ? { supportsVision: true } : {}),
          },
        ]);
        setSelectedModel(modelId);
      } else if (provider === "opencode_go") {
        setExtraModels((current) => {
          if (
            current.some(
              (model) => model.provider === provider && model.id === modelId
            )
          ) {
            return current;
          }
          return [
            ...current,
            {
              id: modelId,
              name: row.modelName,
              provider,
              ...(row.context > 0 ? { contextWindow: row.context } : {}),
            },
          ];
        });
        setSelectedModel(modelId);
      } else {
        setExtraModels((current) => {
          if (
            current.some(
              (model) => model.provider === provider && model.id === modelId
            )
          ) {
            return current;
          }
          return [
            ...current,
            {
              id: modelId,
              name: row.modelName,
              provider,
              ...(row.context > 0 ? { contextWindow: row.context } : {}),
            },
          ];
        });
        setSelectedModel(modelId);
        setBaseUrl(row.apiUrl.replace(/\/$/, ""));
      }
    },
    [
      configuredTypes,
      openCodeZenConfigured,
      handleProviderSelect,
      selectOpenRouterModel,
    ]
  );

  const { onSuccess } = options;

  const handleShortlistModelsChange = useCallback(
    (rows: ModelListRow[]) => {
      invalidateConnectionTest();
      setShortlistModels(rows);
      setShortlistModelsError(null);
    },
    [invalidateConnectionTest]
  );

  const handleOllamaHostModeChange = useCallback(
    (hostMode: OllamaHostMode) => {
      invalidateConnectionTest(true);
      setOllamaHostMode(hostMode);
      if (apiKeyTouched) {
        setApiKeyError(
          validateApiKeyForProvider(apiKey, "ollama", {
            hostMode,
          })
        );
      } else {
        setApiKeyError(null);
      }
    },
    [apiKey, apiKeyTouched, invalidateConnectionTest]
  );

  const handleOpenRouterModelsChange = useCallback(
    (rows: ModelListRow[]) => {
      invalidateConnectionTest();
      setOpenRouterModels(rows);
      setOpenRouterModelsError(null);
    },
    [invalidateConnectionTest]
  );

  const handleBaseUrlChange = useCallback(
    (value: string) => {
      invalidateConnectionTest(true);
      setBaseUrl(value);
    },
    [invalidateConnectionTest]
  );

  const handleCustomModelsChange = useCallback(
    (rows: ModelListRow[]) => {
      invalidateConnectionTest();
      setCustomModels(rows);
    },
    [invalidateConnectionTest]
  );

  const handleDisplayNameChange = useCallback(
    (value: string) => {
      invalidateConnectionTest();
      setDisplayName(value);
    },
    [invalidateConnectionTest]
  );

  const handleSelectedModelChange = useCallback(
    (value: string) => {
      invalidateConnectionTest();
      setSelectedModel(value);
    },
    [invalidateConnectionTest]
  );

  const handleWireApiChange = useCallback(
    (value: WireApi) => {
      invalidateConnectionTest();
      setWireApi(value);
    },
    [invalidateConnectionTest]
  );

  const handleTestConnection = useCallback(async () => {
    if (formOrgIdRef.current !== activeOrgId) {
      return;
    }

    if (subscriptionModelError && subscriptionModelSelectionIssue) {
      formSubscriptionIssueRef.current = null;
      testSubscriptionIssueRef.current = subscriptionModelSelectionIssue;
      setFormError(null);
      setTestSuccess(null);
      setTestError(subscriptionModelError);
      return;
    }

    formSubscriptionIssueRef.current = null;
    testSubscriptionIssueRef.current = null;
    setFormError(null);
    setTestSuccess(null);
    setTestError(null);

    const trimmedKey = apiKey.trim();
    const isDiscoveryProvider = isDiscoveryModelProvider(selectedProvider);
    const setup = selectedProviderDefinition?.setup;
    const resolvedCloudflareBaseUrl =
      setup?.baseUrlInput === "cloudflare-account"
        ? resolveCloudflareAccountInput(baseUrl)
        : null;
    const nextApiKeyError = validateApiKeyForProvider(
      trimmedKey,
      selectedProvider,
      providerApiKeySetupValues
    );
    const nextOpenRouterModelsError =
      selectedProvider === "openrouter"
        ? validateOpenRouterModelsInput(openRouterModels)
        : null;
    const nextShortlistModelsError = isShortlistCapabilityProvider(
      selectedProvider
    )
      ? validateShortlistCapabilityModelsInput(shortlistModels)
      : null;
    const nextDisplayNameError = setup?.displayName
      ? validateDisplayNameInput(displayName)
      : null;
    const nextBaseUrlError =
      isDiscoveryProvider || setup?.hostMode === "ollama"
        ? validateBaseUrlInput(baseUrl)
        : setup?.baseUrlInput === "cloudflare-account" &&
            !resolvedCloudflareBaseUrl
          ? "Enter a Cloudflare account ID or Workers AI URL."
          : null;
    const nextModelsError = usesEditableCustomModels
      ? validateCustomModelsInput(customModels)
      : null;

    setApiKeyTouched(true);
    setApiKeyError(nextApiKeyError);
    setOpenRouterModelsError(nextOpenRouterModelsError);
    setShortlistModelsError(nextShortlistModelsError);
    setDisplayNameError(nextDisplayNameError);
    setBaseUrlError(nextBaseUrlError);
    setModelsError(nextModelsError);

    if (
      nextApiKeyError ||
      nextOpenRouterModelsError ||
      nextShortlistModelsError ||
      nextDisplayNameError ||
      nextBaseUrlError ||
      nextModelsError
    ) {
      return;
    }

    const modelToSave =
      selectedProvider === "openrouter"
        ? resolveOpenRouterSetupModel(openRouterModels, selectedModel)
        : isShortlistCapabilityProvider(selectedProvider)
          ? resolveOpenRouterSetupModel(shortlistModels, selectedModel)
          : usesEditableCustomModels
            ? resolveOpenRouterSetupModel(customModels, selectedModel)
            : selectedModel;

    setTestingConnection(true);
    const providerGeneration = providerGenerationRef.current;
    const operationOrgId = activeOrgId;

    try {
      const testRequest: TestProviderRequest = isSubscriptionProvider(
        selectedProvider
      )
        ? {
            model: modelToSave || undefined,
            type: selectedProvider,
          }
        : {
            apiKey: trimmedKey,
            baseUrl: resolvedCloudflareBaseUrl ?? baseUrl,
            customModels: usesEditableCustomModels
              ? normalizeModelListRows(customModels)
              : selectedProvider === "openrouter"
                ? normalizeModelListRows(openRouterModels)
                : isShortlistCapabilityProvider(selectedProvider)
                  ? normalizeModelListRows(shortlistModels)
                  : undefined,
            hostMode: setup?.hostMode === "ollama" ? ollamaHostMode : undefined,
            model: modelToSave || undefined,
            type: selectedProvider,
            wireApi: setup?.wireApi ? wireApi : undefined,
          };
      const res = await client.testProvider(testRequest);
      if (
        mountedRef.current &&
        isProviderSetupOperationCurrent({
          currentGeneration: providerGenerationRef.current,
          currentOrgId: currentOrgIdRef.current,
          operationGeneration: providerGeneration,
          operationOrgId,
        })
      ) {
        setTestSuccess(res.message);
      }
    } catch (err) {
      if (
        mountedRef.current &&
        isProviderSetupOperationCurrent({
          currentGeneration: providerGenerationRef.current,
          currentOrgId: currentOrgIdRef.current,
          operationGeneration: providerGeneration,
          operationOrgId,
        })
      ) {
        setTestError(formatError(err));
      }
    } finally {
      if (
        mountedRef.current &&
        isProviderSetupOperationCurrent({
          currentGeneration: providerGenerationRef.current,
          currentOrgId: currentOrgIdRef.current,
          operationGeneration: providerGeneration,
          operationOrgId,
        })
      ) {
        setTestingConnection(false);
      }
    }
  }, [
    activeOrgId,
    apiKey,
    selectedProvider,
    providerApiKeySetupValues,
    openRouterModels,
    shortlistModels,
    displayName,
    baseUrl,
    customModels,
    selectedModel,
    ollamaHostMode,
    selectedProviderDefinition,
    subscriptionModelError,
    subscriptionModelSelectionIssue,
    usesEditableCustomModels,
    wireApi,
  ]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();

      if (formOrgIdRef.current !== activeOrgId) {
        return;
      }

      if (subscriptionModelError && subscriptionModelSelectionIssue) {
        formSubscriptionIssueRef.current = subscriptionModelSelectionIssue;
        testSubscriptionIssueRef.current = null;
        setTestError(null);
        setTestSuccess(null);
        setFormError(subscriptionModelError);
        if (subscriptionModelSelectionIssue === "invalid-model") {
          document.getElementById("model")?.focus();
        }
        return;
      }

      formSubscriptionIssueRef.current = null;
      testSubscriptionIssueRef.current = null;
      setFormError(null);
      setTestSuccess(null);
      setTestError(null);

      const trimmedKey = apiKey.trim();
      const isDiscoveryProvider = isDiscoveryModelProvider(selectedProvider);
      const setup = selectedProviderDefinition?.setup;
      const resolvedCloudflareBaseUrl =
        setup?.baseUrlInput === "cloudflare-account"
          ? resolveCloudflareAccountInput(baseUrl)
          : null;
      const nextApiKeyError = validateApiKeyForProvider(
        trimmedKey,
        selectedProvider,
        providerApiKeySetupValues
      );
      const nextOpenRouterModelsError =
        selectedProvider === "openrouter"
          ? validateOpenRouterModelsInput(openRouterModels)
          : null;
      const nextShortlistModelsError = isShortlistCapabilityProvider(
        selectedProvider
      )
        ? validateShortlistCapabilityModelsInput(shortlistModels)
        : null;
      const nextDisplayNameError = setup?.displayName
        ? validateDisplayNameInput(displayName)
        : null;
      const nextBaseUrlError =
        isDiscoveryProvider || setup?.hostMode === "ollama"
          ? validateBaseUrlInput(baseUrl)
          : setup?.baseUrlInput === "cloudflare-account" &&
              !resolvedCloudflareBaseUrl
            ? "Enter a Cloudflare account ID or Workers AI URL."
            : null;
      const nextModelsError = usesEditableCustomModels
        ? validateCustomModelsInput(customModels)
        : null;

      setApiKeyTouched(true);
      setApiKeyError(nextApiKeyError);
      setOpenRouterModelsError(nextOpenRouterModelsError);
      setShortlistModelsError(nextShortlistModelsError);
      setDisplayNameError(nextDisplayNameError);
      setBaseUrlError(nextBaseUrlError);
      setModelsError(nextModelsError);

      if (nextApiKeyError) {
        document.getElementById("api-key")?.focus();
        return;
      }

      if (nextOpenRouterModelsError) {
        return;
      }

      if (nextShortlistModelsError) {
        return;
      }

      if (nextDisplayNameError) {
        document.getElementById("provider-display-name")?.focus();
        return;
      }

      if (nextBaseUrlError) {
        document
          .getElementById(
            setup?.hostMode === "ollama"
              ? "ollama-base-url"
              : setup?.baseUrlInput === "cloudflare-account"
                ? "cloudflare-account-id"
                : "provider-base-url"
          )
          ?.focus();
        return;
      }

      if (nextModelsError) {
        return;
      }

      if (isProviderTypeAlreadyConfigured(selectedProvider, configuredTypes)) {
        setFormError("This provider is already added.");
        return;
      }

      const modelToSave =
        selectedProvider === "openrouter"
          ? resolveOpenRouterSetupModel(openRouterModels, selectedModel)
          : isShortlistCapabilityProvider(selectedProvider)
            ? resolveOpenRouterSetupModel(shortlistModels, selectedModel)
            : usesEditableCustomModels
              ? resolveOpenRouterSetupModel(customModels, selectedModel)
              : selectedModel;

      setBusy(true);
      const operationOrgId = activeOrgId;

      try {
        const result = await createProvider(
          buildCreateProviderRequest({
            apiKey: trimmedKey,
            baseUrl: resolvedCloudflareBaseUrl ?? baseUrl,
            customModels: usesEditableCustomModels
              ? normalizeModelListRows(customModels)
              : selectedProvider === "openrouter"
                ? normalizeModelListRows(openRouterModels)
                : isShortlistCapabilityProvider(selectedProvider)
                  ? normalizeModelListRows(shortlistModels)
                  : undefined,
            displayName: setup?.displayName ? displayName : undefined,
            hostMode: setup?.hostMode === "ollama" ? ollamaHostMode : undefined,
            model: modelToSave || undefined,
            provider: selectedProvider,
            wireApi,
          })
        );
        if (!mountedRef.current || currentOrgIdRef.current !== operationOrgId) {
          return;
        }
        setApiKey("");
        setApiKeyTouched(false);
        setShowApiKey(false);
        setOpenRouterModels([]);
        setShortlistModels([]);
        setCustomModels([]);
        onSuccess?.(result);
      } catch (err) {
        if (!mountedRef.current || currentOrgIdRef.current !== operationOrgId) {
          return;
        }
        formSubscriptionIssueRef.current = null;
        setFormError(formatError(err));
        document
          .getElementById(providerSetupFailureFocusId(selectedProvider))
          ?.focus();
      } finally {
        if (mountedRef.current && currentOrgIdRef.current === operationOrgId) {
          setBusy(false);
        }
      }
    },
    [
      activeOrgId,
      apiKey,
      baseUrl,
      openRouterModels,
      shortlistModels,
      ollamaHostMode,
      providerApiKeySetupValues,
      customModels,
      displayName,
      selectedModel,
      selectedProvider,
      selectedProviderDefinition,
      configuredTypes,
      createProvider,
      onSuccess,
      subscriptionModelError,
      subscriptionModelSelectionIssue,
      subscriptionReady,
      usesEditableCustomModels,
      wireApi,
    ]
  );

  return {
    apiKey,
    apiKeyError,
    baseUrl,
    baseUrlError,
    busy,
    catalog,
    catalogError,
    configuredTypes,
    customModels,
    displayName,
    displayNameError,
    filteredModels,
    formatSuccessMessage: (result: CreateProviderResponse) =>
      `${result.provider.label} connected with ${getModelDisplayName(catalog, result.initialModel)}.`,
    formError,
    handleApiKeyBlur,
    handleApiKeyChange,
    handleBrowseSelect,
    handleOllamaHostModeChange,
    handleOpenRouterModelsChange,
    handleProviderSelect,
    handleShortlistModelsChange,
    handleSubmit,
    handleTestConnection,
    modelsError,
    ollamaHostMode,
    openCodeZenConfigured,
    openRouterModels,
    openRouterModelsError,
    remoteCredentialRevision,
    retrySubscriptionModels,
    selectedModel,
    selectedProvider,
    setBaseUrl: handleBaseUrlChange,
    setCustomModels: handleCustomModelsChange,
    setDisplayName: handleDisplayNameChange,
    setSelectedModel: handleSelectedModelChange,
    setShowApiKey,
    setSubscriptionReady,
    setWireApi: handleWireApiChange,
    shortlistModels,
    shortlistModelsError,
    showApiKey,
    subscriptionModelError,
    subscriptionModelSelectionIssue,
    subscriptionModelsFailed,
    subscriptionModelsRefreshing,
    subscriptionReady,
    subscriptionSetupBlocked,
    testError,
    testingConnection,
    testSuccess,
    usesGenericCustomModelEditor,
    wireApi,
  };
}
