import type {
  ProviderInstanceSummary,
  TestProviderRequest,
  UpdateProviderRequest,
} from "@atlas/core/contract";
import {
  getBuiltinProviderDefinition,
  isSubscriptionProvider,
  providerApiKeyIsRequired,
} from "@atlas/core/provider-catalog";

export interface ProviderEditDraft {
  apiKey: string;
  baseUrl: string;
  label: string;
}

export const PROVIDER_BASE_URL_KEY_ERROR =
  "Re-enter the API key when changing a provider base URL.";

export function normalizeProviderBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function baseUrlError(
  provider: ProviderInstanceSummary,
  baseUrl: string
): string | null {
  const trimmed = baseUrl.trim();
  const definition = getBuiltinProviderDefinition(provider.type);
  const required =
    Boolean(provider.baseUrl?.trim()) ||
    Boolean(
      definition?.setup?.baseUrlRequired || definition?.setup?.baseUrlInput
    );

  if (!trimmed) {
    return required ? "Base URL is required." : null;
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

export function validateProviderEdit(
  provider: ProviderInstanceSummary,
  draft: ProviderEditDraft
): string | null {
  if (!draft.label.trim()) {
    return "Provider label is required.";
  }

  const nextBaseUrlError = baseUrlError(provider, draft.baseUrl);
  if (nextBaseUrlError) {
    return nextBaseUrlError;
  }

  const nextBaseUrl = normalizeProviderBaseUrl(draft.baseUrl);
  const storedBaseUrl = normalizeProviderBaseUrl(provider.baseUrl ?? "");
  if (
    nextBaseUrl !== storedBaseUrl &&
    provider.hasApiKey &&
    !draft.apiKey.trim()
  ) {
    return PROVIDER_BASE_URL_KEY_ERROR;
  }

  return null;
}

export function buildProviderUpdateRequest(
  provider: ProviderInstanceSummary,
  draft: ProviderEditDraft
): UpdateProviderRequest {
  const apiKey = draft.apiKey.trim();
  const baseUrl = normalizeProviderBaseUrl(draft.baseUrl);
  const hadBaseUrl = Boolean(provider.baseUrl?.trim());

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl || hadBaseUrl ? { baseUrl } : {}),
    label: draft.label.trim(),
  };
}

function connectionTestNeedsApiKey(provider: ProviderInstanceSummary): boolean {
  if (provider.hasApiKey) {
    return true;
  }

  const definition = getBuiltinProviderDefinition(provider.type);
  return definition
    ? providerApiKeyIsRequired(definition.apiKey, {
        hostMode: provider.hostMode ?? undefined,
      })
    : false;
}

export function validateProviderConnectionTest(
  provider: ProviderInstanceSummary,
  draft: ProviderEditDraft
): string | null {
  if (isSubscriptionProvider(provider.type)) {
    return "Connection status is managed by subscription sign-in.";
  }

  const nextBaseUrlError = baseUrlError(provider, draft.baseUrl);
  if (nextBaseUrlError) {
    return nextBaseUrlError;
  }

  if (connectionTestNeedsApiKey(provider) && !draft.apiKey.trim()) {
    return "Enter the API key to test this connection.";
  }

  return null;
}

export function buildProviderTestRequest(
  provider: ProviderInstanceSummary,
  draft: ProviderEditDraft
): TestProviderRequest | null {
  if (isSubscriptionProvider(provider.type)) {
    return null;
  }

  const apiKey = draft.apiKey.trim();
  const baseUrl = normalizeProviderBaseUrl(draft.baseUrl);

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(provider.customModels?.length
      ? { customModels: provider.customModels }
      : {}),
    ...(provider.hostMode ? { hostMode: provider.hostMode } : {}),
    type: provider.type,
    ...(provider.wireApi ? { wireApi: provider.wireApi } : {}),
  };
}
