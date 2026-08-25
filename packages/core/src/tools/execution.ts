import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { inferArtifactMimeType } from "../artifact-mime";
import type { ToolContext, ToolDefinition } from "../contract";
import { nanoid } from "../ids";
import type {
  StandardToolErrorCode,
  ToolArtifact,
  ToolExecutionError,
  ToolExecutionMetadata,
  ToolExecutionResult,
} from "./execution-contract";

export const DEFAULT_MAX_OUTPUT_CHARS = 32_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_INITIAL_BACKOFF_MS = 250;

const ARTIFACTS_DIRECTORY = "artifacts";
const INTERNAL_ARTIFACT_PREFIXES = ["coding-agent-runs/"];

interface ArtifactFileSnapshot {
  mtimeMs: number;
  sizeBytes: number;
}

function isArtifactMetadataPath(relativePath: string): boolean {
  return (
    relativePath.endsWith(".atlas-meta.json") ||
    relativePath.endsWith(".meta.json") ||
    relativePath.includes(".atlas-meta")
  );
}

function isDeliverableArtifactPath(relativePath: string): boolean {
  return !(
    isArtifactMetadataPath(relativePath) ||
    INTERNAL_ARTIFACT_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  );
}

async function scanArtifactFiles(
  workspaceRoot: string | undefined
): Promise<Map<string, ArtifactFileSnapshot>> {
  const files = new Map<string, ArtifactFileSnapshot>();
  if (!workspaceRoot) {
    return files;
  }

  const artifactsRoot = path.join(workspaceRoot, ARTIFACTS_DIRECTORY);

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const relativePath = path
        .relative(artifactsRoot, absolutePath)
        .split(path.sep)
        .join("/");
      if (!isDeliverableArtifactPath(relativePath)) {
        continue;
      }

      try {
        const fileStat = await stat(absolutePath);
        files.set(relativePath, {
          mtimeMs: fileStat.mtimeMs,
          sizeBytes: fileStat.size,
        });
      } catch {
        // The file may have been transient or removed while the tool was running.
      }
    }
  };

  await walk(artifactsRoot);
  return files;
}

function changedArtifactFiles(
  before: Map<string, ArtifactFileSnapshot>,
  after: Map<string, ArtifactFileSnapshot>,
  context: ToolContext
): ToolArtifact[] {
  const artifacts: ToolArtifact[] = [];

  for (const [relativePath, file] of after) {
    const previous = before.get(relativePath);
    if (
      previous &&
      previous.mtimeMs === file.mtimeMs &&
      previous.sizeBytes === file.sizeBytes
    ) {
      continue;
    }

    artifacts.push({
      createdAt: new Date().toISOString(),
      filename: path.basename(relativePath),
      id: nanoid(12),
      mimeType: inferArtifactMimeType(relativePath),
      path: `${ARTIFACTS_DIRECTORY}/${relativePath}`,
      sessionId: context.sessionId,
      sizeBytes: file.sizeBytes,
    });
  }

  return artifacts;
}

function mergeToolArtifacts(
  declared: ToolArtifact[],
  detected: ToolArtifact[]
): ToolArtifact[] {
  const artifactsByPath = new Map<string, ToolArtifact>();

  for (const artifact of [...declared, ...detected]) {
    if (!artifactsByPath.has(artifact.path)) {
      artifactsByPath.set(artifact.path, artifact);
    }
  }

  return [...artifactsByPath.values()];
}

export interface RetryPolicy {
  backoffFactor?: number;
  initialDelayMs?: number;
  jitter?: boolean;
  maxDelayMs?: number;
  maxRetries?: number;
  retryableCodes?: StandardToolErrorCode[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  backoffFactor: 2,
  initialDelayMs: DEFAULT_INITIAL_BACKOFF_MS,
  jitter: true,
  maxDelayMs: 3000,
  maxRetries: DEFAULT_MAX_RETRIES,
  retryableCodes: ["NETWORK_ERROR", "PROVIDER_ERROR"],
};

export function isRetryableErrorCode(code: StandardToolErrorCode): boolean {
  return code === "NETWORK_ERROR" || code === "PROVIDER_ERROR";
}

export function standardizeToolError(
  error: unknown,
  fallbackCode: StandardToolErrorCode = "INTERNAL_ERROR"
): ToolExecutionError {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.message === "string") {
      const code = record.code as StandardToolErrorCode;
      return {
        code,
        details: record.details,
        message: record.message,
        retryable:
          typeof record.retryable === "boolean"
            ? record.retryable
            : isRetryableErrorCode(code),
      };
    }
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : "";

