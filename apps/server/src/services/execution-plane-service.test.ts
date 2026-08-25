import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { ExecutionPlaneService } from "./execution-plane-service";

describe("ExecutionPlaneService", () => {
  test("pauses for approval and resumes the exact step", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "org_1",
      name: "Org",
      slug: "org",
      updatedAt: now,
    });
    await db.createUser({
      createdAt: now,
      email: "ada@example.com",
      id: "user_1",
      name: "Ada",
      passwordHash: "x",
      updatedAt: now,
    });
    const plane = new ExecutionPlaneService(db);
    const principal = {
      isPlatformAdmin: false,
      orgId: "org_1",
      orgRole: "member" as const,
      userId: "user_1",
    };
    const run = await plane.startChatRun({
      principal,
      sessionId: "sess_1",
    });
    await plane.pauseForApproval({
      approvalId: "appr_1",
      args: { amount: 5 },
      checkpoint: {
        remainingToolCalls: [
          { arguments: { amount: 5 }, id: "call_1", name: "checkout" },
        ],
        resumeStepIndex: 0,
      },
      principal,
      runId: run.id,
      sessionId: "sess_1",
      stepIndex: 0,
      toolCallId: "call_1",
      toolName: "checkout",
    });
    const decided = await plane.decide({
      approvalId: "appr_1",
      decision: "approved",
      principal,
    });
    expect(decided.record.status).toBe("approved");
    expect(decided.grantId).toBeTruthy();
    const stored = await db.getExecutionRun(run.id);
    expect(stored?.status).toBe("running");
  });

  test("claims an automation run with lease + principal and skips overlap", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "org_1",
      name: "Org",
      slug: "org",
      updatedAt: now,
    });
    await db.createUser({
      createdAt: now,
      email: "ada@example.com",
      id: "user_1",
      name: "Ada",
      passwordHash: "x",
      updatedAt: now,
    });
    const plane = new ExecutionPlaneService(db);
    const principal = {
      isPlatformAdmin: false,
      orgId: "org_1",
      orgRole: "member" as const,
      userId: "user_1",
    };
    const first = await plane.startAutomationRun({
      automationId: "auto_1",
      fireId: "tick-1",
      principal,
    });
    expect(first.skipped).toBe(false);
    expect(first.run?.principalUserId).toBe("user_1");
    expect(first.run?.leaseOwner).toBeTruthy();

    const second = await plane.startAutomationRun({
      automationId: "auto_1",
      fireId: "tick-2",
      principal,
    });
    expect(second.skipped).toBe(true);
    expect(second.error).toMatch(/already running/);
  });

  test("live same-fire replay skips instead of executing again", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "org_1",
      name: "Org",
      slug: "org",
      updatedAt: now,
    });
    await db.createUser({
      createdAt: now,
      email: "ada@example.com",
      id: "user_1",
      name: "Ada",
      passwordHash: "x",
      updatedAt: now,
    });
    const plane = new ExecutionPlaneService(db);
    const principal = {
      isPlatformAdmin: false,
      orgId: "org_1",
      orgRole: "member" as const,
      userId: "user_1",
    };
    const first = await plane.startAutomationRun({
      automationId: "auto_1",
      fireId: "tick-1",
      principal,
    });
    const second = await plane.startAutomationRun({
      automationId: "auto_1",
      fireId: "tick-1",
      principal,
    });
    expect(first.replay).toBe(false);
    expect(first.skipped).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.skipped).toBe(true);
    expect(second.run?.id).toBe(first.run?.id);
  });

  test("stale complete after lease steal is refused", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "org_1",
      name: "Org",
      slug: "org",
      updatedAt: now,
    });
    await db.createUser({
      createdAt: now,
      email: "ada@example.com",
      id: "user_1",
      name: "Ada",
      passwordHash: "x",
      updatedAt: now,
    });
    const plane = new ExecutionPlaneService(db);
    const principal = {
      isPlatformAdmin: false,
      orgId: "org_1",
      orgRole: "member" as const,
      userId: "user_1",
    };
    const first = await plane.startAutomationRun({
      automationId: "auto_1",
      fireId: "tick-1",
      principal,
    });
    const stolenOwner = first.run?.leaseOwner ?? "";
    await db.upsertExecutionRun({
      ...((await db.getExecutionRun(first.run!.id)) as never),
      leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const recovered = await plane.startAutomationRun({
      automationId: "auto_1",
      fireId: "tick-1",
      principal,
    });
    expect(recovered.skipped).toBe(false);
    expect(recovered.run?.leaseOwner).not.toBe(stolenOwner);
    await expect(
      plane.complete(first.run!.id, "completed", stolenOwner)
    ).rejects.toThrow(/stolen/);
  });
});
