import type { CreateProviderResponse } from "@atlas/core/contract";
import { isDiscoveryModelProvider } from "@atlas/core/discovery-providers";
import { ollamaRequiresApiKey } from "@atlas/core/ollama-provider-config";
import { ViewIcon, ViewOffIcon } from "hugeicons-react";
import { useState } from "react";
import { BrowsableModelFields } from "@/components/BrowsableModelFields";
import { CustomProviderFields } from "@/components/CustomProviderFields";
import { ModelsBrowseList } from "@/components/ModelsBrowseList";
import { OllamaProviderSetupFields } from "@/components/OllamaProviderSetupFields";
import { OpenRouterProviderModelFields } from "@/components/OpenRouterProviderModelFields";
import { ProviderSelect } from "@/components/ProviderSelect";
import { isProviderSelectionDisabled } from "@/components/provider-setup-form.shared";
import { RemoteModelsBrowseList } from "@/components/RemoteModelsBrowseList";
import { ShortlistBrowseProviderModelFields } from "@/components/ShortlistBrowseProviderModelFields";
import { isShortlistBrowseProvider } from "@/components/shortlist-browse-providers.shared";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { ModelsDevRow } from "@/hooks/use-models-dev";
import { useProviderSetupForm } from "@/hooks/use-provider-setup-form";
import {
  apiKeyPlaceholder,
  formatProviderLabel,
  type SelectedProvider,
} from "@/lib/models";

interface ProviderSetupFormProps {
  density?: "default" | "compact";
  onSuccess?: (result: CreateProviderResponse) => void;
  showHeading?: boolean;
  submitLabel?: string;
}

