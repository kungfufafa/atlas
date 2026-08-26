export type StandardToolErrorCode =
  | "INVALID_ARGUMENT"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "CANCELLED"
  | "RESOURCE_LIMIT"
  | "PROVIDER_ERROR"
  | "NETWORK_ERROR"
  | "SANDBOX_ERROR"
  | "INTERNAL_ERROR";

export interface ToolArtifact {
  createdAt: string;
  filename: string;
  id: string;
  mimeType: string;
  path: string;
  sessionId?: string;
  sizeBytes: number;
}

export interface ToolExecutionError {
  code: StandardToolErrorCode;
  details?: unknown;
  message: string;
  retryable: boolean;
}

export interface ToolExecutionMetadata {
  durationMs?: number;
  retries?: number;
  truncated?: boolean;
  warnings?: string[];
}

export interface ToolExecutionResult<T = unknown> {
  artifacts?: ToolArtifact[];
  data?: T;
  error?: ToolExecutionError;
  metadata?: ToolExecutionMetadata;
  success: boolean;
}

export interface RetryPolicy {
  backoffFactor?: number;
  initialDelayMs?: number;
  jitter?: boolean;
  maxDelayMs?: number;
  maxRetries?: number;
  retryableCodes?: StandardToolErrorCode[];
}

export type ToolExecutionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface ToolExecution {
  artifactIds?: string[];
  completedAt?: string | null;
  durationMs?: number;
  errorCode?: StandardToolErrorCode;
  id: string;
  inputSummary?: string;
  messageId?: string;
  outputSummary?: string;
  sessionId: string;
  startedAt: string;
  status: ToolExecutionStatus;
  toolName: string;
}

export type ToolCategory =
  | "filesystem"
  | "compute"
  | "web"
  | "media"
  | "retrieval"
  | "artifact"
  | "communication"
  | "agent"
  | "automation"
  | "control";

export type ToolRiskLevel =
  | "read"
  | "write"
  | "destructive"
  | "external-write"
  | "system"
  | "high-impact";

export interface ToolCapability {
  cancellable?: boolean;
  category: ToolCategory;
  description?: string;
  id: string;
  longRunning?: boolean;
  privileged?: boolean;
  requiresAuth?: boolean;
  requiresNetwork?: boolean;
  risk: ToolRiskLevel;
}

export interface ProviderCapabilities {
  audioInput?: boolean;
  audioOutput?: boolean;
  imageEditing?: boolean;
  imageGeneration?: boolean;
  nativeWebSearch?: boolean;
  parallelToolCalls?: boolean;
  reasoning?: boolean;
  streaming: boolean;
  toolCalling: boolean;
  vision?: boolean;
}

export interface NormalizedToolCall {
  arguments: Record<string, unknown>;
  id: string;
  name: string;
}
