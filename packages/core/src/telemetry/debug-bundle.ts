import type { ExecutionSummary } from "./execution-summary";

export interface SafeDebugBundle {
  bundleVersion: "1.0.0";
  conversationId?: string;
  cost: {
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    searchesCount: number;
    browserSeconds: number;
  };
  environment: {
    nodeEnv: string;
    platform: string;
  };
  executionId: string;
  generatedAt: string;
  orgId?: string;
  summary: {
    status: string;
    totalDurationMs: number;
    providerTurnsCount: number;
    toolCallsCount: number;
    failureCode?: string;
    failureMessage?: string;
  };
  timeline: Array<{
    offsetMs: number;
    type: string;
    label: string;
    data?: Record<string, unknown>;
  }>;
  userPerspective: Record<string, number | undefined>;
}

const SENSITIVE_KEYS = [
  "password",
  "secret",
  "token",
  "authorization",
  "cookie",
  "api_key",
  "apikey",
  "key",
  "credentials",
  "private",
];

function sanitizeObject(obj: unknown, depth = 0): unknown {
  if (depth > 5) {
    return "[Truncated]";
  }
  if (!obj || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.slice(0, 50).map((item) => sanitizeObject(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const isSensitive = SENSITIVE_KEYS.some((sk) =>
      key.toLowerCase().includes(sk)
    );
    if (isSensitive) {
      result[key] = "[REDACTED]";
    } else if (typeof val === "string" && val.length > 500) {
      result[key] = `${val.slice(0, 500)}... [truncated]`;
    } else {
      result[key] = sanitizeObject(val, depth + 1);
    }
  }
  return result;
}

export function generateSafeDebugBundle(
  summary: ExecutionSummary
): SafeDebugBundle {
  return {
    bundleVersion: "1.0.0",
    conversationId: summary.conversationId,
    cost: {
      browserSeconds: summary.cost.rawUnits.browserSeconds,
      cachedInputTokens: summary.cost.rawUnits.cachedInputTokens,
      inputTokens: summary.cost.rawUnits.inputTokens,
      outputTokens: summary.cost.rawUnits.outputTokens,
      searchesCount: summary.cost.rawUnits.searchesCount,
      totalCostUsd: summary.cost.totalCostUsd,
    },
    environment: {
      nodeEnv: process.env.NODE_ENV || "production",
      platform: process.platform,
    },
    executionId: summary.executionAttemptId,
    generatedAt: new Date().toISOString(),
    orgId: summary.orgId,
    summary: {
      failureCode: summary.failure?.code,
      failureMessage: summary.failure?.message,
      providerTurnsCount: summary.providerTurnsCount,
      status: summary.status,
      toolCallsCount: summary.toolCallsCount,
      totalDurationMs: summary.totalDurationMs,
    },
    timeline: summary.timeline.map((event) => ({
      data: event.data
        ? (sanitizeObject(event.data) as Record<string, unknown>)
        : undefined,
      label: event.label,
      offsetMs: event.offsetMs,
      type: event.type,
    })),
    userPerspective: { ...summary.userPerspective },
  };
}
