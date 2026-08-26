import type {
  ProviderInstanceSummary,
  ProviderModelOption,
  UpdateProviderRequest,
  WireApi,
} from "@atlas/core/contract";
import {
  defaultDiscoveryBaseUrl,
  isDiscoveryModelProvider,
} from "@atlas/core/discovery-providers";
import { useMemo, useState } from "react";
import { isCatalogShortlistProvider } from "@/components/catalog-provider-model-fields.shared";
import type { ModelListRow } from "@/components/ModelListEditor";
import { normalizeModelListRows } from "@/components/model-list-editor.shared";
import type { RemoteModelBrowseProvider } from "@/components/remote-models-browse.shared";
import {
  seedManageModelRows,
  seedShortlistManageModelRows,
} from "@/components/settings/provider-settings-seed";
import { isShortlistBrowseProvider } from "@/components/shortlist-browse-providers.shared";
import { formatError } from "@/lib/client";
import {
  defaultOllamaSetupBaseUrl,
  type SelectedProvider,
  validateApiKeyForProvider,
  validateBaseUrlInput,
  validateCustomModelsInput,
  validateDisplayNameInput,
  validateOpenCodeGoModelsInput,
  validateOpenRouterModelsInput,
  validateShortlistCapabilityModelsInput,
} from "@/lib/models";