function ProviderApiKeyField({
  apiKey,
  apiKeyError,
  density,
  disabled,
  onApiKeyBlur,
  onApiKeyChange,
  onToggleShowApiKey,
  optional,
  selectedProvider,
  showApiKey,
}: {
  apiKey: string;
  apiKeyError: string | null;
  density: "default" | "compact";
  disabled: boolean;
  onApiKeyBlur: () => void;
  onApiKeyChange: (value: string) => void;
  onToggleShowApiKey: () => void;
  optional: boolean;
  selectedProvider: SelectedProvider;
  showApiKey: boolean;
}) {
  const showDashboardHint =
    selectedProvider !== "openai_compatible" && selectedProvider !== "ollama";

  return (
    <FormField
      density={density}
      footer={
        apiKeyError ? (
          <p
            className="text-destructive text-sm"
            id="api-key-error"
            role="alert"
          >
            {apiKeyError}
          </p>
        ) : showDashboardHint ? (
          <p className="text-muted-foreground text-xs" id="api-key-hint">
            Paste the API key from your provider dashboard.
          </p>
        ) : null
      }
      id="api-key"
      label={optional ? "API key (optional)" : "API key"}
    >
      <InputGroup>
        <InputGroupInput
          aria-describedby={
            apiKeyError
              ? "api-key-error"
              : showDashboardHint
                ? "api-key-hint"
                : undefined
          }
          aria-invalid={apiKeyError != null}
          autoComplete="off"
          disabled={disabled}
          id="api-key"
          onBlur={onApiKeyBlur}
          onChange={(event) => onApiKeyChange(event.target.value)}
          placeholder={apiKeyPlaceholder(selectedProvider)}
          type={showApiKey ? "text" : "password"}
          value={apiKey}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label={showApiKey ? "Hide API key" : "Show API key"}
            onClick={onToggleShowApiKey}
            size="icon-sm"
          >
            {showApiKey ? <ViewOffIcon /> : <ViewIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </FormField>
  );
}

export function ProviderSetupForm({
  submitLabel = "Save & continue",
  showHeading = true,
  density = "default",
  onSuccess,
}: ProviderSetupFormProps) {
  const form = useProviderSetupForm({ onSuccess });
  const [isBrowsing, setIsBrowsing] = useState(false);
  const ollamaKeyRequired = ollamaRequiresApiKey(form.ollamaHostMode);
  const apiKeyOptional =
    form.selectedProvider === "openai_compatible" ||
    (form.selectedProvider === "ollama" && !ollamaKeyRequired);
  const directDiscoveryProvider =
    form.selectedProvider !== "openai_compatible" &&
    isDiscoveryModelProvider(form.selectedProvider)
      ? form.selectedProvider
      : null;
  const isDirectDiscoveryProvider = directDiscoveryProvider !== null;
  const providerSelectionDisabled = isProviderSelectionDisabled({
    saving: form.busy,
    testingConnection: form.testingConnection,
  });
  const controlsDisabled = providerSelectionDisabled;

  const formSpacing = density === "compact" ? "space-y-4" : "space-y-5";

  function handleBrowseSelect(
    provider: SelectedProvider,
    modelId: string,
    row: ModelsDevRow
  ) {
    form.handleBrowseSelect(provider, modelId, row);
    setIsBrowsing(false);
  }

  return (
    <form
      className={formSpacing}
      onSubmit={(event) => void form.handleSubmit(event)}
    >
      {showHeading && (
        <div>
          <h3 className="font-medium text-foreground text-sm">
            Connect a provider
          </h3>
          <p className="mt-1 text-muted-foreground text-xs">
            Choose a provider, paste your API key, and pick a default model.
          </p>
        </div>
      )}

      <FormField density={density} id="provider" label="Provider">
        <ProviderSelect
          configuredTypes={form.configuredTypes}
          disabled={providerSelectionDisabled}
          id="provider"
          onValueChange={(nextValue) => {
            if (nextValue === "__browse__") {
              setIsBrowsing(true);
              return;
            }

            setIsBrowsing(false);
            form.handleProviderSelect(nextValue);
          }}
          value={isBrowsing ? "__browse__" : form.selectedProvider}
        />
      </FormField>

      {isBrowsing ? (
        <ModelsBrowseList
          className="h-72 rounded-md border border-border"
          configuredTypes={form.configuredTypes}
          onSelect={handleBrowseSelect}
          openCodeZenConfigured={form.openCodeZenConfigured}
        />
      ) : (
        <>
          {form.selectedProvider === "openai_compatible" ? (
            <CustomProviderFields
              apiKey={form.apiKey}
              baseUrl={form.baseUrl}
              baseUrlError={form.baseUrlError}
              connectionExtra={
                <ProviderApiKeyField
                  apiKey={form.apiKey}
                  apiKeyError={form.apiKeyError}
                  density={density}
                  disabled={controlsDisabled}
                  onApiKeyBlur={form.handleApiKeyBlur}
                  onApiKeyChange={form.handleApiKeyChange}
                  onToggleShowApiKey={() =>
                    form.setShowApiKey((current) => !current)
                  }
                  optional={apiKeyOptional}
                  selectedProvider={form.selectedProvider}
                  showApiKey={form.showApiKey}
                />
              }
              credentialRevision={form.remoteCredentialRevision}
              customModels={form.customModels}
              density={density}
              disabled={controlsDisabled}
              displayName={form.displayName}
              displayNameError={form.displayNameError}
              modelsError={form.modelsError}
              onBaseUrlChange={form.setBaseUrl}
              onCustomModelsChange={form.setCustomModels}
              onDisplayNameChange={form.setDisplayName}
              onWireApiChange={form.setWireApi}
              wireApi={form.wireApi}
            />
          ) : (
            <ProviderApiKeyField
              apiKey={form.apiKey}
              apiKeyError={form.apiKeyError}
              density={density}
              disabled={controlsDisabled}
              onApiKeyBlur={form.handleApiKeyBlur}
              onApiKeyChange={form.handleApiKeyChange}
              onToggleShowApiKey={() =>
                form.setShowApiKey((current) => !current)
              }
              optional={apiKeyOptional}
              selectedProvider={form.selectedProvider}
              showApiKey={form.showApiKey}
            />
          )}

          {form.selectedProvider === "cloudflare" ? (
            <FormField
              density={density}
              footer={
                form.baseUrlError ? (
                  <p
                    className="text-destructive text-sm"
                    id="cloudflare-account-id-error"
                    role="alert"
                  >
                    {form.baseUrlError}
                  </p>
                ) : null
              }
              id="cloudflare-account-id"
              label="Account ID"
            >
              <Input
                aria-describedby={
                  form.baseUrlError ? "cloudflare-account-id-error" : undefined
                }
                aria-invalid={form.baseUrlError != null}
                autoComplete="off"
                disabled={controlsDisabled}
                id="cloudflare-account-id"
                onChange={(event) => form.setBaseUrl(event.target.value)}
                value={form.baseUrl}
              />
            </FormField>
          ) : null}

          {directDiscoveryProvider ? (
            <CustomProviderFields
              apiKey={form.apiKey}
              baseUrl={form.baseUrl}
              baseUrlError={form.baseUrlError}
              browseLabel={formatProviderLabel(directDiscoveryProvider)}
              credentialRevision={form.remoteCredentialRevision}
              customModels={form.customModels}
              density={density}
              disabled={controlsDisabled}
              displayName={formatProviderLabel(directDiscoveryProvider)}
              displayNameError={null}
              identityReadOnly
              key={directDiscoveryProvider}
              modelsError={form.modelsError}
              onBaseUrlChange={form.setBaseUrl}
              onCustomModelsChange={form.setCustomModels}
              onDisplayNameChange={form.setDisplayName}
              remoteProvider={directDiscoveryProvider}
            />
          ) : null}

          {form.selectedProvider === "openrouter" ? (
            <OpenRouterProviderModelFields
              customModels={form.openRouterModels}
              density={density}
              disabled={controlsDisabled}
              modelsError={form.openRouterModelsError}
              onCustomModelsChange={form.handleOpenRouterModelsChange}
            />
          ) : null}

          {form.selectedProvider === "ollama" ? (
            <>
              <OllamaProviderSetupFields
                baseUrl={form.baseUrl}
                baseUrlError={form.baseUrlError}
                density={density}
                disabled={controlsDisabled}
                hostMode={form.ollamaHostMode}
                onBaseUrlChange={form.setBaseUrl}
                onHostModeChange={form.handleOllamaHostModeChange}
              />
              <BrowsableModelFields
                browseLabel="Browse Ollama"
                customModels={form.customModels}
                density={density}
                disabled={controlsDisabled}
                fieldId="ollama-models"
                footerHint={
                  <>
                    Add models by ID or browse live models from your Ollama host
                    (for example <span className="font-mono">llama3.2</span>).
                  </>
                }
                modelsError={form.modelsError}
                onCustomModelsChange={form.setCustomModels}
                renderBrowse={({ multiSelect, onAddMany, onSelect }) => (
                  <RemoteModelsBrowseList
                    apiKey={form.apiKey}
                    baseUrl={form.baseUrl}
                    browseLabel="Ollama"
                    className="h-72 rounded-md border border-border"
                    credentialRevision={form.remoteCredentialRevision}
                    disabled={controlsDisabled}
                    hostMode={form.ollamaHostMode}
                    multiSelect={multiSelect}
                    onAddMany={onAddMany}
                    onSelect={onSelect}
                    provider="ollama"
                  />
                )}
                showPricing={false}
                showThinking
                showVision
                toModelRow={(row: {
                  id: string;
                  name: string;
                  reasoningEffortValues?: string[];
                  supportsThinking?: boolean;
                  supportsVision?: boolean;
                }) => ({
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
                })}
              />
            </>
          ) : null}

          {isShortlistBrowseProvider(form.selectedProvider) ? (
            <ShortlistBrowseProviderModelFields
              apiKey={
                form.selectedProvider === "fireworks" ? form.apiKey : undefined
              }
              customModels={form.shortlistModels}
              density={density}
              disabled={controlsDisabled}
              modelsError={form.shortlistModelsError}
              onCustomModelsChange={form.handleShortlistModelsChange}
              provider={form.selectedProvider}
            />
          ) : null}

          {form.selectedProvider !== "openrouter" &&
          !isShortlistBrowseProvider(form.selectedProvider) &&
          form.selectedProvider !== "ollama" &&
          form.selectedProvider !== "openai_compatible" &&
          !isDirectDiscoveryProvider ? (
            <FormField density={density} id="model" label="Model">
              <Select
                disabled={controlsDisabled || form.filteredModels.length === 0}
                onValueChange={(value) =>
                  form.setSelectedModel(value == null ? "" : String(value))
                }
                value={form.selectedModel}
              >
                <SelectTrigger className="w-full" id="model">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {form.filteredModels.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                      {model.default ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          ) : null}

          {form.testSuccess ? (
            <p
              className="font-medium text-emerald-600 text-sm dark:text-emerald-400"
              role="status"
            >
              ✓ {form.testSuccess}
            </p>
          ) : null}

          {form.testError ? (
            <p className="text-destructive text-sm" role="alert">
              {form.testError}
            </p>
          ) : null}

          {form.formError ? (
            <p className="text-destructive text-sm" role="alert">
              {form.formError}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              disabled={
                form.busy ||
                form.testingConnection ||
                !(apiKeyOptional || form.apiKey.trim())
              }
              type="submit"
            >
              {form.busy ? (
                <>
                  <Spinner className="mr-2" />
                  Saving…
                </>
              ) : (
                submitLabel
              )}
            </Button>
            <Button
              disabled={
                form.busy ||
                form.testingConnection ||
                !(apiKeyOptional || form.apiKey.trim())
              }
              onClick={() => void form.handleTestConnection()}
              type="button"
              variant="outline"
            >
              {form.testingConnection ? (
                <>
                  <Spinner className="mr-2" />
                  Testing connection…
                </>
              ) : (
                "Test connection"
              )}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}
