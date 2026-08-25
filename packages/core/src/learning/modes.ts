import { LearningLoopError } from "./loop";
import type { LearningCandidate, LearningCandidateKind } from "./types";

export type LearningMode = "off" | "propose" | "auto";

export const EVALUATOR_VERSION = "v1";

/**
 * Learned skills must never auto-publish. Auto mode may commit facts only.
 */
export function applyLearningMode(
  mode: LearningMode,
  candidate: LearningCandidate
): LearningCandidate | null {
  if (mode === "off") {
    return null;
  }
  if (mode === "propose") {
    return { ...candidate, status: "proposed" };
  }
  if (candidate.kind === "procedure" || candidate.target === "skill") {
    return { ...candidate, status: "proposed" };
  }
  return { ...candidate, status: "proposed" };
}

export function canAutoCommit(
  mode: LearningMode,
  kind: LearningCandidateKind
): boolean {
  return mode === "auto" && kind === "fact";
}

export function assertNeverAutoPublishesSkills(
  mode: LearningMode,
  candidate: LearningCandidate
): void {
  if (
    candidate.target === "skill" &&
    mode === "auto" &&
    candidate.status === "committed"
  ) {
    throw new LearningLoopError("Learned skills must never auto-publish.");
  }
}

export function learningJobIdempotencyKey(input: {
  evaluatorVersion?: string;
  sessionId: string;
  terminalMessageId: string;
}): string {
  const version = input.evaluatorVersion ?? EVALUATOR_VERSION;
  return `${input.sessionId}:${input.terminalMessageId}:${version}`;
}
