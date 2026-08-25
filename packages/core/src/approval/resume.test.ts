import { describe, expect, test } from "bun:test";
import {
  type ActionApprovalRecord,
  applyApprovalDecision,
  assertExactStepResume,
  hashApprovalArgs,
  nextRunStatusAfterApproval,
} from "./resume";

function pending(
  overrides: Partial<ActionApprovalRecord> = {}
): ActionApprovalRecord {
  const args = { amount: 10 };
  return {
    actionHash: hashApprovalArgs("checkout", args),
    args,
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedByUserId: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    grantId: null,
    id: "appr_1",
    orgId: "org_1",
    principalUserId: "user_1",
    runId: "run_1",
    sessionId: "sess_1",
    status: "pending",
    stepId: "step_1",
    toolName: "checkout",
    ...overrides,
  };
}

describe("approval exact-step resume", () => {
  test("pending → approved is principal-bound", () => {
    const decided = applyApprovalDecision(pending(), "approved", "user_1");
    expect(decided.status).toBe("approved");
    expect(nextRunStatusAfterApproval("approved")).toEqual({
      run: "running",
      step: "running",
    });
  });

  test("deny does not execute — step becomes denied", () => {
    const decided = applyApprovalDecision(pending(), "denied", "user_1");
    expect(decided.status).toBe("denied");
    expect(nextRunStatusAfterApproval("denied").step).toBe("denied");
  });

  test("other users cannot decide", () => {
    expect(() =>
      applyApprovalDecision(pending(), "approved", "user_2")
    ).toThrow(/canonical principal/);
  });

  test("resume requires exact args hash", () => {
    const record = pending();
    expect(() =>
      assertExactStepResume(record, {
        args: { amount: 11 },
        runId: "run_1",
        stepIndex: 0,
        toolCallId: "call_1",
        toolName: "checkout",
      })
    ).toThrow(/action hash/);

    expect(() =>
      assertExactStepResume(record, {
        args: { amount: 10 },
        runId: "run_1",
        stepIndex: 0,
        toolCallId: "call_1",
        toolName: "checkout",
      })
    ).not.toThrow();
  });

  test("cannot decide twice", () => {
    const decided = applyApprovalDecision(pending(), "approved", "user_1");
    expect(() => applyApprovalDecision(decided, "denied", "user_1")).toThrow(
      /not pending/
    );
  });
});
