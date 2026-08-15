import { describe, expect, it } from "bun:test";
import {
  type Artifact,
  type Citation,
  computeActionHash,
  createArtifactRevision,
  createExecutionAttempt,
  evaluateActionRisk,
  executeProtectedTool,
  globalApprovalGrantStore,
  overrideExecutionAttempt,
  ResearchEngine,
  resolveArtifactOrDisambiguate,
  resolveExecutionPolicyWithSource,
  type SourceItem,
  validateCitationIntegrity,
} from "../packages/core/src/index";

describe("Atlas Golden Robustness & Security E2E Suite (Tests A through P)", () => {
  // -------------------------------------------------------------
  // TEST A: POLICY AUTO RESOLUTION
  // -------------------------------------------------------------
  it("TEST A: Policy Auto - Resolves math prompt to Fast with compact display label", () => {
    const res = resolveExecutionPolicyWithSource({
      prompt: "What is 1500 * 12?",
      userPolicy: "auto",
    });

    expect(res.policy).toBe("fast");
    expect(res.source).toBe("auto");
    expect(res.displayLabel).toBe("Auto: Fast");
  });

  // -------------------------------------------------------------
  // TEST B: POLICY OVERRIDE LIFECYCLE
  // -------------------------------------------------------------
  it("TEST B: Policy Override - Cancels old attempt, creates new attempt, no duplicate responses", () => {
    const prompt = "Research vector databases";
    const initialRes = resolveExecutionPolicyWithSource({
      prompt,
      userPolicy: "auto",
    });

    const initialAttempt = createExecutionAttempt({
      messageId: "msg-golden-1",
      policyResolution: initialRes,
      requestedPolicy: "auto",
      sessionId: "session-golden-1",
    });

    expect(initialAttempt.status).toBe("queued");
    expect(initialAttempt.resolvedPolicy).toBe("research");

    // User overrides policy to Agent
    const { cancelledAttempt, newAttempt } = overrideExecutionAttempt(
      initialAttempt,
      "agent"
    );

    expect(cancelledAttempt.status).toBe("cancelled");
    expect(cancelledAttempt.completedAt).toBeDefined();

    expect(newAttempt.status).toBe("queued");
    expect(newAttempt.parentAttemptId).toBe(initialAttempt.id);
    expect(newAttempt.resolvedPolicy).toBe("agent");
    expect(newAttempt.policySource).toBe("override");
    expect(newAttempt.messageId).toBe(initialAttempt.messageId);
    expect(newAttempt.sessionId).toBe(initialAttempt.sessionId);
  });

  // -------------------------------------------------------------
  // TEST C: ARTIFACT RESOLUTION
  // -------------------------------------------------------------
  it("TEST C: Artifact Resolution - Natural follow-up 'edit slide 2' resolves presentation", () => {
    const pptx: Artifact = {
      createdAt: new Date().toISOString(),
      filename: "atlas_overview.pptx",
      id: "art-pptx-1",
      metadata: { slideCount: 3 },
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      path: "artifacts/atlas_overview.pptx",
      revision: 1,
      sessionId: "session-1",
      size: 15_000,
      type: "presentation",
    };

    const xlsx: Artifact = {
      createdAt: new Date().toISOString(),
      filename: "sales_report.xlsx",
      id: "art-xlsx-1",
      metadata: { sheetCount: 2 },
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      path: "artifacts/sales_report.xlsx",
      revision: 1,
      sessionId: "session-1",
      size: 12_000,
      type: "spreadsheet",
    };

    const res = resolveArtifactOrDisambiguate({
      artifacts: [pptx, xlsx],
      prompt: "Make slide 2 simpler",
      sessionId: "session-1",
    });

    expect(res.disambiguationRequired).toBe(false);
    expect(res.resolvedArtifact?.id).toBe("art-pptx-1");
    expect(res.topConfidence).toBeGreaterThanOrEqual(0.85);
  });

  // -------------------------------------------------------------
  // TEST D: ARTIFACT AMBIGUITY GUARD (ZERO SPECULATIVE MUTATION)
  // -------------------------------------------------------------
  it("TEST D: Artifact Ambiguity Guard - Prompts targeted clarification without mutation", () => {
    const pptx: Artifact = {
      createdAt: new Date().toISOString(),
      filename: "q3_deck.pptx",
      id: "art-pptx-2",
      metadata: { slideCount: 5 },
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      path: "artifacts/q3_deck.pptx",
      revision: 1,
      sessionId: "session-2",
      size: 15_000,
      type: "presentation",
    };

    const xlsx: Artifact = {
      createdAt: new Date().toISOString(),
      filename: "sales.xlsx",
      id: "art-xlsx-2",
      metadata: { sheetCount: 3 },
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      path: "artifacts/sales.xlsx",
      revision: 1,
      sessionId: "session-2",
      size: 12_000,
      type: "spreadsheet",
    };

    const res = resolveArtifactOrDisambiguate({
      artifacts: [pptx, xlsx],
      prompt: "Edit page 2",
      sessionId: "session-2",
    });

    expect(res.disambiguationRequired).toBe(true);
    expect(res.resolvedArtifact).toBeUndefined();
    expect(res.clarificationMessage).toContain(
      "Which artifact would you like to edit?"
    );
    expect(res.options?.length).toBe(2);
  });

  // -------------------------------------------------------------
  // TEST E: ARTIFACT LINEAGE
  // -------------------------------------------------------------
  it("TEST E: Artifact Lineage - Correct revision chaining (v1 -> v2 -> v3)", () => {
    const v1: Artifact = {
      createdAt: new Date().toISOString(),
      filename: "deck.pptx",
      id: "art-v1",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      path: "artifacts/deck.pptx",
      revision: 1,
      sessionId: "sess-lineage",
      size: 10_000,
      type: "presentation",
    };

    const v2 = createArtifactRevision(
      v1,
      "art-v2",
      "artifacts/deck_v2.pptx",
      12_000
    );
    expect(v2.id).toBe("art-v2");
    expect(v2.parentArtifactId).toBe("art-v1");
    expect(v2.rootArtifactId).toBe("art-v1");
    expect(v2.revision).toBe(2);

    const v3 = createArtifactRevision(
      v2,
      "art-v3",
      "artifacts/deck_v3.pptx",
      14_000
    );
    expect(v3.id).toBe("art-v3");
    expect(v3.parentArtifactId).toBe("art-v2");
    expect(v3.rootArtifactId).toBe("art-v1");
    expect(v3.revision).toBe(3);
  });

  // -------------------------------------------------------------
  // TEST F: CITATION INTEGRITY
  // -------------------------------------------------------------
  it("TEST F: Citation Integrity - Validates Claim -> Citation -> Evidence -> Source mapping", () => {
    const sources: SourceItem[] = [
      { id: "source-1", title: "Source 1", url: "https://example.com/1" },
    ];
    const evidence = [
      {
        claim: "Claim 1",
        id: "ev-1",
        relevanceScore: 0.9,
        snippet: "Snippet 1",
        sourceTitle: "Source 1",
        sourceUrl: "https://example.com/1",
      },
    ];
    const validCitation: Citation = {
      evidenceIds: ["ev-1"],
      id: "cite-1",
      sourceId: "source-1",
    };

    const validCheck = validateCitationIntegrity(
      [validCitation],
      evidence,
      sources
    );
    expect(validCheck.valid).toBe(true);

    const orphanCitation: Citation = {
      evidenceIds: ["ev-missing"],
      id: "cite-orphan",
      sourceId: "source-missing",
    };
    const badCheck = validateCitationIntegrity(
      [orphanCitation],
      evidence,
      sources
    );
    expect(badCheck.valid).toBe(false);
  });

  // -------------------------------------------------------------
  // TEST G: RESEARCH DELTA
  // -------------------------------------------------------------
  it("TEST G: Research Delta - Reuses existing evidence and creates updated session revision", async () => {
    const engine = new ResearchEngine();
    const round1 = await engine.executeResearch("OpenAI vs Anthropic");
    expect(round1.researchSession?.revision).toBe(1);

    const round2 = await engine.executeResearch("Add Gemini", {
      focusAreas: ["Gemini multimodal benchmarks"],
      priorSession: round1.researchSession,
    });

    expect(round2.researchSession?.revision).toBe(2);
    expect(round2.researchSession?.parentRevisionId).toBe(
      round1.researchSession?.id
    );
    expect(round2.evidence.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------
  // TEST H: READ-ONLY ACTION
  // -------------------------------------------------------------
  it("TEST H: Read-Only Action - Read/search actions execute without approval requirement", async () => {
    const readTool = {
      description: "Search web",
      name: "web_search",
      parameters: { type: "object" },
      run: async () => ({ results: ["result 1"] }),
    };

    const res = await executeProtectedTool(
      readTool,
      { query: "Atlas AI" },
      { orgId: "org-1", userId: "user-1" }
    );

    expect(res.success).toBe(true);
    expect((res.data as any)?.results?.length).toBe(1);
  });

  // -------------------------------------------------------------
  // TEST I: CRITICAL ACTION
  // -------------------------------------------------------------
  it("TEST I: Critical Action - Purchase/checkout evaluates to CRITICAL and requires approval", () => {
    const risk = evaluateActionRisk("checkout", {
      amount: 129,
      product: "Atlas Pro",
    });
    expect(risk.riskLevel).toBe("CRITICAL");
    expect(risk.requiresApproval).toBe(true);
    expect(risk.approval).toBe("always");
  });

  // -------------------------------------------------------------
  // TEST J: API APPROVAL BYPASS
  // -------------------------------------------------------------
  it("TEST J: API Approval Bypass - Direct execution without approval grant is blocked server-side", async () => {
    const orderTool = {
      description: "Submit Order",
      name: "checkout",
      parameters: { type: "object" },
      run: async () => ({ orderId: "ORD-BYPASS" }),
    };

    const res = await executeProtectedTool(
      orderTool,
      { amount: 129, product: "Atlas Pro" },
      { orgId: "org-1", userId: "user-1" }
    );

    expect(res.success).toBe(false);
    expect(res.error?.code).toBe("PERMISSION_DENIED");
    expect(res.error?.message).toContain("APPROVAL_REQUIRED");
  });

  // -------------------------------------------------------------
  // TEST K: TAMPERED APPROVAL
  // -------------------------------------------------------------
  it("TEST K: Tampered Approval - Changing parameters after approval invalidates grant", async () => {
    const orderTool = {
      description: "Submit Order",
      name: "checkout",
      parameters: { type: "object" },
      run: async () => ({ orderId: "ORD-TAMPER" }),
    };

    // User approved $129
    const approvedHash = computeActionHash({
      args: { amount: 129, product: "Atlas Pro" },
      tool: "checkout",
    });

    const grant = globalApprovalGrantStore.createGrant({
      actionHash: approvedHash,
      executionId: "exec-k",
      orgId: "org-1",
      sessionId: "sess-k",
      userId: "user-1",
    });

    // Adversary executes with $1290
    const res = await executeProtectedTool(
      orderTool,
      { amount: 1290, product: "Atlas Pro" },
      { approvalGrantId: grant.id, orgId: "org-1", userId: "user-1" } as any
    );

    expect(res.success).toBe(false);
    expect(res.error?.message).toContain("tampering blocked");
  });

  // -------------------------------------------------------------
  // TEST L: DOUBLE CONFIRM SINGLE CONSUMPTION
  // -------------------------------------------------------------
  it("TEST L: Double Confirm - Single-use consumption prevents duplicate action execution", async () => {
    let executionCounter = 0;
    const orderTool = {
      description: "Submit Order",
      name: "checkout",
      parameters: { type: "object" },
      run: async () => {
        executionCounter += 1;
        return { orderId: "ORD-DOUBLE" };
      },
    };

    const actionHash = computeActionHash({
      args: { amount: 129, product: "Atlas Pro" },
      tool: "checkout",
    });

    const grant = globalApprovalGrantStore.createGrant({
      actionHash,
      executionId: "exec-l",
      orgId: "org-1",
      sessionId: "sess-l",
      userId: "user-1",
    });

    // First click: succeeds
    const res1 = await executeProtectedTool(
      orderTool,
      { amount: 129, product: "Atlas Pro" },
      { approvalGrantId: grant.id, orgId: "org-1", userId: "user-1" } as any
    );
    expect(res1.success).toBe(true);
    expect(executionCounter).toBe(1);

    // Second click (replay): blocked
    const res2 = await executeProtectedTool(
      orderTool,
      { amount: 129, product: "Atlas Pro" },
      { approvalGrantId: grant.id, orgId: "org-1", userId: "user-1" } as any
    );
    expect(res2.success).toBe(false);
    expect(executionCounter).toBe(1); // Still exactly 1 side effect!
  });

  // -------------------------------------------------------------
  // TEST M: CANCELLATION & CLEANUP
  // -------------------------------------------------------------
  it("TEST M: Cancellation - Aborting execution terminates cleanly with CANCELLED state", async () => {
    const abortController = new AbortController();

    const longTool = {
      description: "Long running job",
      name: "long_job",
      parameters: { type: "object" },
      run: async (_input: unknown, context: any) => {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 5000);
          context?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("Tool execution aborted by user"));
          });
        });
        return { done: true };
      },
    };

    // Abort after 50ms
    setTimeout(() => {
      abortController.abort();
    }, 50);

    const res = await executeProtectedTool(
      longTool,
      {},
      { orgId: "org-1", signal: abortController.signal, userId: "user-1" }
    );

    expect(res.success).toBe(false);
    expect(res.error?.code).toBe("CANCELLED");
  });

  // -------------------------------------------------------------
  // TEST N: CANCEL + FOLLOW-UP
  // -------------------------------------------------------------
  it("TEST N: Cancel + Follow-up - Session remains immediately usable after cancellation", async () => {
    // 1. Cancelled attempt
    const abortController = new AbortController();
    abortController.abort();

    const tool = {
      description: "Tool",
      name: "calculator",
      parameters: { type: "object" },
      run: async () => ({ value: 42 }),
    };

    const cancelRes = await executeProtectedTool(
      tool,
      {},
      { orgId: "org-1", signal: abortController.signal, userId: "user-1" }
    );
    expect(cancelRes.success).toBe(false);

    // 2. Immediate follow-up attempt in same session with fresh signal
    const followUpController = new AbortController();
    const followUpRes = await executeProtectedTool(
      tool,
      {},
      { orgId: "org-1", signal: followUpController.signal, userId: "user-1" }
    );

    expect(followUpRes.success).toBe(true);
    expect((followUpRes.data as any)?.value).toBe(42);
  });

  // -------------------------------------------------------------
  // TEST O: RETRY IDEMPOTENCY
  // -------------------------------------------------------------
  it("TEST O: Retry Idempotency - Mutating/destructive actions are not automatically retried", async () => {
    let attempts = 0;
    const deleteTool = {
      description: "Delete files",
      name: "delete_file",
      parameters: { type: "object" },
      run: async () => {
        attempts += 1;
        throw new Error("Network glitch during delete");
      },
    };

    const actionHash = computeActionHash({
      args: { path: "important.txt" },
      tool: "delete_file",
    });

    const grant = globalApprovalGrantStore.createGrant({
      actionHash,
      executionId: "exec-o",
      orgId: "org-1",
      sessionId: "sess-o",
      userId: "user-1",
    });

    const res = await executeProtectedTool(
      deleteTool,
      { path: "important.txt" },
      { approvalGrantId: grant.id, orgId: "org-1", userId: "user-1" } as any
    );

    expect(res.success).toBe(false);
    expect(attempts).toBe(1); // Zero automatic retries for destructive actions!
  });

  // -------------------------------------------------------------
  // TEST P: MULTI-TENANT ISOLATION
  // -------------------------------------------------------------
  it("TEST P: Multi-Tenant - Blocks cross-tenant approval grants, artifacts, and sessions", async () => {
    const secureTool = {
      description: "Secure Action",
      name: "checkout",
      parameters: { type: "object" },
      run: async () => ({ status: "executed" }),
    };

    const actionHash = computeActionHash({
      args: { amount: 50 },
      tool: "checkout",
    });

    // Org 1 grant
    const grant = globalApprovalGrantStore.createGrant({
      actionHash,
      executionId: "exec-p",
      orgId: "org-tenant-1",
      sessionId: "sess-p",
      userId: "user-tenant-1",
    });

    // Org 2 user attempts to execute
    const crossRes = await executeProtectedTool(secureTool, { amount: 50 }, {
      approvalGrantId: grant.id,
      orgId: "org-tenant-2",
      userId: "user-tenant-2",
    } as any);

    expect(crossRes.success).toBe(false);
    expect(crossRes.error?.message).toContain("Cross-tenant");
  });
});