  if (errorName === "AbortError" || /aborted|cancelled/i.test(rawMessage)) {
    return {
      code: "CANCELLED",
      message: "The tool execution was cancelled.",
      retryable: false,
    };
  }

  if (
    errorName === "TimeoutError" ||
    /timed?\s*out|deadline exceeded/i.test(rawMessage)
  ) {
    return {
      code: "TIMEOUT",
      message: rawMessage,
      retryable: false,
    };
  }

  if (/ENOENT|no such file|not found/i.test(rawMessage)) {
    return {
      code: "NOT_FOUND",
      message: rawMessage,
      retryable: false,
    };
  }

  if (/EACCES|permission denied|forbidden/i.test(rawMessage)) {
    return {
      code: "PERMISSION_DENIED",
      message: rawMessage,
      retryable: false,
    };
  }

  if (
    /invalid argument|validation failed|expected.*received|zod/i.test(
      rawMessage
    )
  ) {
    return {
      code: "INVALID_ARGUMENT",
      message: rawMessage,
      retryable: false,
    };
  }

  if (
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|network|ERR_HTTP2|PROTOCOL_ERROR/i.test(
      rawMessage
    )
  ) {
    return {
      code: "NETWORK_ERROR",
      message: rawMessage,
      retryable: true,
    };
  }

  if (
    /429|rate limit|too many requests|503|service unavailable/i.test(rawMessage)
  ) {
    return {
      code: "PROVIDER_ERROR",
      message: rawMessage,
      retryable: true,
    };
  }

  if (/sandbox error|process exited with code/i.test(rawMessage)) {
    return {
      code: "SANDBOX_ERROR",
      message: rawMessage,
      retryable: false,
    };
  }

  return {
    code: fallbackCode,
    message: rawMessage,
    retryable: isRetryableErrorCode(fallbackCode),
  };
}

export function formatUserSafeErrorMessage(error: ToolExecutionError): string {
  switch (error.code) {
    case "CANCELLED":
      return "The operation was stopped by the user.";
    case "TIMEOUT":
      return "The operation exceeded its time limit.";
    case "NOT_FOUND":
      return `File or resource not found: ${error.message}`;
    case "PERMISSION_DENIED":
      return "Access to this resource was denied.";
    case "INVALID_ARGUMENT":
      return `Invalid parameters: ${error.message}`;
    case "RESOURCE_LIMIT":
      return "The operation exceeded resource limits.";
    case "NETWORK_ERROR":
      return "A network communication error occurred.";
    case "PROVIDER_ERROR":
      return "The upstream service is temporarily unavailable. Please try again.";
    case "SANDBOX_ERROR":
      return `Execution error in sandbox: ${error.message}`;
    default:
      return error.message || "An unexpected error occurred.";
  }
}

export async function executeWithRetry<T>(
  action: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  signal?: AbortSignal
): Promise<{ result: T; retries: number }> {
  const maxRetries = policy.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialDelay = policy.initialDelayMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const factor = policy.backoffFactor ?? 2;
  const maxDelay = policy.maxDelayMs ?? 3000;
  const retryableCodes = policy.retryableCodes ?? [
    "NETWORK_ERROR",
    "PROVIDER_ERROR",
  ];

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) {
      throw new Error("Execution was aborted before attempt.");
    }

    try {
      const result = await action(attempt);
      return { result, retries: attempt };
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries) {
        break;
      }

      const standardError = standardizeToolError(err);
      if (
        !(
          standardError.retryable || retryableCodes.includes(standardError.code)
        )
      ) {
        break;
      }

      let delay = Math.min(initialDelay * factor ** attempt, maxDelay);
      if (policy.jitter) {
        delay += Math.random() * 0.25 * delay;
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (signal?.removeEventListener) {
            signal.removeEventListener("abort", onAbort);
          }
          resolve();
        }, delay);

        function onAbort() {
          clearTimeout(timer);
          reject(new Error("Execution aborted during retry backoff."));
        }

        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  throw lastError;
}

export interface ProtectedExecutionOptions {
  maxOutputChars?: number;
  retryPolicy?: RetryPolicy;
  timeoutMs?: number;
}

