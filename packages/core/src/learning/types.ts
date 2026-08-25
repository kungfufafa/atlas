export type LearningEvidenceKind =
  | "turn"
  | "tool_result"
  | "user_correction"
  | "outcome";

export type LearningCandidateKind = "fact" | "procedure";

export type LearningCandidateStatus =
  | "proposed"
  | "committed"
  | "rejected"
  | "expired";

export type LearningTarget = "memory" | "skill";

export interface LearningEvidence {
  createdAt: string;
  id: string;
  kind: LearningEvidenceKind;
  orgId: string;
  payload: unknown;
  principalUserId: string;
  runId: string | null;
  sessionId: string | null;
}

export interface LearningCandidate {
  content: string;
  createdAt: string;
  evidenceIds: string[];
  id: string;
  kind: LearningCandidateKind;
  orgId: string;
  status: LearningCandidateStatus;
  target: LearningTarget;
  updatedAt: string;
}

export interface LearningCommit {
  candidateId: string;
  createdAt: string;
  id: string;
  memoryId: string | null;
  orgId: string;
  skillId: string | null;
}

export interface LearningOutcome {
  commitId: string;
  createdAt: string;
  helpful: boolean | null;
  id: string;
  orgId: string;
  sessionId: string | null;
  used: boolean;
}
