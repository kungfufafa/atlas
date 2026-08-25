import { computeActionHash } from "../risk-engine";

export type ApprovalDecisionStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired";

export type ExecutionRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type ExecutionStepStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "denied"
  | "skipped";

export interface ApprovalResumeStep {
  args: Record<string, unknown>;
  runId: string;
  stepIndex: number;
  toolCallId: string;
  toolName: string;
}

export interface ActionApprovalRecord {
  actionHash: string;
  args: Record<string, unknown>;
  createdAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  expiresAt: string;
  grantId: string | null;
  id: string;
  orgId: string;
  principalUserId: string;
  runId: string;
  sessionId: string | null;
  status: ApprovalDecisionStatus;
  stepId: string;
  toolName: string;
}

export class AwaitingApprovalError extends Error {
  readonly code = "AWAITING_APPROVAL";

  constructor(
    public readonly approvalId: string,
    public readonly step: ApprovalResumeStep
  ) {
    super("AWAITING_APPROVAL");
    this.name = "AwaitingApprovalError";
  }
}

export class ApprovalResumeError extends Error {
  readonly code = "APPROVAL_RESUME_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ApprovalResumeError";
  }
}

export function hashApprovalArgs(
  toolName: string,
  args: Record<string, unknown>
): string {
  return computeActionHash({ args, tool: toolName });
}

export function assertApprovalPending(
  record: ActionApprovalRecord,
  nowMs = Date.now()
): void {
  if (record.status !== "pending") {
    throw new ApprovalResumeError(
      `Approval ${record.id} is ${record.status}, not pending.`
    );
  }
  if (new Date(record.expiresAt).getTime() < nowMs) {
    throw new ApprovalResumeError(`Approval ${record.id} has expired.`);
  }
}

export function applyApprovalDecision(
  record: ActionApprovalRecord,
  decision: "approved" | "denied",
  actorUserId: string,
  now = new Date().toISOString()
): ActionApprovalRecord {
  assertApprovalPending(record);
  if (actorUserId !== record.principalUserId) {
    throw new ApprovalResumeError(
      "Only the canonical principal can decide this approval."
    );
  }

  return {
    ...record,
    decidedAt: now,
    decidedByUserId: actorUserId,
    status: decision === "approved" ? "approved" : "denied",
  };
}

export function assertExactStepResume(
  record: ActionApprovalRecord,
  step: ApprovalResumeStep
): void {
  if (record.runId !== step.runId) {
    throw new ApprovalResumeError("Approval does not belong to this run.");
  }
  if (record.toolName !== step.toolName) {
    throw new ApprovalResumeError("Approval tool does not match resume step.");
  }
  const resumeHash = hashApprovalArgs(step.toolName, step.args);
  if (resumeHash !== record.actionHash) {
    throw new ApprovalResumeError(
      "Resume args do not match the approved action hash."
    );
  }
}

export function nextRunStatusAfterApproval(decision: "approved" | "denied"): {
  run: ExecutionRunStatus;
  step: ExecutionStepStatus;
} {
  if (decision === "approved") {
    return { run: "running", step: "running" };
  }
  return { run: "running", step: "denied" };
}
