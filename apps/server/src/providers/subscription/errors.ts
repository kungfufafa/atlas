import {
  AtlasApiError,
  type SubscriptionErrorCode,
  type SubscriptionProviderKind,
} from "@atlas/core";

export class SubscriptionRuntimeError extends Error {
  readonly code: SubscriptionErrorCode;
  readonly provider: SubscriptionProviderKind;

  constructor(
    provider: SubscriptionProviderKind,
    code: SubscriptionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SubscriptionRuntimeError";
    this.code = code;
    this.provider = provider;
  }
}

export function subscriptionRuntimeErrorStatus(
  code: SubscriptionErrorCode
): 400 | 409 | 503 {
  if (code === "provider_unavailable") {
    return 503;
  }
  if (code === "authentication_expired") {
    return 409;
  }
  return 400;
}

export function toPublicSubscriptionApiError(
  provider: SubscriptionProviderKind,
  error: unknown
): AtlasApiError {
  if (error instanceof SubscriptionRuntimeError) {
    return new AtlasApiError(
      publicSubscriptionErrorMessage(provider, error.code),
      subscriptionRuntimeErrorStatus(error.code)
    );
  }

  const status = error instanceof AtlasApiError ? error.status : 500;
  return new AtlasApiError(
    publicSubscriptionStatusMessage(provider, status),
    status
  );
}

export function publicSubscriptionErrorMessage(
  provider: SubscriptionProviderKind,
  code: SubscriptionErrorCode
): string {
  const label = subscriptionProviderLabel(provider);
  if (code === "authentication_expired") {
    return `${label} is not connected on this Atlas host. Ask a Superadmin to reconnect it.`;
  }
  if (code === "provider_unavailable") {
    return `${label} runtime is not available on this Atlas host. Ask a Superadmin to check it.`;
  }
  if (code === "rate_limited") {
    return `${label} is rate limited. Retry later.`;
  }
  if (code === "subscription_limit_reached") {
    return `${label} subscription limit reached.`;
  }
  if (code === "model_unavailable") {
    return `${label} subscription model is not available on this Atlas host.`;
  }
  return `${label} subscription request failed. Ask a Superadmin to check the host runtime.`;
}

export function classifySubscriptionError(
  message: string
): SubscriptionErrorCode {
  const normalized = message.toLowerCase();

  if (
    /\b429\b/.test(normalized) ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("slow down")
  ) {
    return "rate_limited";
  }

  if (
    normalized.includes("quota") ||
    normalized.includes("usage limit") ||
    normalized.includes("limit reached") ||
    normalized.includes("out of credits") ||
    normalized.includes("plan limit") ||
    normalized.includes("billing hard limit")
  ) {
    return "subscription_limit_reached";
  }

  if (
    normalized.includes("unauthenticated") ||
    normalized.includes("not authenticated") ||
    normalized.includes("authentication expired") ||
    normalized.includes("auth expired") ||
    normalized.includes("login required") ||
    normalized.includes("unauthorized") ||
    /\b401\b/.test(normalized)
  ) {
    return "authentication_expired";
  }

  if (
    normalized.includes("model not found") ||
    normalized.includes("unknown model") ||
    normalized.includes("model is not available") ||
    normalized.includes("model unavailable") ||
    normalized.includes("does not have access to model")
  ) {
    return "model_unavailable";
  }

  if (
    normalized.includes("not installed") ||
    normalized.includes("enoent") ||
    normalized.includes("not found") ||
    normalized.includes("not available")
  ) {
    return "provider_unavailable";
  }

  return "runtime_error";
}

export function throwSubscriptionError(
  provider: SubscriptionProviderKind,
  message: string,
  code?: SubscriptionErrorCode
): never {
  const resolved = code ?? classifySubscriptionError(message);
  throw new SubscriptionRuntimeError(
    provider,
    resolved,
    subscriptionErrorMessage(provider, resolved, message)
  );
}

export function subscriptionErrorMessage(
  provider: SubscriptionProviderKind,
  code: SubscriptionErrorCode,
  fallback: string
): string {
  const label = subscriptionProviderLabel(provider);
  if (code === "subscription_limit_reached") {
    return `${label} subscription limit reached. Atlas will not fall back to an API key.`;
  }
  if (code === "rate_limited") {
    return `${label} is rate limited. Retry later.`;
  }
  if (code === "authentication_expired") {
    return `${label} authentication expired. Reconnect the subscription and try again.`;
  }
  if (code === "model_unavailable") {
    return fallback.trim() || `The selected ${label} model is unavailable.`;
  }
  if (code === "provider_unavailable") {
    return fallback.trim() || `${label} runtime is not available.`;
  }
  return fallback.trim() || `${label} runtime error.`;
}

function publicSubscriptionStatusMessage(
  provider: SubscriptionProviderKind,
  status: number
): string {
  const label = subscriptionProviderLabel(provider);
  if (status === 409) {
    return `${label} is not connected on this Atlas host. Ask a Superadmin to reconnect it.`;
  }
  if (status === 503) {
    return `${label} runtime is not available on this Atlas host. Ask a Superadmin to check it.`;
  }
  if (status === 400) {
    return `${label} subscription request could not be validated. Ask a Superadmin to check the host subscription.`;
  }
  return `${label} subscription request failed. Ask a Superadmin to check the host runtime.`;
}

function subscriptionProviderLabel(
  provider: SubscriptionProviderKind
): "ChatGPT" | "Claude" {
  return provider === "chatgpt" ? "ChatGPT" : "Claude";
}
