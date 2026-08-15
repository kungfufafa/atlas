import { describe, expect, it } from "bun:test";
import { globalApprovalGrantStore } from "./approval-grant";
import type { ToolDefinition } from "./contract";
import { computeActionHash, evaluateActionRisk } from "./risk-engine";
import { executeProtectedTool } from "./tools/execution";

describe("Action Risk Engine & Server Approval Enforcement", () => {
  it("Layer 1 Deterministic Classification: purchase and checkout are always CRITICAL", () => {
    const risk = evaluateActionRisk("checkout", {
      amount: 129,
      product: "Atlas Pro",
    });
    expect(risk.riskLevel).toBe("CRITICAL");
    expect(risk.approval).toBe("always");
    expect(risk.requiresApproval).toBe(true);
    expect(risk.actionClass).toBe("PURCHASE");
  });

  it("Layer 1 Deterministic Classification: external email is always HIGH", () => {
    const risk = evaluateActionRisk("email", {
      subject: "Contract",
      to: "partner@example.com",
    });
    expect(risk.riskLevel).toBe("HIGH");
    expect(risk.approval).toBe("always");
    expect(risk.requiresApproval).toBe(true);
  });

  it("Read-only tools are LOW risk and never require approval", () => {
    const riskWeb = evaluateActionRisk("web_search", {
      query: "Bun latest release",
    });
    expect(riskWeb.riskLevel).toBe("LOW");
    expect(riskWeb.approval).toBe("never");
    expect(riskWeb.requiresApproval).toBe(false);
  });

  it("Action Hash binds cryptographically to exact parameters", () => {
    const hash1 = computeActionHash({
      args: { amount: 129, product: "Atlas Pro" },
      tool: "checkout",
    });

    const hash2 = computeActionHash({
      args: { amount: 129, product: "Atlas Pro" },
      tool: "checkout",
    });

    const hashTampered = computeActionHash({
      args: { amount: 1290, product: "Atlas Pro" },
      tool: "checkout",
    });

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hashTampered);
  });

  it("Server Enforcement: Blocks direct tool execution when approval grant is missing (API Bypass)", async () => {
    const purchaseTool: ToolDefinition = {
      description: "Place order",
      name: "checkout",
      parameters: { type: "object" },
      run: async () => ({ orderId: "ORD-999", status: "order_placed" }),
    };

    // Direct execution attempt without grantId
    const result = await executeProtectedTool(
      purchaseTool,
      { amount: 129, product: "Atlas Pro" },
      { orgId: "org-1", userId: "user-1" }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(result.error?.message).toContain("APPROVAL_REQUIRED");
  });

  it("Server Enforcement: Allows execution with valid matching grant and consumes single-use", async () => {
    const purchaseTool: ToolDefinition = {
      description: "Place order",
      name: "checkout",
      parameters: { type: "object" },
      run: async () => ({ orderId: "ORD-123", status: "order_placed" }),
    };

    const actionHash = computeActionHash({
      args: { amount: 129, product: "Atlas Pro" },
      tool: "checkout",
    });

    const grant = globalApprovalGrantStore.createGrant({
      actionHash,
      executionId: "exec-1",
      orgId: "org-1",
      sessionId: "sess-1",
      userId: "user-1",
    });

    // First attempt with valid grant -> SUCCEEDS
    const res1 = await executeProtectedTool(
      purchaseTool,
      { amount: 129, product: "Atlas Pro" },
      { approvalGrantId: grant.id, orgId: "org-1", userId: "user-1" } as any
    );

    expect(res1.success).toBe(true);
    expect((res1.data as any)?.orderId).toBe("ORD-123");

    // Second attempt (Replay) with same grant -> BLOCKED
    const res2 = await executeProtectedTool(
      purchaseTool,
      { amount: 129, product: "Atlas Pro" },
      { approvalGrantId: grant.id, orgId: "org-1", userId: "user-1" } as any
    );

    expect(res2.success).toBe(false);
    expect(res2.error?.message).toContain("already been consumed");
  });

  it("Server Enforcement: Blocks execution when parameters are tampered after approval", async () => {
    const purchaseTool: ToolDefinition = {
      description: "Place order",
      name: "checkout",
      parameters: { type: "object" },
      run: async () => ({ status: "order_placed" }),
    };

    // User approved $129
    const approvedHash = computeActionHash({
      args: { amount: 129, product: "Atlas Pro" },
      tool: "checkout",
    });

    const grant = globalApprovalGrantStore.createGrant({
      actionHash: approvedHash,
      executionId: "exec-2",
      orgId: "org-1",
      sessionId: "sess-1",
      userId: "user-1",
    });

    // Adversary attempts $1290
    const tamperedRes = await executeProtectedTool(
      purchaseTool,
      { amount: 1290, product: "Atlas Pro" },
      { approvalGrantId: grant.id, orgId: "org-1", userId: "user-1" } as any
    );

    expect(tamperedRes.success).toBe(false);
    expect(tamperedRes.error?.message).toContain("tampering blocked");
  });

  it("Multi-Tenant Security: Blocks cross-tenant / cross-user approval grant reuse", async () => {
    const purchaseTool: ToolDefinition = {
      description: "Place order",
      name: "checkout",
      parameters: { type: "object" },
      run: async () => ({ status: "order_placed" }),
    };

    const actionHash = computeActionHash({
      args: { amount: 129, product: "Atlas Pro" },
      tool: "checkout",
    });

    // User A in Org A gets grant
    const grant = globalApprovalGrantStore.createGrant({
      actionHash,
      executionId: "exec-3",
      orgId: "org-a",
      sessionId: "sess-a",
      userId: "user-a",
    });

    // User B attempts to use User A's grant
    const crossUserRes = await executeProtectedTool(
      purchaseTool,
      { amount: 129, product: "Atlas Pro" },
      { approvalGrantId: grant.id, orgId: "org-a", userId: "user-b" } as any
    );
    expect(crossUserRes.success).toBe(false);
    expect(crossUserRes.error?.message).toContain("different user");

    // Org B attempts to use Org A's grant
    const crossOrgRes = await executeProtectedTool(
      purchaseTool,
      { amount: 129, product: "Atlas Pro" },
      { approvalGrantId: grant.id, orgId: "org-b", userId: "user-a" } as any
    );
    expect(crossOrgRes.success).toBe(false);
    expect(crossOrgRes.error?.message).toContain("Cross-tenant");
  });
});
