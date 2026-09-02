import { describe, expect, test } from "bun:test";
import {
  AwaitingApprovalError,
  assertCanonicalPrincipal,
  assertOutboundEnvelope,
  captureEvidence,
  closeLearningLoop,
  evaluateLearningCandidate,
  hashApprovalArgs,
  PrincipalRequiredError,
  revalidateOutboundAllowlist,
} from "@atlas/core";
import { LOCAL_CLIENT_USER_ID } from "@atlas/core/local-auth";
import { createInMemoryDatabaseAdapter, seedDatabase } from "@atlas/db";
import { ExecutionPlaneService } from "../apps/server/src/services/execution-plane-service";
import { IdentityService } from "../apps/server/src/services/identity-service";
import { LearningPlaneService } from "../apps/server/src/services/learning-plane-service";
import { resolveToolsFromStorage } from "../apps/server/src/services/tool-resolver";

async function seedOrg() {
  const db = createInMemoryDatabaseAdapter();
  await seedDatabase(db);
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: "org_1",
    name: "Org",
    slug: "org-1",
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
  await db.upsertOrgMember({
    createdAt: now,
    orgId: "org_1",
    role: "member",
    userId: "user_1",
  });
  return db;
}

describe("critical paths", () => {
  test("identity resolution", async () => {
    const db = await seedOrg();
    const identity = new IdentityService(db);
    await identity.bindExternalPrincipal({
      channel: "telegram",
      channelUserId: "42",
      orgId: "org_1",
      userId: "user_1",
    });
    const principal = await identity.resolve({
      channel: "telegram",
      channelUserId: "42",
      orgId: "org_1",
    });
    expect(principal.userId).toBe("user_1");
    expect(() =>
      assertCanonicalPrincipal({
        orgId: "org_1",
        orgRole: "member",
        userId: LOCAL_CLIENT_USER_ID,
      })
    ).toThrow(PrincipalRequiredError);
  });

  test("tool resolver memory_search + search_chats", async () => {
    const db = await seedOrg();
    const tools = await db.listTools();
    const resolved = await resolveToolsFromStorage(tools, db);
    const names = new Set(resolved.map((tool) => tool.name));
    expect(names.has("memory_search")).toBe(true);
    expect(names.has("search_chats")).toBe(true);
  });

  test("approval resume", async () => {
    const db = await seedOrg();
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
    const args = { amount: 10 };
    await plane.pauseForApproval({
      approvalId: "appr_1",
      args,
      checkpoint: {
        remainingToolCalls: [
          { arguments: args, id: "call_1", name: "checkout" },
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
      sessionId: "sess_1",
    });
    expect(decided.record.status).toBe("approved");
    expect(decided.grantId).toBeTruthy();
    expect(hashApprovalArgs("checkout", args).length).toBeGreaterThan(8);
    expect(
      new AwaitingApprovalError("appr_1", {
        args,
        runId: run.id,
        stepIndex: 0,
        toolCallId: "call_1",
        toolName: "checkout",
      }).code
    ).toBe("AWAITING_APPROVAL");
  });

  test("learning closed-loop", async () => {
    const db = await seedOrg();
    const plane = new LearningPlaneService(db);
    const principal = {
      isPlatformAdmin: false,
      orgId: "org_1",
      orgRole: "member" as const,
      userId: "user_1",
    };
    const evidence = captureEvidence({
      id: "ev_1",
      kind: "user_correction",
      payload: { text: "remember my name is Ada" },
      principal,
    });
    const candidate = evaluateLearningCandidate({
      evidence: [evidence],
      id: "cand_1",
      orgId: "org_1",
    });
    const ingested = await plane.ingestTurn({
      mode: "auto",
      payload: { text: "remember my name is Ada" },
      principal,
      terminalMessageId: "msg_1",
      userCorrected: true,
    });
    expect(ingested.commit).toBeTruthy();
    const outcome = closeLearningLoop({
      commit: ingested.commit!,
      id: "out_1",
      retrieved: true,
      subsequentCorrection: false,
    });
    expect(outcome.used).toBe(true);
    expect(candidate?.evidenceIds.length).toBe(1);
  });

  test("durable run", async () => {
    const db = await seedOrg();
    const plane = new ExecutionPlaneService(db);
    const run = await plane.startChatRun({
      idempotencyKey: "idem-1",
      principal: {
        isPlatformAdmin: false,
        orgId: "org_1",
        orgRole: "member",
        userId: "user_1",
      },
      sessionId: "sess_1",
    });
    const replay = await plane.startChatRun({
      idempotencyKey: "idem-1",
      principal: {
        isPlatformAdmin: false,
        orgId: "org_1",
        orgRole: "member",
        userId: "user_1",
      },
      sessionId: "sess_1",
    });
    expect(replay.id).toBe(run.id);
  });

  test("outbound envelope with principal", () => {
    const envelope = assertOutboundEnvelope({
      orgId: "org_1",
      replyTarget: { channel: "telegram", telegram: { chatId: 42 } },
      text: "hello",
    });
    revalidateOutboundAllowlist(envelope, {
      accessMode: "pairing",
      pairedUserIds: [42],
    });
    expect(envelope.orgId).toBe("org_1");
  });
});
