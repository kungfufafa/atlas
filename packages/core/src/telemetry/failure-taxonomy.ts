export type FailureCode =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_AUTH_ERROR"
  | "PROVIDER_PROTOCOL_ERROR"
  | "PROVIDER_5XX"
  | "TOOL_TIMEOUT"
  | "TOOL_INVALID_RESPONSE"
  | "TOOL_PERMISSION_DENIED"
  | "TOOL_EXECUTION_ERROR"
  | "BROWSER_NAVIGATION_FAILED"
  | "BROWSER_SESSION_CRASHED"
  | "RESEARCH_SOURCE_FAILED"
  | "ARTIFACT_GENERATION_FAILED"
  | "PREVIEW_GENERATION_FAILED"
  | "OFFICE_CONVERSION_FAILED"
  | "QUEUE_OVERLOADED"
  | "EXECUTION_BUDGET_EXCEEDED"
  | "WORKER_CRASHED"
  | "CANCELLED"
  | "DATABASE_ERROR"
  | "UNKNOWN_ERROR";

export interface NormalizedFailure {
  code: FailureCode;
  details?: Record<string, unknown>;
  message: string;
  retryAfterMs?: number;
  retryable: boolean;
}

export function classifyFailure(error: unknown): NormalizedFailure {
  if (!error) {
    return {
      code: "UNKNOWN_ERROR",
      message: "An unknown error occurred.",
      retryable: false,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // Cancelled
  if (
    lower.includes("cancel") ||
    lower.includes("abort") ||
    lower.includes("turn cancelled")
  ) {
    return { code: "CANCELLED", message, retryable: false };
  }

  // Budget exceeded
  if (
    lower.includes("budget exceeded") ||
    lower.includes("limit reached") ||
    lower.includes("max tool iterations") ||
    lower.includes("loop guard")
  ) {
    return { code: "EXECUTION_BUDGET_EXCEEDED", message, retryable: false };
  }

  // Rate limits / 429
  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("quota exceeded")
  ) {
    return {
      code: "PROVIDER_RATE_LIMIT",
      message,
      retryAfterMs: 2000,
      retryable: true,
    };
  }

  // Timeouts
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("etimedout")
  ) {
    if (lower.includes("tool") || lower.includes("bash")) {
      return { code: "TOOL_TIMEOUT", message, retryable: true };
    }
    return { code: "PROVIDER_TIMEOUT", message, retryable: true };
  }

  // Provider 5xx
  if (
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("bad gateway") ||
    lower.includes("service unavailable") ||
    lower.includes("gateway timeout") ||
    lower.includes("internal server error")
  ) {
    return { code: "PROVIDER_5XX", message, retryable: true };
  }

  // Auth
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("forbidden")
  ) {
    return { code: "PROVIDER_AUTH_ERROR", message, retryable: false };
  }

  // Browser failures
  if (
    lower.includes("browser") ||
    lower.includes("playwright") ||
    lower.includes("chromium")
  ) {
    if (lower.includes("navigat") || lower.includes("load")) {
      return { code: "BROWSER_NAVIGATION_FAILED", message, retryable: true };
    }
    return { code: "BROWSER_SESSION_CRASHED", message, retryable: true };
  }

  // Office / Preview failures
  if (lower.includes("office") || lower.includes("libreoffice")) {
    return { code: "OFFICE_CONVERSION_FAILED", message, retryable: true };
  }
  if (lower.includes("preview")) {
    return { code: "PREVIEW_GENERATION_FAILED", message, retryable: true };
  }
  if (lower.includes("artifact")) {
    return { code: "ARTIFACT_GENERATION_FAILED", message, retryable: false };
  }

  // Queue overload / backpressure
  if (
    lower.includes("queue full") ||
    lower.includes("system_busy") ||
    lower.includes("overloaded")
  ) {
    return { code: "QUEUE_OVERLOADED", message, retryable: true };
  }

  // Database
  if (
    lower.includes("sqlite") ||
    lower.includes("database") ||
    lower.includes("sql")
  ) {
    return { code: "DATABASE_ERROR", message, retryable: true };
  }

  return {
    code: "UNKNOWN_ERROR",
    message,
    retryable: false,
  };
}
