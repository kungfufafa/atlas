import {
  applyLearningMode,
  applyRedactionBoundary,
  type CanonicalPrincipal,
  canAutoCommit,
  captureEvidence,
  closeLearningLoop,
  commitLearning,
  createAuditEvent,
  EVALUATOR_VERSION,
  evaluateLearningCandidate,
  type LearningMode,
  learningJobIdempotencyKey,
  nanoid,
} from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";
import { MemoryService } from "./memory-service";

export class LearningPlaneService {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly memoryService = new MemoryService(db)
  ) {}

  async ingestTurn(input: {
    mode?: LearningMode;
    payload: unknown;
    principal: CanonicalPrincipal;
    runId?: string | null;
    sessionId?: string | null;
    terminalMessageId?: string | null;
    userCorrected?: boolean;
  }) {
    const mode = input.mode ?? "propose";
    if (mode === "off") {
      return { candidate: null, commit: null, evidence: null, job: null };
    }

    const sessionId = input.sessionId ?? "session_unknown";
    const terminalMessageId = input.terminalMessageId ?? "msg_unknown";
    const idempotencyKey = learningJobIdempotencyKey({
      sessionId,
      terminalMessageId,
    });
    const existing = await this.db.getLearningJobByIdempotencyKey(
      input.principal.orgId,
      idempotencyKey
    );
    if (existing) {
      return { candidate: null, commit: null, evidence: null, job: existing };
    }

    const now = new Date().toISOString();
    const jobId = nanoid();
    await this.db.upsertLearningJob({
      createdAt: now,
      evaluatorVersion: EVALUATOR_VERSION,
      id: jobId,
      idempotencyKey,
      mode,
      orgId: input.principal.orgId,
      principalUserId: input.principal.userId,
      resultJson: null,
      sessionId,
      status: "running",
      terminalMessageId,
      updatedAt: now,
    });

    const evidence = captureEvidence({
      id: nanoid(),
      kind: input.userCorrected ? "user_correction" : "turn",
      payload: input.payload,
      principal: input.principal,
      runId: input.runId,
      sessionId: input.sessionId,
    });
    await this.db.createLearningEvidence({
      createdAt: evidence.createdAt,
      id: evidence.id,
      kind: evidence.kind,
      orgId: evidence.orgId,
      payloadJson: JSON.stringify(evidence.payload),
      principalUserId: evidence.principalUserId,
      runId: evidence.runId,
      sessionId: evidence.sessionId,
    });

    const rawCandidate = evaluateLearningCandidate({
      evidence: [evidence],
      id: nanoid(),
      orgId: input.principal.orgId,
    });
    const candidate = rawCandidate
      ? applyLearningMode(mode, rawCandidate)
      : null;
    if (!candidate) {
      await this.db.upsertLearningJob({
        createdAt: now,
        evaluatorVersion: EVALUATOR_VERSION,
        id: jobId,
        idempotencyKey,
        mode,
        orgId: input.principal.orgId,
        principalUserId: input.principal.userId,
        resultJson: JSON.stringify({ action: "noop" }),
        sessionId,
        status: "completed",
        terminalMessageId,
        updatedAt: new Date().toISOString(),
      });
      return { candidate: null, commit: null, evidence, job: null };
    }

    await this.db.upsertLearningCandidate({
      content: candidate.content,
      createdAt: candidate.createdAt,
      evidenceIds: JSON.stringify(candidate.evidenceIds),
      id: candidate.id,
      kind: candidate.kind,
      orgId: candidate.orgId,
      status: candidate.status,
      target: candidate.target,
      updatedAt: candidate.updatedAt,
    });

    if (candidate.target !== "memory" || !canAutoCommit(mode, candidate.kind)) {
      await this.db.upsertLearningJob({
        createdAt: now,
        evaluatorVersion: EVALUATOR_VERSION,
        id: jobId,
        idempotencyKey,
        mode,
        orgId: input.principal.orgId,
        principalUserId: input.principal.userId,
        resultJson: JSON.stringify({
          action: "propose",
          candidateId: candidate.id,
          target: candidate.target,
        }),
        sessionId,
        status: "completed",
        terminalMessageId,
        updatedAt: new Date().toISOString(),
      });
      return { candidate, commit: null, evidence, job: null };
    }

    const memory = await this.memoryService.writeMemory(input.principal.orgId, {
      content: applyRedactionBoundary(candidate.content, "memory"),
      ownerId: input.principal.userId,
      scope: "user",
      source: `learning:${evidence.id}`,
    });
    const committed = commitLearning(
      candidate,
      { memoryId: memory.id },
      nanoid()
    );
    await this.db.upsertLearningCandidate({
      ...candidate,
      evidenceIds: JSON.stringify(committed.candidate.evidenceIds),
      status: committed.candidate.status,
      updatedAt: committed.candidate.updatedAt,
    });
    await this.db.createLearningCommit({
      candidateId: committed.commit.candidateId,
      createdAt: committed.commit.createdAt,
      id: committed.commit.id,
      memoryId: committed.commit.memoryId,
      orgId: committed.commit.orgId,
      skillId: committed.commit.skillId,
    });
    const audit = createAuditEvent({
      action: "learning.commit",
      id: nanoid(),
      payload: { commitId: committed.commit.id, memoryId: memory.id },
      principal: input.principal,
      resource: `memory:${memory.id}`,
      runId: input.runId,
    });
    await this.db.createAuditEvent({
      action: audit.action,
      createdAt: audit.createdAt,
      id: audit.id,
      orgId: audit.orgId,
      payloadJson: JSON.stringify(audit.payload),
      principalUserId: audit.principalUserId,
      resource: audit.resource,
      runId: audit.runId,
    });
    await this.db.upsertLearningJob({
      createdAt: now,
      evaluatorVersion: EVALUATOR_VERSION,
      id: jobId,
      idempotencyKey,
      mode,
      orgId: input.principal.orgId,
      principalUserId: input.principal.userId,
      resultJson: JSON.stringify({
        action: "commit",
        commitId: committed.commit.id,
      }),
      sessionId,
      status: "completed",
      terminalMessageId,
      updatedAt: new Date().toISOString(),
    });
    return {
      candidate: committed.candidate,
      commit: committed.commit,
      evidence,
      job: null,
    };
  }

  async recordRetrievalOutcome(input: {
    commitId: string;
    orgId: string;
    retrieved: boolean;
    sessionId?: string | null;
    subsequentCorrection: boolean;
  }) {
    const outcome = closeLearningLoop({
      commit: {
        candidateId: "",
        createdAt: new Date().toISOString(),
        id: input.commitId,
        memoryId: null,
        orgId: input.orgId,
        skillId: null,
      },
      id: nanoid(),
      retrieved: input.retrieved,
      sessionId: input.sessionId,
      subsequentCorrection: input.subsequentCorrection,
    });
    await this.db.createLearningOutcome({
      commitId: input.commitId,
      createdAt: outcome.createdAt,
      helpful: outcome.helpful,
      id: outcome.id,
      orgId: input.orgId,
      sessionId: outcome.sessionId,
      used: outcome.used,
    });
    return outcome;
  }
}
