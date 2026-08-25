import {
  assertCanonicalPrincipal,
  type CanonicalPrincipal,
} from "../identity/principal";

export type SubagentRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface SubagentHandle {
  budgetMs: number;
  createdAt: string;
  id: string;
  orgId: string;
  parentRunId: string | null;
  principalUserId: string;
  status: SubagentRunStatus;
  task: string;
  updatedAt: string;
}

export class SubagentLifecycleError extends Error {
  readonly code = "SUBAGENT_LIFECYCLE";

  constructor(message: string) {
    super(message);
    this.name = "SubagentLifecycleError";
  }
}

export function startSubagent(input: {
  budgetMs: number;
  id: string;
  parentRunId?: string | null;
  principal: CanonicalPrincipal;
  task: string;
  now?: string;
}): SubagentHandle {
  const principal = assertCanonicalPrincipal(input.principal);
  if (!input.task.trim()) {
    throw new SubagentLifecycleError("Subagent task is required.");
  }
  if (input.budgetMs <= 0) {
    throw new SubagentLifecycleError("Subagent budgetMs must be positive.");
  }
  const now = input.now ?? new Date().toISOString();
  return {
    budgetMs: input.budgetMs,
    createdAt: now,
    id: input.id,
    orgId: principal.orgId,
    parentRunId: input.parentRunId ?? null,
    principalUserId: principal.userId,
    status: "queued",
    task: input.task.trim(),
    updatedAt: now,
  };
}

export function markSubagentRunning(
  handle: SubagentHandle,
  now = new Date().toISOString()
): SubagentHandle {
  if (handle.status === "cancelled") {
    return handle;
  }
  if (handle.status === "succeeded" || handle.status === "failed") {
    throw new SubagentLifecycleError(
      `Cannot start a ${handle.status} subagent.`
    );
  }
  return {
    ...handle,
    status: "running",
    updatedAt: now,
  };
}

export function completeSubagent(
  handle: SubagentHandle,
  status: "succeeded" | "failed",
  now = new Date().toISOString()
): SubagentHandle {
  if (handle.status === "cancelled") {
    return handle;
  }
  return {
    ...handle,
    status,
    updatedAt: now,
  };
}

export function pollSubagent(
  handle: SubagentHandle,
  nowMs: number,
  startedAtMs: number
): SubagentHandle {
  if (handle.status === "cancelled") {
    return handle;
  }
  if (nowMs - startedAtMs > handle.budgetMs && handle.status === "running") {
    return {
      ...handle,
      status: "cancelled",
      updatedAt: new Date(nowMs).toISOString(),
    };
  }
  return handle;
}

export function cancelSubagent(handle: SubagentHandle): SubagentHandle {
  if (handle.status === "succeeded" || handle.status === "failed") {
    throw new SubagentLifecycleError(
      `Cannot cancel a ${handle.status} subagent.`
    );
  }
  return {
    ...handle,
    status: "cancelled",
    updatedAt: new Date().toISOString(),
  };
}
