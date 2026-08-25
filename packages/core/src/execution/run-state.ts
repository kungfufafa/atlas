import type {
  ExecutionRunStatus,
  ExecutionStepStatus,
} from "../approval/resume";
import {
  assertCanonicalPrincipal,
  type CanonicalPrincipal,
} from "../identity/principal";

export interface DurableExecutionRun {
  checkpoint: ExecutionCheckpoint | null;
  createdAt: string;
  currentStepIndex: number;
  id: string;
  idempotencyKey: string | null;
  kind: "chat" | "automation" | "task" | "subagent";
  leaseExpiresAt: string | null;
  leaseOwner: string | null;
  orgId: string;
  principalUserId: string;
  sessionId: string | null;
  status: ExecutionRunStatus;
  updatedAt: string;
}

export interface DurableExecutionStep {
  approvalId: string | null;
  args: Record<string, unknown>;
  argsHash: string;
  createdAt: string;
  id: string;
  result: unknown;
  runId: string;
  status: ExecutionStepStatus;
  stepIndex: number;
  toolCallId: string | null;
  toolName: string;
  updatedAt: string;
}

export interface ExecutionCheckpoint {
  remainingToolCalls: Array<{
    arguments: Record<string, unknown>;
    id: string;
    name: string;
  }>;
  resumeStepIndex: number;
  subagent?: {
    handle: {
      budgetMs: number;
      createdAt: string;
      id: string;
      orgId: string;
      parentRunId: string | null;
      principalUserId: string;
      status: string;
      task: string;
      updatedAt: string;
    };
    result?: unknown;
  };
}

export class ExecutionLeaseError extends Error {
  readonly code = "EXECUTION_LEASE";

  constructor(message: string) {
    super(message);
    this.name = "ExecutionLeaseError";
  }
}

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_LEASE_HEARTBEAT_MS = 10_000;

export function scheduledOccurrenceId(
  automationId: string,
  occurrenceAt: Date | string
): string {
  const id = automationId.trim();
  if (!id) {
    throw new ExecutionLeaseError(
      "Scheduled occurrence id requires automationId."
    );
  }
  const raw =
    typeof occurrenceAt === "string"
      ? occurrenceAt
      : occurrenceAt.toISOString();
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new ExecutionLeaseError("Scheduled occurrence time is invalid.");
  }
  return `${id}:${at.toISOString()}`;
}

export function createQueuedRun(input: {
  id: string;
  kind: DurableExecutionRun["kind"];
  now?: string;
  orgId: string;
  principal: CanonicalPrincipal;
  sessionId?: string | null;
  idempotencyKey?: string | null;
}): DurableExecutionRun {
  const principal = assertCanonicalPrincipal(input.principal);
  if (principal.orgId !== input.orgId) {
    throw new ExecutionLeaseError("Run orgId must match the principal org.");
  }
  const now = input.now ?? new Date().toISOString();
  return {
    checkpoint: null,
    createdAt: now,
    currentStepIndex: 0,
    id: input.id,
    idempotencyKey: input.idempotencyKey ?? null,
    kind: input.kind,
    leaseExpiresAt: null,
    leaseOwner: null,
    orgId: input.orgId,
    principalUserId: principal.userId,
    sessionId: input.sessionId ?? null,
    status: "queued",
    updatedAt: now,
  };
}

export function acquireLease(
  run: DurableExecutionRun,
  owner: string,
  nowMs = Date.now(),
  leaseMs = DEFAULT_LEASE_MS
): DurableExecutionRun {
  if (!owner.trim()) {
    throw new ExecutionLeaseError("Lease owner is required.");
  }

  if (
    run.leaseOwner &&
    run.leaseExpiresAt &&
    new Date(run.leaseExpiresAt).getTime() > nowMs
  ) {
    throw new ExecutionLeaseError("Run is already leased.");
  }

  if (run.status === "completed" || run.status === "cancelled") {
    throw new ExecutionLeaseError(`Cannot lease a ${run.status} run.`);
  }

  return {
    ...run,
    leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
    leaseOwner: owner,
    status: run.status === "queued" ? "running" : run.status,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

export function heartbeatLease(
  run: DurableExecutionRun,
  owner: string,
  nowMs = Date.now(),
  leaseMs = DEFAULT_LEASE_MS
): DurableExecutionRun {
  if (!owner.trim()) {
    throw new ExecutionLeaseError("Lease owner is required.");
  }
  if (run.leaseOwner !== owner) {
    throw new ExecutionLeaseError("Stale worker cannot heartbeat this run.");
  }
  if (!run.leaseExpiresAt || new Date(run.leaseExpiresAt).getTime() <= nowMs) {
    throw new ExecutionLeaseError("Lease has expired.");
  }
  if (
    run.status === "completed" ||
    run.status === "cancelled" ||
    run.status === "failed"
  ) {
    throw new ExecutionLeaseError(`Cannot heartbeat a ${run.status} run.`);
  }

  return {
    ...run,
    leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  };
}

export function pauseForApproval(
  run: DurableExecutionRun,
  checkpoint: ExecutionCheckpoint,
  now = new Date().toISOString()
): DurableExecutionRun {
  return {
    ...run,
    checkpoint,
    currentStepIndex: checkpoint.resumeStepIndex,
    status: "awaiting_approval",
    updatedAt: now,
  };
}

export function resumeFromApproval(
  run: DurableExecutionRun,
  now = new Date().toISOString()
): DurableExecutionRun {
  if (run.status !== "awaiting_approval") {
    throw new ExecutionLeaseError("Run is not awaiting approval.");
  }
  return {
    ...run,
    status: "running",
    updatedAt: now,
  };
}

export function completeRun(
  run: DurableExecutionRun,
  status: "completed" | "failed" | "cancelled",
  now = new Date().toISOString(),
  leaseOwner?: string | null
): DurableExecutionRun {
  if (leaseOwner !== undefined && leaseOwner !== null) {
    if (run.leaseOwner !== leaseOwner) {
      throw new ExecutionLeaseError(
        "Stale worker cannot complete a stolen run."
      );
    }
    if (!isActiveExecutionStatus(run.status)) {
      throw new ExecutionLeaseError(`Cannot complete a ${run.status} run.`);
    }
  }
  return {
    ...run,
    checkpoint: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    status,
    updatedAt: now,
  };
}

export function automationFireIdempotencyKey(
  automationId: string,
  fireId: string
): string {
  const id = automationId.trim();
  const fire = fireId.trim();
  if (!(id && fire)) {
    throw new ExecutionLeaseError(
      "Automation idempotency key requires automationId and fireId."
    );
  }
  return `automation:${id}:fire:${fire}`;
}

export const ACTIVE_EXECUTION_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
] as const;

export function isActiveExecutionStatus(
  status: string
): status is (typeof ACTIVE_EXECUTION_STATUSES)[number] {
  return (ACTIVE_EXECUTION_STATUSES as readonly string[]).includes(status);
}

export function assertIdempotentReplay(
  existing: DurableExecutionRun,
  principal: CanonicalPrincipal
): DurableExecutionRun {
  if (existing.principalUserId !== principal.userId) {
    throw new ExecutionLeaseError(
      "Idempotency key is bound to a different principal."
    );
  }
  if (existing.orgId !== principal.orgId) {
    throw new ExecutionLeaseError(
      "Idempotency key is bound to a different workspace."
    );
  }
  return existing;
}
