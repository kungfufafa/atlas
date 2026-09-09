import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AgentService } from "./agent-service";
import { loadSessionHistory } from "./session-persistence";

const ORG_ID = "org_task_session";
const PROFILE_ID = "profile_task";
const USER_ID = "user_task_owner";

async function createTaskService() {
  const db = createInMemoryDatabaseAdapter();
  const now = new Date().toISOString();

  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Task Session",
    slug: "task-session",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "owner@example.com",
    id: USER_ID,
    passwordHash: "unused",
    updatedAt: now,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role: "member",
    userId: USER_ID,
  });
  await db.upsertProfile({
    createdAt: now,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Task Agent",
    orgId: ORG_ID,
    systemPrompt: "Be concise.",
    updatedAt: now,
  });

  return { db, now, service: new AgentService(null, null, db) };
}

describe("AgentService task session seeding", () => {
  test("rebuilds the live session after seeding a completed run into a new task chat", async () => {
    const { db, now, service } = await createTaskService();
    await db.upsertTask({
      createdAt: now,
      createdByUserId: USER_ID,
      description: "",
      id: "task_seed_new",
      orgId: ORG_ID,
      position: 0,
      profileId: PROFILE_ID,
      prompt: "Summarize last week's incidents",
      status: "done",
      title: "Incident digest",
      updatedAt: now,
    });
    await db.insertTaskRun({
      completedAt: now,
      error: null,
      id: "run_seed_new",
      output: "Two sev-2 incidents, both resolved.",
      startedAt: now,
      status: "completed",
      taskId: "task_seed_new",
    });

    const seeded = await service.getTaskChatMessages("task_seed_new", ORG_ID, {
      userId: USER_ID,
    });

    expect(seeded?.messages).toEqual([
      { content: "Summarize last week's incidents", role: "user" },
      { content: "Two sev-2 incidents, both resolved.", role: "assistant" },
    ]);

    const live = await service.resolveSession(ORG_ID, seeded!.sessionId, {
      userId: USER_ID,
    });

    expect(live?.getHistory()).toEqual(seeded?.messages);
    expect(await loadSessionHistory(db, seeded!.sessionId)).toEqual(
      seeded?.messages
    );
  });

  test("rebuilds the live session after a clear reseeds the last task run", async () => {
    const { db, now, service } = await createTaskService();
    const sessionId = await service.createSession(
      ORG_ID,
      "task",
      PROFILE_ID,
      USER_ID,
      { orgRole: "member" }
    );
    await db.upsertTask({
      createdAt: now,
      createdByUserId: USER_ID,
      description: "",
      id: "task_seed_clear",
      orgId: ORG_ID,
      position: 0,
      profileId: PROFILE_ID,
      prompt: "Draft the release notes",
      sessionId,
      status: "done",
      title: "Release notes",
      updatedAt: now,
    });
    await db.insertTaskRun({
      completedAt: now,
      error: null,
      id: "run_seed_clear",
      output: "Shipped compaction archives and provider metadata.",
      startedAt: now,
      status: "completed",
      taskId: "task_seed_clear",
    });

    const liveBeforeClear = await service.resolveSession(ORG_ID, sessionId, {
      userId: USER_ID,
    });
    expect(liveBeforeClear).not.toBeNull();

    expect(
      await service.clearSession(ORG_ID, sessionId, { userId: USER_ID })
    ).toBe(true);

    const seeded = await service.getTaskChatMessages(
      "task_seed_clear",
      ORG_ID,
      {
        userId: USER_ID,
      }
    );

    expect(seeded?.sessionId).toBe(sessionId);
    expect(seeded?.messages).toEqual([
      { content: "Draft the release notes", role: "user" },
      {
        content: "Shipped compaction archives and provider metadata.",
        role: "assistant",
      },
    ]);

    const live = await service.resolveSession(ORG_ID, sessionId, {
      userId: USER_ID,
    });
    expect(live?.getHistory()).toEqual(seeded?.messages);
  });
});
