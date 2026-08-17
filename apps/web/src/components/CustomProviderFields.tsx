import { Cancel01Icon } from "hugeicons-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  ModelListEditor,
  type ModelListRow,
} from "@/components/ModelListEditor";
import { ModelsBrowseList } from "@/components/ModelsBrowseList";
import {
  applyInferredCompatibleCapabilities,
  toggleModelListRow,
} from "@/components/model-list-editor.shared";
import {
  type RemoteModelRow,
  RemoteModelsBrowseList,
} from "@/components/RemoteModelsBrowseList";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ModelsDevRow } from "@/hooks/use-models-dev";
import {
  applyCustomProviderPreset,
  CUSTOM_PROVIDER_PRESETS,
  matchCustomProviderPreset,
} from "@/lib/custom-provider-presets";

interface CustomProviderFieldsProps {
  apiKey: string;
  baseUrl: string;
  baseUrlError?: string | null;
  browseLabel?: string;
  /**
   * `remote` fetches models from the provider endpoint via /v1/models/discover.
   * `models.dev` browses the public models.dev catalog (setup helper for custom endpoints).
   */
  browseSource?: "remote" | "models.dev";
  connectionExtra?: ReactNode;
  customModels: ModelListRow[];
  density?: "default" | "compact";
  disabled?: boolean;
  displayName: string;
  displayNameError?: string | null;
  hostMode?: "local" | "cloud";
  identityReadOnly?: boolean;
  modelsError?: string | null;
  onBaseUrlChange: (value: string) => void;
  onCustomModelsChange: (models: ModelListRow[]) => void;
  onDisplayNameChange: (value: string) => void;
  providerInstanceId?: string;
  remoteProvider?: "ollama" | "openai_compatible";
  showModelsEditor?: boolean;
}

