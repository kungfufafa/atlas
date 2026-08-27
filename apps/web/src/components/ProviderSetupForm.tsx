import type { CreateProviderResponse } from "@atlas/core/contract";
import { isDiscoveryModelProvider } from "@atlas/core/discovery-providers";
import { isSubscriptionProvider } from "@atlas/core/provider-catalog";
import { ViewIcon, ViewOffIcon } from "hugeicons-react";
import { useId, useState } from "react";
import { BrowsableModelFields } from "@/components/BrowsableModelFields";
import { CustomProviderFields } from "@/components/CustomProviderFields";
import { ModelListEditor } from "@/components/ModelListEditor";
import { ModelsBrowseList } from "@/components/ModelsBrowseList";
import { OllamaProviderSetupFields } from "@/components/OllamaProviderSetupFields";
import { OpenRouterProviderModelFields } from "@/components/OpenRouterProviderModelFields";
import { ProviderSelect } from "@/components/ProviderSelect";
import { isProviderSelectionDisabled } from "@/components/provider-setup-form.shared";
import {
  type RemoteModelRow,
  RemoteModelsBrowseList,
} from "@/components/RemoteModelsBrowseList";
import { remoteModelRowToCustomModelEntry } from "@/components/remote-models-browse.shared";
import { ShortlistBrowseProviderModelFields } from "@/components/ShortlistBrowseProviderModelFields";
import { SubscriptionAuthPanel } from "@/components/SubscriptionAuthPanel";
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
  isApiKeyRequiredForProvider,
  type SelectedProvider,
  shouldShowApiKeyDashboardHint,
} from "@/lib/models";

interface ProviderSetupFormProps {
  density?: "default" | "compact";
  onSuccess?: (result: CreateProviderResponse) => void;
  showHeading?: boolean;
  submitLabel?: string;
}

export function subscriptionModelErrorDescriptionId({
  formError,
  formErrorId,
  subscriptionModelError,
  testError,
  testErrorId,
}: {
  formError: string | null;
  formErrorId: string;
  subscriptionModelError: string | null;
  testError: string | null;
  testErrorId: string;
}): string | undefined {
  if (!subscriptionModelError) {
    return;
  }
  if (testError === subscriptionModelError) {
    return testErrorId;
  }
  if (formError === subscriptionModelError) {
    return formErrorId;
  }
}

export function providerSetupActionsDisabled({
  busy,
  credentialReady,
  subscriptionBlocked,
  testingConnection,
}: {
  busy: boolean;
  credentialReady: boolean;
  subscriptionBlocked: boolean;
  testingConnection: boolean;
}): boolean {
  return busy || testingConnection || !credentialReady || subscriptionBlocked;
}

