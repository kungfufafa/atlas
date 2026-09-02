import { describe, expect, test } from "bun:test";
import type { CanonicalPrincipal } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { IdentityService } from "./identity-service";
import { TaskRunner } from "./task-runner";
import { TaskService } from "./task-service";

const ORG_ID = "org_test";
const PROFILE_ID = "profile_default";
const USER_A_ID = "user_task_owner";
const USER_B_ID = "user_task_other";
const PRINCIPAL_A: CanonicalPrincipal = {
  isPlatformAdmin: false,
  orgId: ORG_ID,
  orgRole: "member",
  userId: USER_A_ID,
};
const PRINCIPAL_B: CanonicalPrincipal = {
  isPlatformAdmin: false,
  orgId: ORG_ID,
  orgRole: "member",
  userId: USER_B_ID,
};

async function createTestDb() {
  const db = createInMemoryDatabaseAdapter();
  const now = new Date().toISOString();

  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Test Org",
    slug: "test-org",
    updatedAt: now,
  });

  await db.createUser({
    createdAt: now,
    email: "task-owner@example.com",
    id: USER_A_ID,
    passwordHash: "unused",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "task-other@example.com",
    id: USER_B_ID,
    passwordHash: "unused",
    updatedAt: now,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role: "member",
    userId: USER_A_ID,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role: "member",
    userId: USER_B_ID,
  });

  await db.upsertProfile({
    createdAt: now,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Default Agent",
    orgId: ORG_ID,
    systemPrompt: "",
    updatedAt: now,
  });

  return db;
}

describe("TaskService", () => {
  test("create defaults to backlog with position 0", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    const task = await service.create(
      ORG_ID,
      {
        prompt: "Find top 5 competitors",
        title: "Research competitors",
      },
      undefined,
      undefined,
      USER_A_ID
    );

    expect(task.status).toBe("backlog");
    expect(task.position).toBe(0);
    expect(task.profileId).toBe(PROFILE_ID);
    expect(task.createdByUserId).toBe(USER_A_ID);
    expect((await db.getTask(task.id))?.createdByUserId).toBe(USER_A_ID);
  });

  test("create second task in backlog gets position 1", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    await service.create(ORG_ID, { prompt: "Do first", title: "First" });
    const second = await service.create(ORG_ID, {
      prompt: "Do second",
      title: "Second",
    });

    expect(second.position).toBe(1);
  });

  test("create rejects empty title", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    await expect(
      service.create(ORG_ID, { prompt: "Do work", title: "  " })
    ).rejects.toThrow("Task title is required.");
  });

  test("create rejects unknown profile", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    await expect(
      service.create(
        ORG_ID,
        { prompt: "Do work", title: "Task" },
        "profile_missing"
      )
    ).rejects.toThrow("Profile not found.");
  });

  test("list orders by status then position", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    const first = await service.create(ORG_ID, {
      prompt: "b",
      title: "Backlog B",
    });
    await service.create(ORG_ID, { prompt: "a", title: "Backlog A" });
    await service.update(first.id, ORG_ID, { status: "todo" });

    const tasks = await service.listForOrg(ORG_ID);
    expect(tasks.map((task) => task.title)).toEqual(["Backlog A", "Backlog B"]);
  });

  test("lists tasks only for the active org", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);
    const now = new Date().toISOString();
    const otherOrgId = "org_other";
    const otherProfileId = "profile_other";

    await db.upsertOrganization({
      createdAt: now,
      id: otherOrgId,
      name: "Other Org",
      slug: "other-org",
      updatedAt: now,
    });

    await db.upsertProfile({
      createdAt: now,
      id: otherProfileId,
      isDefault: true,
      isSuper: false,
      model: null,
      name: "Other Bot",
      orgId: otherOrgId,
      systemPrompt: "",
      updatedAt: now,
    });

    const orgTask = await service.create(ORG_ID, {
      prompt: "Run",
      title: "Org task",
    });

    await service.create(otherOrgId, {
      prompt: "Run",
      title: "Other org task",
    });

    const listed = await service.listForOrg(ORG_ID);
    expect(listed.map((entry) => entry.id)).toEqual([orgTask.id]);

    expect(await service.get(orgTask.id, ORG_ID)).not.toBeNull();
    expect(await service.get(orgTask.id, otherOrgId)).toBeNull();
  });

  test("update status backlog to todo appends position in todo column", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    const task = await service.create(ORG_ID, {
      prompt: "work",
      title: "Move me",
    });
    const updated = await service.update(task.id, ORG_ID, { status: "todo" });

    expect(updated.status).toBe("todo");
    expect(updated.position).toBe(0);
  });

  test("update honors explicit position", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    const task = await service.create(ORG_ID, {
      prompt: "work",
      title: "Reorder",
    });
    const updated = await service.update(task.id, ORG_ID, { position: 5 });

    expect(updated.position).toBe(5);
  });

  test("does not let actor B claim actor A's task", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);
    const task = await service.create(
      ORG_ID,
      { prompt: "owned work", title: "Owned task" },
      undefined,
      undefined,
      USER_A_ID
    );

    await expect(
      service.update(
        task.id,
        ORG_ID,
        { status: "in_progress" },
        { principal: PRINCIPAL_B, triggerRun: false }
      )
    ).rejects.toMatchObject({ status: 403 });
    expect((await service.get(task.id))?.status).toBe("backlog");

    const claimed = await service.update(
      task.id,
      ORG_ID,
      { status: "in_progress" },
      { principal: PRINCIPAL_A, triggerRun: false }
    );
    expect(claimed.status).toBe("in_progress");
  });

  test("lets actor A first-claim a legacy task and then rejects actor B", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);
    const legacyTask = await service.create(ORG_ID, {
      prompt: "legacy work",
      title: "Legacy task",
    });
    expect(legacyTask.createdByUserId).toBeNull();

    const claimed = await service.claimForRun(legacyTask.id, PRINCIPAL_A);
    expect(claimed.createdByUserId).toBe(USER_A_ID);
    await expect(
      service.claimForRun(legacyTask.id, PRINCIPAL_B)
    ).rejects.toMatchObject({ status: 403 });
    expect((await db.getTask(legacyTask.id))?.createdByUserId).toBe(USER_A_ID);
  });

  test("update not found throws", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    await expect(
      service.update("task_missing", ORG_ID, { title: "Nope" })
    ).rejects.toThrow("Task not found.");
  });

  test("delete existing task returns true", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    const task = await service.create(ORG_ID, {
      prompt: "work",
      title: "Delete me",
    });
    const deleted = await service.delete(task.id, ORG_ID);

    expect(deleted).toBe(true);
    expect(await service.get(task.id, ORG_ID)).toBeNull();
  });

  test("delete missing task returns false", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    expect(await service.delete("task_missing", ORG_ID)).toBe(false);
  });
});

