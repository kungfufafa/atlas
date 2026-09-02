import {
  AtlasApiError,
  acquireLease,
  applyApprovalDecision,
  assertExactStepResume,
  assertIdempotentReplay,
  automationFireIdempotencyKey,
  type CanonicalPrincipal,
  completeRun,
  createQueuedRun,
  type DurableExecutionRun,
  type ExecutionCheckpoint,
  ExecutionLeaseError,
  globalApprovalGrantStore,
  hashApprovalArgs,
  heartbeatLease,
  isActiveExecutionStatus,
  nanoid,
  nextRunStatusAfterApproval,
  pauseForApproval,
  resumeFromApproval,
} from "@atlas/core";
import type { DatabaseAdapter, StoredExecutionRunRecord } from "@atlas/db";

const WORKER_ID = `atlas-${process.pid}`;

export class ExecutionPlaneService {
  constructor(private readonly db: DatabaseAdapter) {}

  async startChatRun(input: {
    idempotencyKey?: string | null;
    principal: CanonicalPrincipal;
    sessionId: string;
  }) {
    return this.startRun({
      idempotencyKey: input.idempotencyKey,
      kind: "chat",
      principal: input.principal,
      sessionId: input.sessionId,
    });
  }

  async startAutomationRun(input: {
    automationId: string;
    fireId?: string;
    principal: CanonicalPrincipal;
  }): Promise<{
    error?: string;
    replay: boolean;
    run: DurableExecutionRun | null;
    skipped: boolean;
  }> {
    const fireId = input.fireId?.trim();
    if (!fireId) {
      throw new ExecutionLeaseError(
        "Automation fireId is required for idempotent claiming."
      );
    }
    const idempotencyKey = automationFireIdempotencyKey(
      input.automationId,
      fireId
    );
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const active = (
      await this.db.listExecutionRuns({
        kind: "automation",
        orgId: input.principal.orgId,
        sessionId: input.automationId,
      })
    ).filter((run) => isActiveExecutionStatus(run.status));

    for (const stored of active) {
      if (stored.idempotencyKey === idempotencyKey) {
        continue;
      }
      const durable = toDurableRun(stored);
      if (isLiveLease(durable, nowMs)) {
        return {
          error: "Automation is already running.",
          replay: false,
          run: durable,
          skipped: true,
        };
      }
      const failed = completeRun(durable, "failed", nowIso);
      await this.db.casExecutionRun({
        id: durable.id,
        next: toStoredRun(failed),
        nowIso,
        requireExpiredLease: true,
      });
    }

    const queued = createQueuedRun({
      id: nanoid(),
      idempotencyKey,
      kind: "automation",
      orgId: input.principal.orgId,
      principal: input.principal,
      sessionId: input.automationId,
    });
    const leased = acquireLease(queued, makeLeaseOwner(), nowMs);
    const inserted = await this.db.insertExecutionRunIfAbsent(
      toStoredRun(leased)
    );
    if (inserted) {
      return { replay: false, run: leased, skipped: false };
    }

    const existing = await this.db.getExecutionRunByIdempotencyKey(
      input.principal.orgId,
      idempotencyKey
    );
    if (!existing) {
      return {
        error: "Automation is already running.",
        replay: false,
        run: null,
        skipped: true,
      };
    }

    const durable = toDurableRun(existing);
    assertIdempotentReplay(durable, input.principal);
    if (!isActiveExecutionStatus(durable.status)) {
      return {
        error: "Automation fire already completed.",
        replay: true,
        run: durable,
        skipped: true,
      };
    }
    if (isLiveLease(durable, nowMs)) {
      return {
        error: "Automation is already running.",
        replay: true,
        run: durable,
        skipped: true,
      };
    }

    try {
      const reclaimed = acquireLease(durable, makeLeaseOwner(), nowMs);
      const claimed = await this.db.casExecutionRun({
        id: reclaimed.id,
        next: toStoredRun(reclaimed),
        nowIso: reclaimed.updatedAt,
        requireExpiredLease: true,
      });
      if (!claimed) {
        return {
          error: "Automation is already running.",
          replay: true,
          run: durable,
          skipped: true,
        };
      }
      return { replay: true, run: reclaimed, skipped: false };
    } catch (error) {
      if (error instanceof ExecutionLeaseError) {
        return {
          error: "Automation is already running.",
          replay: true,
          run: durable,
          skipped: true,
        };
      }
      throw error;
    }
  }

  async startSubagentRun(input: {
    parentRunId?: string | null;
    principal: CanonicalPrincipal;
    sessionId?: string | null;
  }) {
    return this.startRun({
      idempotencyKey: null,
      kind: "subagent",
      principal: input.principal,
      sessionId: input.sessionId ?? input.parentRunId ?? null,
    });
  }

  async listActiveRuns(filter?: {
    kind?: DurableExecutionRun["kind"];
    orgId?: string;
    sessionId?: string;
  }): Promise<DurableExecutionRun[]> {
    const nowMs = Date.now();
    const runs = await this.db.listExecutionRuns(filter);
    return runs
      .filter((run) => isActiveExecutionStatus(run.status))
      .filter((run) => {
        if (!run.leaseExpiresAt) {
          return true;
        }
        return new Date(run.leaseExpiresAt).getTime() > nowMs;
      })
      .map(toDurableRun);
  }