export function providerSetupVisibleFormError(
  formError: string | null,
  catalogError: string | null
): string | null {
  return formError ?? catalogError;
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
  const showDashboardHint = shouldShowApiKeyDashboardHint(selectedProvider);

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

function ProviderSetupFieldGroups({
  controlsDisabled,
  density,
  formErrorId,
  form,
  subscriptionModelIssueId,
  testErrorId,
}: {
  controlsDisabled: boolean;
  density: "default" | "compact";
  formErrorId: string;
  form: ReturnType<typeof useProviderSetupForm>;
  subscriptionModelIssueId: string;
  testErrorId: string;
}) {
  const directDiscoveryProvider =
    form.selectedProvider !== "openai_compatible" &&
    isDiscoveryModelProvider(form.selectedProvider)
      ? form.selectedProvider
      : null;
  const isDirectDiscoveryProvider = directDiscoveryProvider !== null;
  const directlyRenderedSubscriptionIssue =
    form.subscriptionModelSelectionIssue === "load-failed" ||
    form.subscriptionModelSelectionIssue === "no-models";
  const subscriptionModelErrorId = directlyRenderedSubscriptionIssue
    ? subscriptionModelIssueId
    : subscriptionModelErrorDescriptionId({
        formError: form.formError,
        formErrorId,
        subscriptionModelError: form.subscriptionModelError,
        testError: form.testError,
        testErrorId,
      });

  return (
    <>
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
            toModelRow={(row: RemoteModelRow) =>
              remoteModelRowToCustomModelEntry(row)
            }
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

      {form.usesGenericCustomModelEditor ? (
        <FormField
          density={density}
          footer={
            form.modelsError ? (
              <p className="text-destructive text-sm" role="alert">
                {form.modelsError}
              </p>
            ) : null
          }
          id="provider-models"
          label="Models"
        >
          <ModelListEditor
            disabled={controlsDisabled}
            models={form.customModels}
            onChange={form.setCustomModels}
            showThinking
            showVision
          />
        </FormField>
      ) : null}

      {form.selectedProvider !== "openrouter" &&
      !isShortlistBrowseProvider(form.selectedProvider) &&
      form.selectedProvider !== "ollama" &&
      form.selectedProvider !== "openai_compatible" &&
      !form.usesGenericCustomModelEditor &&
      !isDirectDiscoveryProvider ? (
        <FormField
          density={density}
          footer={
            directlyRenderedSubscriptionIssue ? (
              <div className="flex flex-wrap items-center gap-2">
                <p
                  className="text-destructive text-sm"
                  id={subscriptionModelIssueId}
                  role="alert"
                >
                  {form.subscriptionModelError}
                </p>
                {form.subscriptionModelSelectionIssue === "load-failed" ? (
                  <Button
                    disabled={controlsDisabled}
                    onClick={form.retrySubscriptionModels}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Retry models
                  </Button>
                ) : null}
              </div>
            ) : null
          }
          id="model"
          label="Model"
        >
          <Select
            disabled={
              controlsDisabled ||
              form.subscriptionModelsFailed ||
              form.subscriptionModelsRefreshing ||
              form.filteredModels.length === 0
            }
            onValueChange={(value) =>
              form.setSelectedModel(value == null ? "" : String(value))
            }
            value={form.selectedModel}
          >
            <SelectTrigger
              aria-describedby={subscriptionModelErrorId}
              aria-invalid={subscriptionModelErrorId ? true : undefined}
              className="w-full"
              id="model"
            >
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
    </>
  );
}

export function ProviderSetupForm({
  submitLabel = "Save & continue",
  showHeading = true,
  density = "default",
  onSuccess,
}: ProviderSetupFormProps) {
  const formErrorId = useId();
  const subscriptionModelIssueId = useId();
  const testErrorId = useId();
  const form = useProviderSetupForm({ onSuccess });
  const [isBrowsing, setIsBrowsing] = useState(false);
  const apiKeyOptional = !isApiKeyRequiredForProvider(form.selectedProvider, {
    hostMode: form.ollamaHostMode,
  });
  const providerSelectionDisabled = isProviderSelectionDisabled({
    saving: form.busy,
    testingConnection: form.testingConnection,
  });
  const controlsDisabled = providerSelectionDisabled;
  const actionsDisabled = providerSetupActionsDisabled({
    busy: form.busy,
    credentialReady: apiKeyOptional || Boolean(form.apiKey.trim()),
    subscriptionBlocked: form.subscriptionSetupBlocked,
    testingConnection: form.testingConnection,
  });
  const directlyRenderedSubscriptionError =
    form.subscriptionModelSelectionIssue === "load-failed" ||
    form.subscriptionModelSelectionIssue === "no-models"
      ? form.subscriptionModelError
      : null;
  const visibleTestError =
    form.testError === directlyRenderedSubscriptionError
      ? null
      : form.testError;
  const localFormError =
    form.formError === directlyRenderedSubscriptionError
      ? null
      : form.formError;
  const visibleFormError = providerSetupVisibleFormError(
    localFormError,
    form.catalogError
  );

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
            Choose a provider, enter credentials if required, and pick a default
            model.
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
          ) : isSubscriptionProvider(form.selectedProvider) ? (
            <SubscriptionAuthPanel
              density={density}
              disabled={controlsDisabled}
              onAuthenticatedChange={form.setSubscriptionReady}
              provider={form.selectedProvider}
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

          <ProviderSetupFieldGroups
            controlsDisabled={controlsDisabled}
            density={density}
            form={form}
            formErrorId={formErrorId}
            subscriptionModelIssueId={subscriptionModelIssueId}
            testErrorId={testErrorId}
          />

          {form.testSuccess ? (
            <p
              className="font-medium text-emerald-600 text-sm dark:text-emerald-400"
              role="status"
            >
              ✓ {form.testSuccess}
            </p>
          ) : null}

          {visibleTestError ? (
            <p
              className="text-destructive text-sm"
              id={testErrorId}
              role="alert"
            >
              {visibleTestError}
            </p>
          ) : null}

          {visibleFormError ? (
            <p
              className="text-destructive text-sm"
              id={formErrorId}
              role="alert"
            >
              {visibleFormError}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button disabled={actionsDisabled} type="submit">
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
              disabled={actionsDisabled}
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
