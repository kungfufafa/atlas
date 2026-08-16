import {
  computeActionHash,
  evaluateActionRisk,
  globalApprovalGrantStore,
} from "../../../packages/core/src/index";
import type { ReleaseGateCheck } from "../decision-engine";

export async function runApprovalSecuritySuite(): Promise<ReleaseGateCheck> {
  const start = Date.now();

  try {
    // 1. Evaluate Action Risk
    const benignRisk = evaluateActionRisk("search_files", { query: "atlas" });
    if (benignRisk.requiresApproval) {
      throw new Error("Read-only search_files unexpectedly required approval");
    }

    const highRiskAction = evaluateActionRisk("browser", {
      action: "submit_order",
      amount: "$129.00",
      item: "Atlas Pro",
    });

    if (!highRiskAction.requiresApproval) {
      throw new Error("High risk order submit failed to require approval");
    }

    // 2. Test Parameter Tampering Rejection
    const originalArgs = {
      action: "submit_order",
      amount: 129,
      item: "Atlas Pro",
    };
    const validHash = computeActionHash({
      amount: 129,
      args: originalArgs,
      tool: "browser",
    });

    const grant = globalApprovalGrantStore.createGrant({
      actionHash: validHash,
      executionId: "exec-1",
      orgId: "org-alpha",
      sessionId: "session-1",
      userId: "user-1",
    });

    // Attempt consumption with tampered hash
    const tamperedHash = computeActionHash({
      amount: 999,
      args: { ...originalArgs, amount: 999 },
      tool: "browser",
    });

    const tamperedResult = globalApprovalGrantStore.verifyAndConsume(grant.id, {
      actionHash: tamperedHash,
      orgId: "org-alpha",
      sessionId: "session-1",
      userId: "user-1",
    });

    if (tamperedResult.valid) {
      throw new Error(
        "Security breach: Tampered arguments were accepted by approval store!"
      );
    }

    // Cross-tenant attack check
    const crossTenantResult = globalApprovalGrantStore.verifyAndConsume(
      grant.id,
      {
        actionHash: validHash,
        orgId: "org-beta-attacker",
        sessionId: "session-1",
        userId: "user-1",
      }
    );

    if (crossTenantResult.valid) {
      throw new Error(
        "Security breach: Cross-tenant approval grant consumption succeeded!"
      );
    }

    // Cross-user attack check
    const crossUserResult = globalApprovalGrantStore.verifyAndConsume(
      grant.id,
      {
        actionHash: validHash,
        orgId: "org-alpha",
        sessionId: "session-1",
        userId: "user-attacker",
      }
    );

    if (crossUserResult.valid) {
      throw new Error(
        "Security breach: Cross-user approval grant consumption succeeded!"
      );
    }

    // 3. Test Valid Execution Consumes Grant
    const validResult = globalApprovalGrantStore.verifyAndConsume(grant.id, {
      actionHash: validHash,
      orgId: "org-alpha",
      sessionId: "session-1",
      userId: "user-1",
    });

    if (!validResult.valid) {
      throw new Error(`Valid approved execution failed: ${validResult.error}`);
    }

    // 4. Test Replay Attack (Using consumed grant a second time)
    const replayResult = globalApprovalGrantStore.verifyAndConsume(grant.id, {
      actionHash: validHash,
      orgId: "org-alpha",
      sessionId: "session-1",
      userId: "user-1",
    });

    if (replayResult.valid) {
      throw new Error("Security breach: Consumed approval grant was replayed!");
    }

    return {
      category: "Security",
      durationMs: Date.now() - start,
      id: "approval_security",
      message:
        "Approval risk evaluation, tampering protection, multi-tenant isolation, and anti-replay verified",
      required: true,
      status: "pass",
    };
  } catch (error: any) {
    return {
      category: "Security",
      durationMs: Date.now() - start,
      failureCode: "APPROVAL_SECURITY_FAILURE",
      id: "approval_security",
      message: error.message,
      required: true,
      status: "fail",
    };
  }
}