  private async startRun(input: {
    idempotencyKey?: string | null;
    kind: DurableExecutionRun["kind"];
    principal: CanonicalPrincipal;
    sessionId?: string | null;
  }) {
    const run = createQueuedRun({
      id: nanoid(),
      idempotencyKey: input.idempotencyKey ?? null,
      kind: input.kind,
      orgId: input.principal.orgId,
      principal: input.principal,
      sessionId: input.sessionId,
    });
    const leased = acquireLease(run, makeLeaseOwner());
    const inserted = await this.db.insertExecutionRunIfAbsent(
      toStoredRun(leased)
    );
    if (inserted) {
      return leased;
    }
    if (input.idempotencyKey) {
      const existing = await this.db.getExecutionRunByIdempotencyKey(
        input.principal.orgId,
        input.idempotencyKey
      );
      if (existing) {
        return toDurableRun(existing);
      }
    }
    throw new Error("UNIQUE constraint failed: execution_runs");
  }

  async heartbeat(runId: string, leaseOwner: string): Promise<void> {
    const stored = await this.db.getExecutionRun(runId);
    if (!stored) {
      return;
    }
    const beat = heartbeatLease(toDurableRun(stored), leaseOwner);
    const updated = await this.db.casExecutionRun({
      expectedLeaseOwner: leaseOwner,
      id: runId,
      next: toStoredRun(beat),
      nowIso: beat.updatedAt,
      requireUnexpiredLease: true,
    });
    if (!updated) {
      throw new ExecutionLeaseError("Stale worker cannot heartbeat this run.");
    }
  }

  async saveCheckpoint(
    runId: string,
    checkpoint: ExecutionCheckpoint
  ): Promise<void> {
    const stored = await this.db.getExecutionRun(runId);
    if (!stored) {
      return;
    }
    await this.db.upsertExecutionRun({
      ...stored,
      checkpoint: JSON.stringify(checkpoint),
      updatedAt: new Date().toISOString(),
    });
  }

  async releaseClaim(runId: string, leaseOwner: string): Promise<void> {
    await this.db.deleteExecutionRunIfOwner(runId, leaseOwner);
  }

  async pauseForApproval(input: {
    approvalId: string;
    args: Record<string, unknown>;
    checkpoint: ExecutionCheckpoint;
    principal: CanonicalPrincipal;
    runId: string;
    sessionId: string | null;
    stepIndex: number;
    toolCallId: string;
    toolName: string;
  }) {
    const stored = await this.db.getExecutionRun(input.runId);
    if (!stored) {
      throw new Error("Execution run not found.");
    }
    const paused = pauseForApproval(
      {
        ...stored,
        checkpoint: stored.checkpoint
          ? (JSON.parse(stored.checkpoint) as ExecutionCheckpoint)
          : null,
        kind: stored.kind as DurableExecutionRun["kind"],
        status: stored.status as "running",
      },
      input.checkpoint
    );
    await this.db.upsertExecutionRun({
      ...stored,
      checkpoint: JSON.stringify(input.checkpoint),
      currentStepIndex: paused.currentStepIndex,
      status: paused.status,
      updatedAt: paused.updatedAt,
    });

    const stepId = nanoid();
    const argsHash = hashApprovalArgs(input.toolName, input.args);
    await this.db.upsertExecutionStep({
      approvalId: input.approvalId,
      argsHash,
      argsJson: JSON.stringify(input.args),
      createdAt: new Date().toISOString(),
      id: stepId,
      resultJson: null,
      runId: input.runId,
      status: "awaiting_approval",
      stepIndex: input.stepIndex,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      updatedAt: new Date().toISOString(),
    });

    await this.db.upsertActionApproval({
      actionHash: argsHash,
      argsJson: JSON.stringify(input.args),
      createdAt: new Date().toISOString(),
      decidedAt: null,
      decidedByUserId: null,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      grantId: null,
      id: input.approvalId,
      orgId: input.principal.orgId,
      principalUserId: input.principal.userId,
      runId: input.runId,
      sessionId: input.sessionId,
      status: "pending",
      stepId,
      toolName: input.toolName,
    });
  }