export async function executeProtectedTool<Input = unknown, Output = unknown>(
  tool: ToolDefinition<Input, Output>,
  input: Input,
  context: ToolContext,
  options: ProtectedExecutionOptions = {}
): Promise<ToolExecutionResult<Output>> {
  const startTime = Date.now();
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const metadata: ToolExecutionMetadata = {};
  const warnings: string[] = [];

  try {
    context.signal?.throwIfAborted();

    // 1. Server-side Action Risk Evaluation
    const { evaluateActionRisk, computeActionHash } = await import(
      "../risk-engine"
    );
    const { globalApprovalGrantStore } = await import("../approval-grant");

    const risk = evaluateActionRisk(
      tool.name,
      typeof input === "object" && input !== null
        ? (input as Record<string, unknown>)
        : {}
    );

    // 2. Server Approval Enforcement Boundary
    if (risk.requiresApproval) {
      const grantId = context.approvalGrantId;
      const actionHash = computeActionHash({
        args:
          typeof input === "object" && input !== null
            ? (input as Record<string, unknown>)
            : {},
        tool: tool.name,
      });

      const orgId = context.orgId?.trim();
      const userId = context.userId?.trim();
      if (!(orgId && userId)) {
        const err = new Error(
          "APPROVAL_DENIED: Canonical principal is required for approval-gated tools."
        );
        (err as { code?: string }).code = "PERMISSION_DENIED";
        throw err;
      }

      if (!grantId) {
        const err = new Error(
          `APPROVAL_REQUIRED: Action "${tool.name}" requires user approval before execution. (${risk.consequence.title})`
        );
        (err as { code?: string }).code = "PERMISSION_DENIED";
        throw err;
      }

      const grantVerification = globalApprovalGrantStore.verifyAndConsume(
        grantId,
        {
          actionHash,
          orgId,
          userId,
        }
      );

      if (!grantVerification.valid) {
        const err = new Error(
          `APPROVAL_DENIED: ${grantVerification.error || "Invalid or unverified approval grant."}`
        );
        (err as { code?: string }).code = "PERMISSION_DENIED";
        throw err;
      }
    }

    // 3. Execution with Retry (strictly disable automatic retry on mutating/destructive/purchase actions)
    const effectiveRetryPolicy: RetryPolicy =
      risk.riskLevel === "LOW" && !risk.consequence.irreversible
        ? (options.retryPolicy ?? DEFAULT_RETRY_POLICY)
        : { maxRetries: 0 };

    const shouldDetectArtifacts = tool.parallelSafe !== true;
    const artifactsBefore = shouldDetectArtifacts
      ? await scanArtifactFiles(context.workspaceRoot)
      : new Map<string, ArtifactFileSnapshot>();

    const { result, retries } = await executeWithRetry(
      async () => await tool.run(input, context),
      effectiveRetryPolicy,
      context.signal
    );

    const durationMs = Date.now() - startTime;
    metadata.durationMs = durationMs;
    metadata.retries = retries;

    let finalData = result;
    const declaredArtifacts: ToolArtifact[] = [];

    // Extract artifacts if tool returned standard artifact references
    if (typeof result === "object" && result !== null) {
      const record = result as Record<string, unknown>;
      if (Array.isArray(record.artifacts)) {
        for (const item of record.artifacts) {
          if (
            typeof item === "object" &&
            item !== null &&
            typeof item.path === "string"
          ) {
            declaredArtifacts.push(item as ToolArtifact);
          }
        }
      }
    }

    const artifactsAfter = shouldDetectArtifacts
      ? await scanArtifactFiles(context.workspaceRoot)
      : artifactsBefore;
    const detectedArtifacts = changedArtifactFiles(
      artifactsBefore,
      artifactsAfter,
      context
    );
    const artifacts = mergeToolArtifacts(declaredArtifacts, detectedArtifacts);

    // Check output size and apply safe truncation if exceeded
    const stringified =
      typeof result === "string" ? result : JSON.stringify(result);
    if (stringified && stringified.length > maxOutputChars) {
      metadata.truncated = true;
      warnings.push(
        `Output exceeded ${maxOutputChars} characters and was truncated.`
      );
      if (typeof result === "string") {
        finalData =
          `${stringified.slice(0, maxOutputChars)}\n\n[... truncated ${stringified.length - maxOutputChars} characters]` as Output;
      }
    }

    if (warnings.length > 0) {
      metadata.warnings = warnings;
    }

    return {
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      data: finalData,
      metadata,
      success: true,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    metadata.durationMs = durationMs;
    const standardError = standardizeToolError(error);

    return {
      error: standardError,
      metadata,
      success: false,
    };
  }
}