export function CustomProviderFields({
  displayName,
  baseUrl,
  apiKey,
  customModels,
  disabled,
  identityReadOnly = false,
  density = "default",
  showModelsEditor = true,
  displayNameError,
  baseUrlError,
  modelsError,
  browseSource = "remote",
  remoteProvider = "openai_compatible",
  providerInstanceId,
  hostMode,
  browseLabel,
  connectionExtra,
  onDisplayNameChange,
  onBaseUrlChange,
  onCustomModelsChange,
}: CustomProviderFieldsProps) {
  const [isBrowsing, setIsBrowsing] = useState(false);
  const identityDisabled = disabled || identityReadOnly;
  const showIdentity = !identityReadOnly;
  const showPresets = showIdentity && remoteProvider === "openai_compatible";
  const resolvedBrowseLabel =
    browseLabel ?? (remoteProvider === "ollama" ? "Ollama" : "this endpoint");
  const selectedPresetId = matchCustomProviderPreset(baseUrl);
  const selectedModelIds = useMemo(
    () =>
      new Set(
        customModels
          .map((model) => model.id.trim())
          .filter((modelId) => modelId.length > 0)
      ),
    [customModels]
  );
  const selectedModels = useMemo(
    () => customModels.filter((model) => model.id.trim().length > 0),
    [customModels]
  );
  const canBrowse =
    browseSource === "models.dev" ||
    Boolean(providerInstanceId?.trim() || baseUrl.trim());

  const handlePresetChange = (presetId: string) => {
    const next = applyCustomProviderPreset(presetId);
    if (!next) {
      return;
    }

    onDisplayNameChange(next.name);
    onBaseUrlChange(next.baseUrl);
  };

  const capabilityContext = {
    baseUrl,
    providerLabel: displayName,
  };

  const handleModelsChange = (models: ModelListRow[]) => {
    onCustomModelsChange(
      applyInferredCompatibleCapabilities(models, capabilityContext)
    );
  };

  const handleModelsDevSelect = (
    _provider: string,
    modelId: string,
    row: ModelsDevRow
  ) => {
    handleModelsChange(
      toggleModelListRow(customModels, {
        id: modelId,
        name: row.modelName,
        ...(row.reasoning ? { supportsThinking: true } : {}),
        ...(row.vision ? { supportsVision: true } : {}),
      })
    );
  };

  const handleRemoteSelect = (row: RemoteModelRow) => {
    handleModelsChange(
      toggleModelListRow(customModels, {
        id: row.id,
        name: row.name,
        ...(row.supportsThinking === undefined
          ? {}
          : { supportsThinking: row.supportsThinking }),
        ...(row.reasoningEffortValues?.length
          ? { reasoningEffortValues: row.reasoningEffortValues }
          : {}),
        ...(row.supportsVision === undefined
          ? {}
          : { supportsVision: row.supportsVision }),
      })
    );
  };

  const handleRemoveSelected = (modelId: string) => {
    onCustomModelsChange(
      customModels.filter((model) => model.id.trim() !== modelId)
    );
  };

  return (
    <div className="space-y-4">
      {showIdentity ? (
        <>
          {showPresets ? (
            <FormField density={density} id="provider-preset" label="Preset">
              <Select
                disabled={identityDisabled}
                onValueChange={(value) => {
                  if (typeof value === "string") {
                    handlePresetChange(value);
                  }
                }}
                value={selectedPresetId}
              >
                <SelectTrigger className="w-full" id="provider-preset">
                  <SelectValue>
                    {CUSTOM_PROVIDER_PRESETS.find(
                      (preset) => preset.id === selectedPresetId
                    )?.label ?? "Custom"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CUSTOM_PROVIDER_PRESETS.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              density={density}
              footer={
                displayNameError ? (
                  <p className="text-destructive text-sm" role="alert">
                    {displayNameError}
                  </p>
                ) : null
              }
              id="provider-display-name"
              label="Provider name"
            >
              <InputGroup>
                <InputGroupInput
                  aria-invalid={displayNameError != null}
                  disabled={identityDisabled}
                  id="provider-display-name"
                  onChange={(event) => onDisplayNameChange(event.target.value)}
                  placeholder="My server"
                  readOnly={identityReadOnly}
                  value={displayName}
                />
              </InputGroup>
            </FormField>

            <FormField
              density={density}
              footer={
                baseUrlError ? (
                  <p className="text-destructive text-sm" role="alert">
                    {baseUrlError}
                  </p>
                ) : null
              }
              id="provider-base-url"
              label="Base URL"
            >
              <InputGroup>
                <InputGroupInput
                  aria-invalid={baseUrlError != null}
                  disabled={identityDisabled}
                  id="provider-base-url"
                  onChange={(event) => onBaseUrlChange(event.target.value)}
                  placeholder="https://api.example.com/v1"
                  readOnly={identityReadOnly}
                  value={baseUrl}
                />
              </InputGroup>
            </FormField>
          </div>
        </>
      ) : null}

      {connectionExtra}

      {showModelsEditor ? (
        <FormField
          density={density}
          footer={
            modelsError ? (
              <p className="text-destructive text-sm" role="alert">
                {modelsError}
              </p>
            ) : null
          }
          id="provider-models"
          label="Models"
        >
          {isBrowsing ? (
            <div className="space-y-2">
              {selectedModels.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {selectedModels.map((model) => {
                    const modelId = model.id.trim();
                    return (
                      <li key={modelId}>
                        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs">
                          <span className="max-w-48 truncate">
                            {model.name?.trim() || modelId}
                          </span>
                          <button
                            aria-label={`Remove ${modelId}`}
                            className="text-muted-foreground hover:text-foreground"
                            disabled={disabled}
                            onClick={() => handleRemoveSelected(modelId)}
                            type="button"
                          >
                            <Cancel01Icon className="size-3" />
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {browseSource === "remote" ? (
                <RemoteModelsBrowseList
                  apiKey={apiKey}
                  baseUrl={baseUrl}
                  browseLabel={resolvedBrowseLabel}
                  className="h-72 rounded-md border border-border"
                  hostMode={hostMode}
                  onSelect={handleRemoteSelect}
                  provider={remoteProvider}
                  providerId={providerInstanceId}
                  selectedIds={selectedModelIds}
                />
              ) : (
                <ModelsBrowseList
                  className="h-72 rounded-md border border-border"
                  onSelect={handleModelsDevSelect}
                />
              )}
              <div className="flex justify-end">
                <Button
                  onClick={() => setIsBrowsing(false)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Done
                </Button>
              </div>
            </div>
          ) : selectedModels.length > 0 ||
            customModels.some((model) => model.id.trim().length === 0) ? (
            <ModelListEditor
              allowEmpty
              browseLabel={
                browseSource === "remote"
                  ? `Browse ${resolvedBrowseLabel}`
                  : "Browse models.dev"
              }
              disabled={disabled}
              models={customModels}
              onBrowse={() => setIsBrowsing(true)}
              onChange={handleModelsChange}
              showPricing={false}
              showThinking
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={disabled || !canBrowse}
                onClick={() => setIsBrowsing(true)}
                size="sm"
                type="button"
              >
                Browse {resolvedBrowseLabel}
              </Button>
              <Button
                disabled={disabled}
                onClick={() =>
                  onCustomModelsChange([...customModels, { id: "", name: "" }])
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Add model ID
              </Button>
            </div>
          )}
        </FormField>
      ) : null}
    </div>
  );
}