export function useProviderInstanceCard({
  instance,
  catalog,
  onUpdate,
  onDelete,
  onError,
}: {
  instance: ProviderInstanceSummary;
  catalog: ProviderModelOption[];
  onUpdate: (
    providerId: string,
    request: UpdateProviderRequest
  ) => Promise<void>;
  onDelete: (providerId: string) => Promise<void>;
  onError: (error: string | null) => void;
}) {
  const [replaceKeyOpen, setReplaceKeyOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editWireApi, setEditWireApi] = useState<WireApi>("chat");
  const [manageModels, setManageModels] = useState<ModelListRow[]>([]);

  const providerType = instance.type as SelectedProvider;
  const isCompatible = providerType === "openai_compatible";
  const isOllama = providerType === "ollama";
  const isDiscovery = isDiscoveryModelProvider(providerType);
  const isCompatibleLike = isDiscovery || isOllama;
  const remoteProvider: RemoteModelBrowseProvider = isOllama
    ? "ollama"
    : isDiscoveryModelProvider(providerType)
      ? providerType
      : "openai_compatible";
  const isOpenRouter = providerType === "openrouter";
  const isShortlistBrowse = isShortlistBrowseProvider(providerType);
  const isCatalogShortlist = isCatalogShortlistProvider(providerType);

  const catalogModelsForType = useMemo(
    () => catalog.filter((model) => model.provider === providerType),
    [catalog, providerType]
  );

  const instanceModels = useMemo(
    () => catalog.filter((model) => model.providerId === instance.id),
    [catalog, instance.id]
  );

  const openManage = () => {
    setDialogError(null);

    if (isCompatibleLike) {
      setManageModels(
        seedManageModelRows(instance.customModels, instanceModels)
      );
    } else if (isOpenRouter || isShortlistBrowse) {
      setManageModels(
        seedShortlistManageModelRows(
          instance.customModels,
          null,
          instanceModels[0]?.name
        )
      );
    } else if (isCatalogShortlist) {
      setManageModels(
        seedManageModelRows(
          instance.customModels,
          instance.customModels?.length ? instanceModels : []
        )
      );
    }

    setManageOpen(true);
  };

  const openEdit = () => {
    setDialogError(null);
    setApiKey("");
    setShowApiKey(false);
    setEditLabel(instance.label);
    setEditBaseUrl(
      instance.baseUrl ??
        (isOllama
          ? defaultOllamaSetupBaseUrl(instance.hostMode ?? "local")
          : isDiscovery
            ? (defaultDiscoveryBaseUrl(providerType) ?? "")
            : "")
    );
    setEditWireApi(instance.wireApi ?? "chat");
    setManageModels(seedManageModelRows(instance.customModels, instanceModels));
    setEditOpen(true);
  };

  const runUpdate = async (
    request: Parameters<typeof onUpdate>[1],
    close?: () => void
  ) => {
    setBusy(true);
    setDialogError(null);
    onError(null);

    try {
      await onUpdate(instance.id, request);
      close?.();
    } catch (error) {
      const message = formatError(error);
      setDialogError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  const handleReplaceKey = async () => {
    const nextError = validateApiKeyForProvider(apiKey, providerType, {
      ollamaHostMode: instance.hostMode ?? undefined,
    });

    if (nextError) {
      setDialogError(nextError);
      return;
    }

    await runUpdate({ apiKey: apiKey.trim() }, () => {
      setReplaceKeyOpen(false);
      setApiKey("");
      setShowApiKey(false);
    });
  };

  const handleDelete = async () => {
    setBusy(true);
    onError(null);

    try {
      await onDelete(instance.id);
    } catch (error) {
      onError(formatError(error));
    } finally {
      setBusy(false);
    }
  };

  const saveCompatible = async () => {
    const displayNameError = validateDisplayNameInput(editLabel);
    const baseUrlError = validateBaseUrlInput(editBaseUrl);
    const modelsError = validateCustomModelsInput(manageModels);
    const normalizedEditBaseUrl = editBaseUrl.trim().replace(/\/+$/, "");
    const normalizedStoredBaseUrl = (instance.baseUrl ?? "")
      .trim()
      .replace(/\/+$/, "");
    const credentialError =
      normalizedEditBaseUrl !== normalizedStoredBaseUrl &&
      instance.hasApiKey &&
      !apiKey.trim()
        ? "Re-enter the API key when changing a provider base URL."
        : null;

    if (displayNameError || baseUrlError || modelsError || credentialError) {
      setDialogError(
        displayNameError ?? baseUrlError ?? modelsError ?? credentialError
      );
      return;
    }

    await runUpdate(
      {
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        baseUrl: editBaseUrl,
        label: editLabel,
        ...(isOllama
          ? {
              hostMode: editBaseUrl.toLowerCase().includes("ollama.com")
                ? ("cloud" as const)
                : ("local" as const),
            }
          : {}),
        customModels: normalizeModelListRows(manageModels),
        ...(isCompatible ? { wireApi: editWireApi } : {}),
      },
      () => {
        setEditOpen(false);
        setApiKey("");
        setShowApiKey(false);
      }
    );
  };

  const saveManageModels = async () => {
    const modelsError = isOpenRouter
      ? validateOpenRouterModelsInput(manageModels)
      : isShortlistBrowse
        ? validateShortlistCapabilityModelsInput(manageModels)
        : providerType === "opencode_go"
          ? validateOpenCodeGoModelsInput(manageModels)
          : validateCustomModelsInput(manageModels);

    if (modelsError) {
      setDialogError(modelsError);
      return;
    }

    await runUpdate(
      { customModels: normalizeModelListRows(manageModels) },
      () => setManageOpen(false)
    );
  };

  const handleManageModelsChange = (rows: ModelListRow[]) => {
    setManageModels(rows);
    if (dialogError) {
      setDialogError(null);
    }
  };

  const editManageModels = manageModels.length
    ? manageModels
    : seedManageModelRows(instance.customModels, instanceModels);

  return {
    apiKey,
    busy,
    catalogModelsForType,
    dialogError,
    editBaseUrl,
    editLabel,
    editManageModels,
    editOpen,
    editWireApi,
    handleDelete,
    handleManageModelsChange,
    handleReplaceKey,
    isCatalogShortlist,
    isCompatibleLike,
    isDiscovery,
    isOllama,
    isOpenRouter,
    isShortlistBrowse,
    manageModels,
    manageOpen,
    openEdit,
    openManage,
    providerType,
    remoteProvider,
    replaceKeyOpen,
    saveCompatible,
    saveManageModels,
    setApiKey,
    setEditBaseUrl,
    setEditLabel,
    setEditOpen,
    setEditWireApi,
    setManageModels,
    setManageOpen,
    setReplaceKeyOpen,
    setShowApiKey,
    showApiKey,
  };
}
