import { describe, expect, test } from "bun:test";
import type { CanonicalPrincipal } from "../identity/principal";
import { PrincipalRequiredError } from "../identity/principal";
import { LOCAL_CLIENT_USER_ID } from "../local-auth";
import { nextSkillRevision } from "../skills/registry";
import {
  captureEvidence,
  closeLearningLoop,
  commitLearning,
  evaluateLearningCandidate,
  LearningLoopError,
  recordLearningOutcome,
} from "./loop";
import type { LearningEvidence } from "./types";

const principal: CanonicalPrincipal = {
  isPlatformAdmin: false,
  orgId: "org_1",
  orgRole: "member",
  userId: "user_1",
};

function evidence(
  overrides: Partial<LearningEvidence> & Pick<LearningEvidence, "id" | "kind">
): LearningEvidence {
  return captureEvidence({
    id: overrides.id,
    kind: overrides.kind,
    payload: overrides.payload ?? { text: "remember I prefer dark mode" },
    principal,
    runId: overrides.runId ?? "run_1",
    sessionId: overrides.sessionId ?? "sess_1",
  });
}

describe("closed learning loop", () => {
  test("1 capture requires canonical principal", () => {
    expect(() =>
      captureEvidence({
        id: "ev_1",
        kind: "turn",
        payload: { text: "hi" },
        principal: { ...principal, userId: "" },
      })
    ).toThrow(PrincipalRequiredError);
  });

  test("2 capture rejects service-account principal", () => {
    expect(() =>
      captureEvidence({
        id: "ev_1",
        kind: "turn",
        payload: { text: "hi" },
        principal: { ...principal, userId: LOCAL_CLIENT_USER_ID },
      })
    ).toThrow(/service-account/);
  });

  test("3 capture redacts secrets before persist", () => {
    const item = captureEvidence({
      id: "ev_1",
      kind: "turn",
      payload: { text: "api_key=sk-abcdefghijklmnopqrstuvwxyz" },
      principal,
    });
    expect(JSON.stringify(item.payload)).not.toContain(
      "sk-abcdefghijklmnopqrstuvwxyz"
    );
  });

  test("4 candidate requires evidence", () => {
    expect(() =>
      evaluateLearningCandidate({ evidence: [], id: "cand_1", orgId: "org_1" })
    ).toThrow(LearningLoopError);
  });

  test("5 evidence org isolation", () => {
    const item = evidence({ id: "ev_1", kind: "turn" });
    expect(() =>
      evaluateLearningCandidate({
        evidence: [item],
        id: "cand_1",
        orgId: "org_2",
      })
    ).toThrow(/org does not match/);
  });

  test("6 user correction becomes a memory fact", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "No, my name is Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    expect(candidate?.kind).toBe("fact");
    expect(candidate?.target).toBe("memory");
    expect(candidate?.evidenceIds).toEqual(["ev_1"]);
  });

  test("7 procedure tool result becomes a skill candidate", () => {
    const item = evidence({
      id: "ev_2",
      kind: "tool_result",
      payload: { text: "deploy checklist steps: 1 build 2 ship" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_2",
      orgId: "org_1",
    });
    expect(candidate?.kind).toBe("procedure");
    expect(candidate?.target).toBe("skill");
  });

  test("8 durable fact from turn", () => {
    const item = evidence({
      id: "ev_3",
      kind: "turn",
      payload: { text: "Please remember my timezone is SGT" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_3",
      orgId: "org_1",
    });
    expect(candidate?.kind).toBe("fact");
  });

  test("9 chit-chat produces no candidate", () => {
    const item = evidence({
      id: "ev_4",
      kind: "turn",
      payload: { text: "hello there" },
    });
    expect(
      evaluateLearningCandidate({
        evidence: [item],
        id: "cand_4",
        orgId: "org_1",
      })
    ).toBeNull();
  });

  test("10 commit requires proposed status", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    const first = commitLearning(candidate!, { memoryId: "mem_1" }, "commit_1");
    expect(() =>
      commitLearning(first.candidate, { memoryId: "mem_2" }, "commit_2")
    ).toThrow(/proposed/);
  });

  test("11 memory commit requires memoryId", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    expect(() => commitLearning(candidate!, {}, "commit_1")).toThrow(
      /memoryId/
    );
  });

  test("12 skill commit requires skillId", () => {
    const item = evidence({
      id: "ev_2",
      kind: "tool_result",
      payload: { text: "procedure runbook" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_2",
      orgId: "org_1",
    });
    expect(() => commitLearning(candidate!, {}, "commit_1")).toThrow(/skillId/);
  });

  test("13 commit links evidence ids", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    const { commit, candidate: committed } = commitLearning(
      candidate!,
      { memoryId: "mem_1" },
      "commit_1"
    );
    expect(committed.status).toBe("committed");
    expect(commit.memoryId).toBe("mem_1");
    expect(commit.candidateId).toBe("cand_1");
    expect(committed.evidenceIds).toContain("ev_1");
  });

  test("14 unused retrieval records used=false", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    const { commit } = commitLearning(
      candidate!,
      { memoryId: "mem_1" },
      "commit_1"
    );
    const outcome = closeLearningLoop({
      commit,
      id: "out_1",
      retrieved: false,
      subsequentCorrection: false,
    });
    expect(outcome.used).toBe(false);
    expect(outcome.helpful).toBeNull();
  });

  test("15 retrieved without later correction is helpful", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    const { commit } = commitLearning(
      candidate!,
      { memoryId: "mem_1" },
      "commit_1"
    );
    const outcome = closeLearningLoop({
      commit,
      id: "out_1",
      retrieved: true,
      subsequentCorrection: false,
    });
    expect(outcome.used).toBe(true);
    expect(outcome.helpful).toBe(true);
  });

  test("16 retrieved then corrected is not helpful", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    const { commit } = commitLearning(
      candidate!,
      { memoryId: "mem_1" },
      "commit_1"
    );
    const outcome = closeLearningLoop({
      commit,
      id: "out_1",
      retrieved: true,
      subsequentCorrection: true,
    });
    expect(outcome.helpful).toBe(false);
  });

  test("17 outcome inherits commit org", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    const { commit } = commitLearning(
      candidate!,
      { memoryId: "mem_1" },
      "commit_1"
    );
    const outcome = recordLearningOutcome({
      commit,
      helpful: true,
      id: "out_1",
      used: true,
    });
    expect(outcome.orgId).toBe("org_1");
  });

  test("18 multiple evidence ids stay attached", () => {
    const a = evidence({
      id: "ev_a",
      kind: "turn",
      payload: { text: "remember this" },
    });
    const b = evidence({
      id: "ev_b",
      kind: "user_correction",
      payload: { text: "actually remember that" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [a, b],
      id: "cand_1",
      orgId: "org_1",
    });
    expect(candidate?.evidenceIds).toEqual(["ev_a", "ev_b"]);
  });

  test("19 fire-and-forget is rejected: no commit without evidence ids", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    expect(() =>
      commitLearning(
        { ...candidate!, evidenceIds: [] },
        { memoryId: "mem_1" },
        "commit_1"
      )
    ).toThrow(/without evidence/);
  });

  test("20 skill revision is evidence-linked", () => {
    const revision = nextSkillRevision({
      content: "How we triage support tickets",
      createdBy: principal,
      evidenceIds: ["ev_2"],
      id: "rev_1",
      orgId: "org_1",
      previousVersion: 0,
      skillId: "skill_1",
    });
    expect(revision.version).toBe(1);
    expect(revision.evidenceIds).toEqual(["ev_2"]);
    expect(revision.createdByUserId).toBe("user_1");
  });

  test("21 skill revision redacts secrets", () => {
    const revision = nextSkillRevision({
      content: "token sk-abcdefghijklmnopqrstuvwxyz",
      id: "rev_1",
      orgId: "org_1",
      previousVersion: 2,
      skillId: "skill_1",
    });
    expect(revision.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(revision.version).toBe(3);
  });

  test("22 skill revision rejects empty content", () => {
    expect(() =>
      nextSkillRevision({
        content: "  ",
        id: "rev_1",
        orgId: "org_1",
        previousVersion: 0,
        skillId: "skill_1",
      })
    ).toThrow(/content is required/);
  });

  test("23 capture binds runId for closed loop", () => {
    const item = captureEvidence({
      id: "ev_1",
      kind: "tool_result",
      payload: { text: "ok" },
      principal,
      runId: "run_99",
    });
    expect(item.runId).toBe("run_99");
  });

  test("24 capture binds sessionId", () => {
    const item = captureEvidence({
      id: "ev_1",
      kind: "outcome",
      payload: { text: "used" },
      principal,
      sessionId: "sess_9",
    });
    expect(item.sessionId).toBe("sess_9");
  });

  test("25 principal org is copied onto evidence", () => {
    const item = captureEvidence({
      id: "ev_1",
      kind: "turn",
      payload: { text: "remember coffee" },
      principal,
    });
    expect(item.orgId).toBe("org_1");
    expect(item.principalUserId).toBe("user_1");
  });

  test("26 missing orgRole fails closed", () => {
    expect(() =>
      captureEvidence({
        id: "ev_1",
        kind: "turn",
        payload: { text: "x" },
        principal: { ...principal, orgRole: undefined as never },
      })
    ).toThrow(PrincipalRequiredError);
  });

  test("27 missing orgId fails closed", () => {
    expect(() =>
      captureEvidence({
        id: "ev_1",
        kind: "turn",
        payload: { text: "x" },
        principal: { ...principal, orgId: "" },
      })
    ).toThrow(PrincipalRequiredError);
  });

  test("28 procedure without skill target cannot memory-commit", () => {
    const item = evidence({
      id: "ev_2",
      kind: "tool_result",
      payload: { text: "checklist procedure" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_2",
      orgId: "org_1",
    });
    expect(candidate?.target).toBe("skill");
    expect(() =>
      commitLearning(candidate!, { memoryId: "mem_1" }, "commit_1")
    ).toThrow(/skillId/);
  });

  test("29 fact cannot skill-commit", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    expect(() =>
      commitLearning(candidate!, { skillId: "skill_1" }, "commit_1")
    ).toThrow(/memoryId/);
  });

  test("30 outcome session is optional", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    const { commit } = commitLearning(
      candidate!,
      { memoryId: "mem_1" },
      "commit_1"
    );
    const outcome = recordLearningOutcome({ commit, id: "out_1", used: false });
    expect(outcome.sessionId).toBeNull();
  });

  test("31 closed loop used+helpful path", () => {
    const item = evidence({
      id: "ev_1",
      kind: "turn",
      payload: { text: "remember I prefer dark mode" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    const { commit } = commitLearning(
      candidate!,
      { memoryId: "mem_1" },
      "commit_1"
    );
    const outcome = closeLearningLoop({
      commit,
      id: "out_1",
      retrieved: true,
      sessionId: "sess_later",
      subsequentCorrection: false,
    });
    expect(outcome.sessionId).toBe("sess_later");
    expect(outcome.used && outcome.helpful).toBe(true);
  });

  test("32 nested secret objects are redacted in evidence", () => {
    const item = captureEvidence({
      id: "ev_1",
      kind: "tool_result",
      payload: { config: { password: "hunter2-secret" } },
      principal,
    });
    const json = JSON.stringify(item.payload);
    expect(json).not.toContain("hunter2-secret");
  });

  test("33 candidate status starts proposed", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    expect(candidate?.status).toBe("proposed");
  });

  test("34 commit id is stored", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    const { commit } = commitLearning(
      candidate!,
      { memoryId: "mem_1" },
      "commit_xyz"
    );
    expect(commit.id).toBe("commit_xyz");
  });

  test("35 skill commit stores skillId not memoryId", () => {
    const item = evidence({
      id: "ev_2",
      kind: "tool_result",
      payload: { text: "steps procedure" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_2",
      orgId: "org_1",
    });
    const { commit } = commitLearning(
      candidate!,
      { skillId: "skill_9" },
      "commit_1"
    );
    expect(commit.skillId).toBe("skill_9");
    expect(commit.memoryId).toBeNull();
  });

  test("36 viewer principal can still capture evidence (policy is elsewhere)", () => {
    const item = captureEvidence({
      id: "ev_1",
      kind: "turn",
      payload: { text: "remember tea" },
      principal: { ...principal, orgRole: "viewer" },
    });
    expect(item.principalUserId).toBe("user_1");
  });

  test("37 admin principal is accepted", () => {
    const item = captureEvidence({
      id: "ev_1",
      kind: "turn",
      payload: { text: "remember tea" },
      principal: { ...principal, orgRole: "admin" },
    });
    expect(item.orgId).toBe("org_1");
  });

  test("38 payload content field is used as text", () => {
    const item = evidence({
      id: "ev_1",
      kind: "turn",
      payload: { content: "remember the vault path" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    expect(candidate?.content).toContain("vault path");
  });

  test("39 loop is not fire-and-forget: unused vs used is explicit", () => {
    const item = evidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "Ada" },
    });
    const candidate = evaluateLearningCandidate({
      evidence: [item],
      id: "cand_1",
      orgId: "org_1",
    });
    const { commit } = commitLearning(
      candidate!,
      { memoryId: "mem_1" },
      "commit_1"
    );
    const unused = closeLearningLoop({
      commit,
      id: "out_unused",
      retrieved: false,
      subsequentCorrection: false,
    });
    const used = closeLearningLoop({
      commit,
      id: "out_used",
      retrieved: true,
      subsequentCorrection: false,
    });
    expect(unused.used).toBe(false);
    expect(used.used).toBe(true);
    expect(used.helpful).not.toBeNull();
  });
});