describe("TaskRunner", () => {
  test("writes completed run records and moves task to done", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    const task = await service.create(
      ORG_ID,
      { prompt: "Say hello", title: "Run task" },
      undefined,
      undefined,
      USER_A_ID
    );

    const agentService = {
      runTaskPrompt: async () => "Hello from task",
    };

    const runner = new TaskRunner(
      service,
      agentService as never,
      new IdentityService(db)
    );
    service.setTaskRunner(runner);
    const result = await runner.run(task.id);

    expect(result.output).toBe("Hello from task");

    const runs = await service.listRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");

    const updated = await service.get(task.id);
    expect(updated?.status).toBe("done");
  });

  test("writes failed run records and moves task to failed", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    const task = await service.create(
      ORG_ID,
      { prompt: "Fail please", title: "Failing task" },
      undefined,
      undefined,
      USER_A_ID
    );

    const agentService = {
      runTaskPrompt: async () => {
        throw new Error("Provider offline");
      },
    };

    const runner = new TaskRunner(
      service,
      agentService as never,
      new IdentityService(db)
    );
    const result = await runner.run(task.id);

    expect(result.error).toBe("Provider offline");

    const runs = await service.listRuns(task.id);
    expect(runs[0]?.status).toBe("failed");

    const updated = await service.get(task.id);
    expect(updated?.status).toBe("failed");
  });

  test("skips duplicate run on same task", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    const task = await service.create(
      ORG_ID,
      { prompt: "Run once", title: "Concurrent task" },
      undefined,
      undefined,
      USER_A_ID
    );

    let releasePrompt!: () => void;
    const promptGate = new Promise<string>((resolve) => {
      releasePrompt = () => resolve("done");
    });

    const agentService = {
      runTaskPrompt: async () => promptGate,
    };

    const runner = new TaskRunner(
      service,
      agentService as never,
      new IdentityService(db)
    );
    const first = runner.run(task.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await runner.run(task.id);

    expect(second.skipped).toBe(true);

    releasePrompt();
    await first;
  });

  test("runs different tasks in parallel", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);

    const taskA = await service.create(
      ORG_ID,
      { prompt: "a", title: "A" },
      undefined,
      undefined,
      USER_A_ID
    );
    const taskB = await service.create(
      ORG_ID,
      { prompt: "b", title: "B" },
      undefined,
      undefined,
      USER_A_ID
    );

    const active = new Set<string>();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const agentService = {
      runTaskPrompt: async (
        _taskId: string,
        _profileId: string,
        _prompt: string
      ) => {
        active.add(_prompt);
        await gate;
        active.delete(_prompt);
        return _prompt;
      },
    };

    const runner = new TaskRunner(
      service,
      agentService as never,
      new IdentityService(db)
    );
    const runA = runner.run(taskA.id);
    const runB = runner.run(taskB.id);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active.size).toBe(2);

    releaseGate();
    await Promise.all([runA, runB]);
  });

  test("does not let actor B run actor A's task", async () => {
    const db = await createTestDb();
    const service = new TaskService(db);
    const task = await service.create(
      ORG_ID,
      { prompt: "private owner context", title: "Owned run" },
      undefined,
      undefined,
      USER_A_ID
    );
    let promptRuns = 0;
    const agentService = {
      runTaskPrompt: async () => {
        promptRuns += 1;
        return "done";
      },
    };
    const runner = new TaskRunner(
      service,
      agentService as never,
      new IdentityService(db)
    );

    await expect(runner.run(task.id, PRINCIPAL_B)).rejects.toMatchObject({
      status: 403,
    });
    expect(promptRuns).toBe(0);
    expect(await service.listRuns(task.id)).toHaveLength(0);

    const result = await runner.run(task.id, PRINCIPAL_A);
    expect(result.output).toBe("done");
    expect(promptRuns).toBe(1);
  });
});
