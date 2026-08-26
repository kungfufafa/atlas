import { resolveCloudflareAccountInput } from "@atlas/core/cloudflare-provider-config";
import type {
  CreateProviderResponse,
  OllamaHostMode,
  ProviderModelOption,
  WireApi,
} from "@atlas/core/contract";
import {
  defaultDiscoveryBaseUrl,
  isDiscoveryModelProvider,
} from "@atlas/core/discovery-providers";
import { useQueryClient } from "@tanstack/react-query";
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
  validateApiKeyForProvider,
  validateBaseUrlInput,
  validateCustomModelsInput,
  validateDisplayNameInput,
  validateOpenRouterModelsInput,
  validateShortlistCapabilityModelsInput,
} from "@/lib/models";

interface UseProviderSetupFormOptions {
  onSuccess?: (result: CreateProviderResponse) => void;
}

const EMPTY_CATALOG: ProviderModelOption[] = [];

export function useProviderSetupForm(
  options: UseProviderSetupFormOptions = {}
) {
  const { createProvider } = useAppContext();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  const { data: catalogResponse, error: catalogQueryError } = useModelsQuery({
    enabled: isAuthenticated,
  });
  const { data: providersResponse } = useProvidersQuery({
    enabled: isAuthenticated,
  });
  const catalog =
    catalogResponse?.catalog ?? catalogResponse?.models ?? EMPTY_CATALOG;

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

  const [selectedProvider, setSelectedProvider] =
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
  const providerGenerationRef = useRef(0);

  const invalidateConnectionTest = useCallback(
    (clearDiscoveryCache = false) => {
      providerGenerationRef.current += 1;
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
  }, [invalidateConnectionTest]);

  useEffect(() => {
    if (catalogQueryError) {
      setFormError(formatError(catalogQueryError));
    }
  }, [catalogQueryError]);

  useEffect(() => {
    if (!isProviderTypeAlreadyConfigured(selectedProvider, configuredTypes)) {
      return;
    }

    resetProviderSensitiveState();
    setSelectedProvider(
      firstAvailableProviderOption(configuredTypes, selectedProvider)
    );
  }, [configuredTypes, resetProviderSensitiveState, selectedProvider]);

  const filteredModels = useMemo(() => {
    if (
      isDiscoveryModelProvider(selectedProvider) ||
      selectedProvider === "ollama"
    ) {
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
  ]);

  const ollamaApiKeyOptions = useMemo(
    () => ({ ollamaHostMode }),
    [ollamaHostMode]
  );

  useEffect(() => {
    if (filteredModels.length === 0) {
      return;
    }

    setSelectedModel((current) => {
      if (current && filteredModels.some((model) => model.id === current)) {
        return current;
      }

      return defaultModelForProvider(filteredModels, selectedProvider);
    });
  }, [selectedProvider, filteredModels]);

  const handleApiKeyBlur = useCallback(() => {
    setApiKeyTouched(true);
    setApiKeyError(
      validateApiKeyForProvider(apiKey, selectedProvider, ollamaApiKeyOptions)
    );
  }, [apiKey, selectedProvider, ollamaApiKeyOptions]);

  const handleApiKeyChange = useCallback(
    (value: string) => {
      invalidateConnectionTest(true);
      setApiKey(value);

      if (formError) {
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
            ollamaApiKeyOptions
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
      ollamaApiKeyOptions,
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

      if (provider === "openrouter" && openRouterModels.length === 0) {
        setOpenRouterModels([{ id: "", name: "" }]);
      }

      if (
        isShortlistCapabilityProvider(provider) &&
        shortlistModels.length === 0
      ) {
        setShortlistModels([{ id: "", name: "" }]);
      }

      if (provider === "ollama") {
        setOllamaHostMode("local");
        setBaseUrl(defaultOllamaSetupBaseUrl("local"));
        setCustomModels([{ id: "", name: "" }]);
      }

      if (
        provider !== "openai_compatible" &&
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
        provider !== "openai_compatible" &&
        provider !== "ollama" &&
        !isDiscoveryModelProvider(provider)
      ) {
        setBaseUrl("");
        setDisplayName("");
        setCustomModels([]);
        setDisplayNameError(null);
        setBaseUrlError(null);
        setModelsError(null);
      }

      if (provider === "openai_compatible") {
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
            ollamaHostMode: hostMode,
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
    const trimmedKey = apiKey.trim();
    const isDiscoveryProvider = isDiscoveryModelProvider(selectedProvider);
    const resolvedCloudflareBaseUrl =
      selectedProvider === "cloudflare"
        ? resolveCloudflareAccountInput(baseUrl)
        : null;
    const nextApiKeyError = validateApiKeyForProvider(
      trimmedKey,
      selectedProvider,
      ollamaApiKeyOptions
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
    const nextDisplayNameError =
      selectedProvider === "openai_compatible"
        ? validateDisplayNameInput(displayName)
        : null;
    const nextBaseUrlError =
      isDiscoveryProvider || selectedProvider === "ollama"
        ? validateBaseUrlInput(baseUrl)
        : selectedProvider === "cloudflare" && !resolvedCloudflareBaseUrl
          ? "Enter a Cloudflare account ID or Workers AI URL."
          : null;
    const nextModelsError =
      isDiscoveryProvider || selectedProvider === "ollama"
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
          : isDiscoveryProvider || selectedProvider === "ollama"
            ? resolveOpenRouterSetupModel(customModels, selectedModel)
            : selectedModel;

    setTestingConnection(true);
    setTestSuccess(null);
    setTestError(null);
    const providerGeneration = providerGenerationRef.current;

    try {
      const res = await client.testProvider({
        apiKey: trimmedKey,
        baseUrl: resolvedCloudflareBaseUrl ?? baseUrl,
        customModels:
          isDiscoveryProvider || selectedProvider === "ollama"
            ? normalizeModelListRows(customModels)
            : selectedProvider === "openrouter"
              ? normalizeModelListRows(openRouterModels)
              : isShortlistCapabilityProvider(selectedProvider)
                ? normalizeModelListRows(shortlistModels)
                : undefined,
        hostMode: selectedProvider === "ollama" ? ollamaHostMode : undefined,
        model: modelToSave || undefined,
        type: selectedProvider,
        wireApi: selectedProvider === "openai_compatible" ? wireApi : undefined,
      });
      if (
        isCurrentProviderOperation(
          providerGeneration,
          providerGenerationRef.current
        )
      ) {
        setTestSuccess(res.message);
      }
    } catch (err) {
      if (
        isCurrentProviderOperation(
          providerGeneration,
          providerGenerationRef.current
        )
      ) {
        setTestError(formatError(err));
      }
    } finally {
      if (
        isCurrentProviderOperation(
          providerGeneration,
          providerGenerationRef.current
        )
      ) {
        setTestingConnection(false);
      }
    }
  }, [
    apiKey,
    selectedProvider,
    ollamaApiKeyOptions,
    openRouterModels,
    shortlistModels,
    displayName,
    baseUrl,
    customModels,
    selectedModel,
    ollamaHostMode,
    wireApi,
  ]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();

      const trimmedKey = apiKey.trim();
      const isDiscoveryProvider = isDiscoveryModelProvider(selectedProvider);
      const resolvedCloudflareBaseUrl =
        selectedProvider === "cloudflare"
          ? resolveCloudflareAccountInput(baseUrl)
          : null;
      const nextApiKeyError = validateApiKeyForProvider(
        trimmedKey,
        selectedProvider,
        ollamaApiKeyOptions
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
      const nextDisplayNameError =
        selectedProvider === "openai_compatible"
          ? validateDisplayNameInput(displayName)
          : null;
      const nextBaseUrlError =
        isDiscoveryProvider || selectedProvider === "ollama"
          ? validateBaseUrlInput(baseUrl)
          : selectedProvider === "cloudflare" && !resolvedCloudflareBaseUrl
            ? "Enter a Cloudflare account ID or Workers AI URL."
            : null;
      const nextModelsError =
        isDiscoveryProvider || selectedProvider === "ollama"
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
            selectedProvider === "ollama"
              ? "ollama-base-url"
              : selectedProvider === "cloudflare"
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
            : isDiscoveryProvider || selectedProvider === "ollama"
              ? resolveOpenRouterSetupModel(customModels, selectedModel)
              : selectedModel;

      setBusy(true);
      setFormError(null);
      setTestSuccess(null);
      setTestError(null);

      try {
        const result = await createProvider(
          buildCreateProviderRequest({
            apiKey: trimmedKey,
            baseUrl: resolvedCloudflareBaseUrl ?? baseUrl,
            customModels:
              isDiscoveryProvider || selectedProvider === "ollama"
                ? normalizeModelListRows(customModels)
                : selectedProvider === "openrouter"
                  ? normalizeModelListRows(openRouterModels)
                  : isShortlistCapabilityProvider(selectedProvider)
                    ? normalizeModelListRows(shortlistModels)
                    : undefined,
            displayName:
              selectedProvider === "openai_compatible"
                ? displayName
                : undefined,
            hostMode:
              selectedProvider === "ollama" ? ollamaHostMode : undefined,
            model: modelToSave || undefined,
            provider: selectedProvider,
            wireApi,
          })
        );
        setApiKey("");
        setApiKeyTouched(false);
        setShowApiKey(false);
        setOpenRouterModels([]);
        setShortlistModels([]);
        setCustomModels([]);
        onSuccess?.(result);
      } catch (err) {
        setFormError(formatError(err));
        document.getElementById("api-key")?.focus();
      } finally {
        setBusy(false);
      }
    },
    [
      apiKey,
      baseUrl,
      openRouterModels,
      shortlistModels,
      ollamaHostMode,
      ollamaApiKeyOptions,
      customModels,
      displayName,
      selectedModel,
      selectedProvider,
      configuredTypes,
      createProvider,
      onSuccess,
      filteredModels,
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
    selectedModel,
    selectedProvider,
    setBaseUrl: handleBaseUrlChange,
    setCustomModels: handleCustomModelsChange,
    setDisplayName: handleDisplayNameChange,
    setSelectedModel: handleSelectedModelChange,
    setShowApiKey,
    setWireApi: handleWireApiChange,
    shortlistModels,
    shortlistModelsError,
    showApiKey,
    testError,
    testingConnection,
    testSuccess,
    wireApi,
  };
}
