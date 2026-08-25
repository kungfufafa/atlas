import {
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
    const existing = await this.db.getExecutionRunByIdempotencyKey(
      input.principal.orgId,
      idempotencyKey
    );
    if (existing) {
      const durable = toDurableRun(existing);
      assertIdempotentReplay(durable, input.principal);
      if (isActiveExecutionStatus(durable.status)) {
        const nowMs = Date.now();
        const leaseLive =
          Boolean(durable.leaseOwner) &&
          Boolean(durable.leaseExpiresAt) &&
          new Date(durable.leaseExpiresAt ?? 0).getTime() > nowMs;
        if (leaseLive) {
          return {
            error: "Automation is already running.",
            replay: true,
            run: durable,
            skipped: true,
          };
        }
        try {
          const leased = acquireLease(durable, makeLeaseOwner(), nowMs);
          await this.persist(leased);
          return { replay: true, run: leased, skipped: false };
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
      return {
        error: "Automation fire already completed.",
        replay: true,
        run: durable,
        skipped: true,
      };
    }

    const active = (
      await this.db.listExecutionRuns({
        kind: "automation",
        orgId: input.principal.orgId,
        sessionId: input.automationId,
      })
    ).filter((run) => isActiveExecutionStatus(run.status));
    const nowMs = Date.now();

    for (const stored of active) {
      const durable = toDurableRun(stored);
      const leaseLive =
        Boolean(durable.leaseOwner) &&
        Boolean(durable.leaseExpiresAt) &&
        new Date(durable.leaseExpiresAt ?? 0).getTime() > nowMs;
      if (leaseLive) {
        return {
          error: "Automation is already running.",
          replay: false,
          run: durable,
          skipped: true,
        };
      }
      await this.complete(durable.id, "failed");
    }

    try {
      const run = await this.startRun({
        idempotencyKey,
        kind: "automation",
        principal: input.principal,
        sessionId: input.automationId,
      });
      return { replay: false, run, skipped: false };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return {
          error: "Automation is already running.",
          replay: false,
          run: null,
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
    if (input.idempotencyKey) {
      const existing = await this.db.getExecutionRunByIdempotencyKey(
        input.principal.orgId,
        input.idempotencyKey
      );
      if (existing) {
        return toDurableRun(existing);
      }
    }

    const run = createQueuedRun({
      id: nanoid(),
      idempotencyKey: input.idempotencyKey ?? null,
      kind: input.kind,
      orgId: input.principal.orgId,
      principal: input.principal,
      sessionId: input.sessionId,
    });
    const leased = acquireLease(run, makeLeaseOwner());
    await this.persist(leased);
    return leased;
  }

  async heartbeat(runId: string, leaseOwner: string): Promise<void> {
    const stored = await this.db.getExecutionRun(runId);
    if (!stored) {
      return;
    }
    const beat = heartbeatLease(toDurableRun(stored), leaseOwner);
    await this.persist(beat);
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

  private async persist(run: DurableExecutionRun): Promise<void> {
    await this.db.upsertExecutionRun({
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
    });
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
  }) {
    const stored = await this.db.getActionApproval(input.approvalId);
    if (!stored) {
      throw new Error("Approval not found.");
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
    const completed = completeRun(
      {
        ...run,
        checkpoint: run.checkpoint
          ? (JSON.parse(run.checkpoint) as ExecutionCheckpoint)
          : null,
        kind: run.kind as DurableExecutionRun["kind"],
        status: run.status as "running",
      },
      status,
      new Date().toISOString(),
      leaseOwner
    );
    await this.db.upsertExecutionRun({
      ...run,
      checkpoint: run.checkpoint,
      leaseExpiresAt: null,
      leaseOwner: null,
      status: completed.status,
      updatedAt: completed.updatedAt,
    });
  }
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

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint/i.test(message);
}

function makeLeaseOwner(): string {
  return `${WORKER_ID}:${nanoid()}`;
}
