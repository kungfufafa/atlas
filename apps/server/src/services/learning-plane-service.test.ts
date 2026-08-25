import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { LearningPlaneService } from "./learning-plane-service";

describe("LearningPlaneService closed loop", () => {
  test("captures evidence, commits a memory fact, and records retrieval outcome", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "org_1",
      name: "Org",
      slug: "org",
      updatedAt: now,
    });
    const plane = new LearningPlaneService(db);
    const principal = {
      isPlatformAdmin: false,
      orgId: "org_1",
      orgRole: "member" as const,
      userId: "user_1",
    };

    const ingested = await plane.ingestTurn({
      mode: "auto",
      payload: { text: "remember I prefer dark mode" },
      principal,
      runId: "run_1",
      sessionId: "sess_1",
      terminalMessageId: "msg_1",
      userCorrected: true,
    });

    expect(ingested.evidence?.kind).toBe("user_correction");
    expect(ingested.commit?.memoryId).toBeTruthy();
    expect(ingested.candidate?.status).toBe("committed");

    const outcome = await plane.recordRetrievalOutcome({
      commitId: ingested.commit!.id,
      orgId: "org_1",
      retrieved: true,
      subsequentCorrection: false,
    });
    expect(outcome.used).toBe(true);
    expect(outcome.helpful).toBe(true);

    const replay = await plane.ingestTurn({
      mode: "auto",
      payload: { text: "remember I prefer dark mode" },
      principal,
      sessionId: "sess_1",
      terminalMessageId: "msg_1",
      userCorrected: true,
    });
    expect(replay.job?.idempotencyKey).toContain("sess_1:msg_1:");
    expect(replay.commit).toBeNull();
  });

  test("propose mode does not auto-commit facts", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "org_1",
      name: "Org",
      slug: "org",
      updatedAt: now,
    });
    const plane = new LearningPlaneService(db);
    const ingested = await plane.ingestTurn({
      mode: "propose",
      payload: { text: "remember I prefer dark mode" },
      principal: {
        isPlatformAdmin: false,
        orgId: "org_1",
        orgRole: "member",
        userId: "user_1",
      },
      terminalMessageId: "msg_2",
      userCorrected: true,
    });
    expect(ingested.commit).toBeNull();
    expect(ingested.candidate?.status).toBe("proposed");
  });
});