  async decide(input: {
    approvalId: string;
    decision: "approved" | "denied";
    principal: CanonicalPrincipal;
    sessionId: string;
  }) {
    const stored = await this.db.getActionApproval(input.approvalId);
    if (
      !stored ||
      stored.orgId !== input.principal.orgId ||
      stored.sessionId !== input.sessionId
    ) {
      throw new AtlasApiError("Approval not found.", 404);
    }
    if (stored.principalUserId !== input.principal.userId) {
      throw new AtlasApiError(
        "Only the canonical principal can decide this approval.",
        403
      );
    }
    const decided = applyApprovalDecision(
      {
        actionHash: stored.actionHash,
        args: JSON.parse(stored.argsJson) as Record<string, unknown>,
        createdAt: stored.createdAt,
        decidedAt: stored.decidedAt,
        decidedByUserId: stored.decidedByUserId,
        expiresAt: stored.expiresAt,
        grantId: stored.grantId,
        id: stored.id,
        orgId: stored.orgId,
        principalUserId: stored.principalUserId,
        runId: stored.runId,
        sessionId: stored.sessionId,
        status: stored.status as "pending",
        stepId: stored.stepId,
        toolName: stored.toolName,
      },
      input.decision,
      input.principal.userId
    );

    let grantId: string | null = null;
    if (input.decision === "approved") {
      const grant = globalApprovalGrantStore.createGrant({
        actionHash: stored.actionHash,
        executionId: stored.runId,
        orgId: stored.orgId,
        sessionId: stored.sessionId ?? stored.runId,
        userId: stored.principalUserId,
      });
      grantId = grant.id;
    }

    await this.db.upsertActionApproval({
      ...stored,
      decidedAt: decided.decidedAt,
      decidedByUserId: decided.decidedByUserId,
      grantId,
      status: decided.status,
    });

    const next = nextRunStatusAfterApproval(input.decision);
    const steps = await this.db.listExecutionSteps(stored.runId);
    const step = steps.find((item) => item.id === stored.stepId);
    if (step) {
      await this.db.upsertExecutionStep({
        ...step,
        status: next.step,
        updatedAt: new Date().toISOString(),
      });
    }

    const run = await this.db.getExecutionRun(stored.runId);
    if (run) {
      const resumed = resumeFromApproval({
        ...run,
        checkpoint: run.checkpoint
          ? (JSON.parse(run.checkpoint) as ExecutionCheckpoint)
          : null,
        kind: run.kind as DurableExecutionRun["kind"],
        status: "awaiting_approval",
      });
      await this.db.upsertExecutionRun({
        ...run,
        status: resumed.status,
        updatedAt: resumed.updatedAt,
      });
    }

    if (step) {
      assertExactStepResume(decided, {
        args: JSON.parse(stored.argsJson) as Record<string, unknown>,
        runId: stored.runId,
        stepIndex: step.stepIndex,
        toolCallId: step.toolCallId ?? stored.id,
        toolName: stored.toolName,
      });
    }

    return { grantId, record: decided, step };
  }

  async complete(
    runId: string,
    status: "completed" | "failed" | "cancelled",
    leaseOwner?: string | null
  ) {
    const run = await this.db.getExecutionRun(runId);
    if (!run) {
      return;
    }
    if (!isActiveExecutionStatus(run.status)) {
      if (leaseOwner) {
        throw new ExecutionLeaseError(
          "Stale worker cannot complete a stolen run."
        );
      }
      return;
    }
    const completed = completeRun(
      toDurableRun(run),
      status,
      new Date().toISOString(),
      leaseOwner
    );
    const updated = await this.db.casExecutionRun({
      ...(leaseOwner ? { expectedLeaseOwner: leaseOwner } : {}),
      id: runId,
      next: toStoredRun(completed),
      nowIso: completed.updatedAt,
    });
    if (!updated) {
      throw new ExecutionLeaseError(
        "Stale worker cannot complete a stolen run."
      );
    }
  }
}

function toStoredRun(run: DurableExecutionRun): StoredExecutionRunRecord {
  return {
    checkpoint: run.checkpoint ? JSON.stringify(run.checkpoint) : null,
    createdAt: run.createdAt,
    currentStepIndex: run.currentStepIndex,
    id: run.id,
    idempotencyKey: run.idempotencyKey,
    kind: run.kind,
    leaseExpiresAt: run.leaseExpiresAt,
    leaseOwner: run.leaseOwner,
    orgId: run.orgId,
    principalUserId: run.principalUserId,
    sessionId: run.sessionId,
    status: run.status,
    updatedAt: run.updatedAt,
  };
}

function isLiveLease(run: DurableExecutionRun, nowMs: number): boolean {
  return (
    Boolean(run.leaseOwner) &&
    Boolean(run.leaseExpiresAt) &&
    new Date(run.leaseExpiresAt ?? 0).getTime() > nowMs
  );
}

function toDurableRun(stored: StoredExecutionRunRecord): DurableExecutionRun {
  return {
    checkpoint: stored.checkpoint
      ? (JSON.parse(stored.checkpoint) as ExecutionCheckpoint)
      : null,
    createdAt: stored.createdAt,
    currentStepIndex: stored.currentStepIndex,
    id: stored.id,
    idempotencyKey: stored.idempotencyKey,
    kind: stored.kind,
    leaseExpiresAt: stored.leaseExpiresAt,
    leaseOwner: stored.leaseOwner,
    orgId: stored.orgId,
    principalUserId: stored.principalUserId,
    sessionId: stored.sessionId,
    status: stored.status as DurableExecutionRun["status"],
    updatedAt: stored.updatedAt,
  };
}

function makeLeaseOwner(): string {
  return `${WORKER_ID}:${nanoid()}`;
}
