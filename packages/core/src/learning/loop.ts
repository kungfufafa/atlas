import {
  assertCanonicalPrincipal,
  type CanonicalPrincipal,
} from "../identity/principal";
import { applyRedactionBoundary } from "../redaction-boundary";
import type {
  LearningCandidate,
  LearningCandidateKind,
  LearningCommit,
  LearningEvidence,
  LearningEvidenceKind,
  LearningOutcome,
  LearningTarget,
} from "./types";

export class LearningLoopError extends Error {
  readonly code = "LEARNING_LOOP";

  constructor(message: string) {
    super(message);
    this.name = "LearningLoopError";
  }
}

export function captureEvidence(input: {
  id: string;
  kind: LearningEvidenceKind;
  payload: unknown;
  principal: CanonicalPrincipal;
  runId?: string | null;
  sessionId?: string | null;
  now?: string;
}): LearningEvidence {
  const principal = assertCanonicalPrincipal(input.principal);
  const payload = applyRedactionBoundary(input.payload, "learning");
  return {
    createdAt: input.now ?? new Date().toISOString(),
    id: input.id,
    kind: input.kind,
    orgId: principal.orgId,
    payload,
    principalUserId: principal.userId,
    runId: input.runId ?? null,
    sessionId: input.sessionId ?? null,
  };
}

export function evaluateLearningCandidate(input: {
  evidence: LearningEvidence[];
  id: string;
  now?: string;
  orgId: string;
}): LearningCandidate | null {
  if (input.evidence.length === 0) {
    throw new LearningLoopError(
      "A candidate requires at least one evidence record."
    );
  }

  for (const item of input.evidence) {
    if (item.orgId !== input.orgId) {
      throw new LearningLoopError("Evidence org does not match candidate org.");
    }
  }

  const correction = input.evidence.find(
    (item) => item.kind === "user_correction"
  );
  const fact = input.evidence.find((item) => item.kind === "turn");
  const procedure = input.evidence.find((item) => item.kind === "tool_result");

  let kind: LearningCandidateKind | null = null;
  let content: string | null = null;
  let target: LearningTarget = "memory";

  if (correction) {
    kind = "fact";
    content = extractText(correction.payload) || "User correction";
    target = "memory";
  } else if (procedure && looksLikeProcedure(procedure.payload)) {
    kind = "procedure";
    content = extractText(procedure.payload) || "Reusable procedure";
    target = "skill";
  } else if (fact && looksLikeDurableFact(fact.payload)) {
    kind = "fact";
    content = extractText(fact.payload) || "Durable fact";
    target = "memory";
  }

  if (!(kind && content)) {
    return null;
  }

  const now = input.now ?? new Date().toISOString();
  return {
    content,
    createdAt: now,
    evidenceIds: input.evidence.map((item) => item.id),
    id: input.id,
    kind,
    orgId: input.orgId,
    status: "proposed",
    target,
    updatedAt: now,
  };
}

export function commitLearning(
  candidate: LearningCandidate,
  refs: { memoryId?: string | null; skillId?: string | null },
  commitId: string,
  now = new Date().toISOString()
): { candidate: LearningCandidate; commit: LearningCommit } {
  if (candidate.status !== "proposed") {
    throw new LearningLoopError("Only proposed candidates can be committed.");
  }
  if (candidate.evidenceIds.length === 0) {
    throw new LearningLoopError("Cannot commit a candidate without evidence.");
  }

  if (candidate.target === "memory" && !refs.memoryId) {
    throw new LearningLoopError("Memory commits require memoryId.");
  }
  if (candidate.target === "skill" && !refs.skillId) {
    throw new LearningLoopError("Skill commits require skillId.");
  }

  return {
    candidate: { ...candidate, status: "committed", updatedAt: now },
    commit: {
      candidateId: candidate.id,
      createdAt: now,
      id: commitId,
      memoryId: refs.memoryId ?? null,
      orgId: candidate.orgId,
      skillId: refs.skillId ?? null,
    },
  };
}

export function recordLearningOutcome(input: {
  commit: LearningCommit;
  helpful?: boolean | null;
  id: string;
  sessionId?: string | null;
  used: boolean;
  now?: string;
}): LearningOutcome {
  return {
    commitId: input.commit.id,
    createdAt: input.now ?? new Date().toISOString(),
    helpful: input.helpful ?? null,
    id: input.id,
    orgId: input.commit.orgId,
    sessionId: input.sessionId ?? null,
    used: input.used,
  };
}

export function closeLearningLoop(input: {
  commit: LearningCommit;
  retrieved: boolean;
  subsequentCorrection: boolean;
  id: string;
  sessionId?: string | null;
}): LearningOutcome {
  if (!input.retrieved) {
    return recordLearningOutcome({
      commit: input.commit,
      helpful: null,
      id: input.id,
      sessionId: input.sessionId,
      used: false,
    });
  }

  return recordLearningOutcome({
    commit: input.commit,
    helpful: !input.subsequentCorrection,
    id: input.id,
    sessionId: input.sessionId,
    used: true,
  });
}

function extractText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.trim();
  }
  if (payload && typeof payload === "object" && "text" in payload) {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === "string") {
      return text.trim();
    }
  }
  if (payload && typeof payload === "object" && "content" in payload) {
    const content = (payload as { content?: unknown }).content;
    if (typeof content === "string") {
      return content.trim();
    }
  }
  return "";
}

function looksLikeDurableFact(payload: unknown): boolean {
  const text = extractText(payload).toLowerCase();
  return (
    text.includes("remember") ||
    text.includes("preference") ||
    text.includes("always") ||
    text.includes("my name")
  );
}

function looksLikeProcedure(payload: unknown): boolean {
  const text = extractText(payload).toLowerCase();
  return (
    text.includes("checklist") ||
    text.includes("steps") ||
    text.includes("procedure") ||
    text.includes("runbook")
  );
}
