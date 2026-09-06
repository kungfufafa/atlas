import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { inferArtifactMimeType } from "../artifact-mime";
import type { ToolContext, ToolDefinition } from "../contract";
import { isChannelGuestUserId } from "../identity/principal";
import { nanoid } from "../ids";
import type {
  RetryPolicy,
  StandardToolErrorCode,
  ToolArtifact,
  ToolExecutionError,
  ToolExecutionMetadata,
  ToolExecutionResult,
} from "./execution-contract";
import { DEFAULT_TOOL_CAPABILITIES } from "./permissions";
import { serializeToolOutput } from "./result-serialization";
import { validateToolArguments } from "./schema";

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

export type { RetryPolicy } from "./execution-contract";

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

const STANDARD_TOOL_ERROR_CODES = new Set<StandardToolErrorCode>([
  "INVALID_ARGUMENT",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "TIMEOUT",
  "CANCELLED",
  "RESOURCE_LIMIT",
  "PROVIDER_ERROR",
  "NETWORK_ERROR",
  "SANDBOX_ERROR",
  "INTERNAL_ERROR",
]);

function isStandardToolErrorCode(
  value: unknown
): value is StandardToolErrorCode {
  return (
    typeof value === "string" &&
    STANDARD_TOOL_ERROR_CODES.has(value as StandardToolErrorCode)
  );
}

function readErrorProperty(error: object, key: string): unknown {
  try {
    return Reflect.get(error, key);
  } catch {
    // Hostile proxies must degrade to an absent field.
  }
}

function stringifyUnknownError(error: unknown): string {
  try {
    return String(error);
  } catch {
    return "Unknown tool execution error.";
  }
}

export function standardizeToolError(
  error: unknown,
  fallbackCode: StandardToolErrorCode = "INTERNAL_ERROR"
): ToolExecutionError {
  let errorMessage: unknown;
  let errorName: unknown;

  if (typeof error === "object" && error !== null) {
    const code = readErrorProperty(error, "code");
    errorMessage = readErrorProperty(error, "message");
    errorName = readErrorProperty(error, "name");

    if (isStandardToolErrorCode(code) && typeof errorMessage === "string") {
      const retryable = readErrorProperty(error, "retryable");
      return {
        code,
        details: readErrorProperty(error, "details"),
        message: errorMessage,
        retryable:
          typeof retryable === "boolean"
            ? retryable
            : isRetryableErrorCode(code),
      };
    }
  }

  const rawMessage =
    typeof errorMessage === "string"
      ? errorMessage
      : stringifyUnknownError(error);
  const normalizedErrorName = typeof errorName === "string" ? errorName : "";

  if (
    normalizedErrorName === "AbortError" ||
    /aborted|cancelled/i.test(rawMessage)
  ) {
    return {
      code: "CANCELLED",
      message: "The tool execution was cancelled.",
      retryable: false,
    };
  }

  if (
    normalizedErrorName === "TimeoutError" ||
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

function executionAbortReason(
  signal: AbortSignal,
  fallbackMessage: string
): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(fallbackMessage);
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
      throw executionAbortReason(
        signal,
        "Execution was aborted before attempt."
      );
    }

    try {
      const result = await action(attempt);
      return { result, retries: attempt };
    } catch (err) {
      lastError = err;

      if (signal?.aborted) {
        throw executionAbortReason(
          signal,
          "Execution was aborted before retry backoff."
        );
      }

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
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          if (timer) {
            clearTimeout(timer);
          }
          reject(
            signal
              ? executionAbortReason(
                  signal,
                  "Execution aborted during retry backoff."
                )
              : new Error("Execution aborted during retry backoff.")
          );
        };

        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }

        timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
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

    if (isChannelGuestUserId(context.userId)) {
      const error = new Error(
        `Channel guest principals cannot execute tool "${tool.name}".`
      );
      (error as { code?: string }).code = "PERMISSION_DENIED";
      throw error;
    }

    validateToolArguments(tool.parameters, input);

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

    // 3. Execution with Retry. Production tools retry only when their loader
    // explicitly attaches a policy (currently opt-in custom JavaScript tools).
    // Known writes and risk-engine mutations remain single-attempt even if a
    // policy is attached accidentally.
    const requestedRetryPolicy = options.retryPolicy ?? tool.retryPolicy;
    const knownCapability = DEFAULT_TOOL_CAPABILITIES[tool.name];
    const isKnownMutation =
      knownCapability !== undefined && knownCapability.risk !== "read";
    const canRetry =
      requestedRetryPolicy !== undefined &&
      !isKnownMutation &&
      risk.riskLevel === "LOW" &&
      !risk.consequence.irreversible;
    const effectiveRetryPolicy: RetryPolicy = canRetry
      ? {
          ...requestedRetryPolicy,
          maxRetries: Math.max(
            0,
            Math.min(
              requestedRetryPolicy.maxRetries ?? DEFAULT_MAX_RETRIES,
              DEFAULT_MAX_RETRIES
            )
          ),
        }
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

    const serialized = serializeToolOutput(result);
    warnings.push(...serialized.warnings);
    let finalData = serialized.data as Output;
    const declaredArtifacts: ToolArtifact[] = [];

    // Extract artifacts if tool returned standard artifact references
    if (typeof finalData === "object" && finalData !== null) {
      const record = finalData as Record<string, unknown>;
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
    const stringified = serialized.text;
    if (stringified && stringified.length > maxOutputChars) {
      if (typeof result === "string") {
        metadata.truncated = true;
        warnings.push(
          `Output exceeded ${maxOutputChars} characters and was truncated.`
        );
        finalData =
          `${stringified.slice(0, maxOutputChars)}\n\n[... truncated ${stringified.length - maxOutputChars} characters]` as Output;
      } else {
        metadata.truncated = false;
        warnings.push(
          `Structured output exceeded ${maxOutputChars} characters and was retained intact.`
        );
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
