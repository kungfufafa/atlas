import { describe, expect, test } from "bun:test";
import { PrincipalRequiredError } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { ExecutionPlaneService } from "./execution-plane-service";
import { SubagentService } from "./subagent-service";

const PRINCIPAL = {
  isPlatformAdmin: false,
  orgId: "org_1",
  orgRole: "member" as const,
  userId: "user_1",
};

async function seed() {
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
  return { db, plane: new ExecutionPlaneService(db) };
}

describe("SubagentService", () => {
  test("start → poll → cancel aborts the child", async () => {
    const { plane } = await seed();
    let aborted = false;
    const service = new SubagentService(
      {
        runSubAgentPrompt: async (input) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 5000);
            input.signal?.addEventListener("abort", () => {
              aborted = true;
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          });
          return { output: "late", status: "success", summary: "late" };
        },
      },
      plane
    );

    const handle = await service.start({
      agentDepth: 1,
      orgId: "org_1",
      principal: PRINCIPAL,
      profileId: "profile_1",
      task: "Research the market",
      timeoutMs: 5000,
    });
    expect(handle.status).toBe("running");
    expect((await service.poll(handle.id, PRINCIPAL)).status).toBe("running");

    const cancelled = await service.cancel(handle.id, PRINCIPAL);
    expect(cancelled.status).toBe("cancelled");
    const waited = await service.wait(handle.id, PRINCIPAL);
    expect(waited.handle.status).toBe("cancelled");
    expect(waited.result.status).toBe("fail");
    expect(aborted).toBe(true);
  });

  test("budget timeout cancels a running subagent", async () => {
    const { plane } = await seed();
    const service = new SubagentService(
      {
        runSubAgentPrompt: async (input) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 5000);
            input.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          });
          return { output: "late", status: "success", summary: "late" };
        },
      },
      plane
    );

    const handle = await service.start({
      agentDepth: 1,
      orgId: "org_1",
      principal: PRINCIPAL,
      profileId: "profile_1",
      task: "Slow work",
      timeoutMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const polled = await service.poll(handle.id, PRINCIPAL);
    expect(polled.status).toBe("cancelled");
    const waited = await service.wait(handle.id, PRINCIPAL);
    expect(waited.handle.status).toBe("cancelled");
  });

  test("refuses Super Agent profiles for members", async () => {
    const { db, plane } = await seed();
    const now = new Date().toISOString();
    await db.upsertProfile({
      createdAt: now,
      id: "profile_super",
      isDefault: false,
      isSuper: true,
      model: null,
      name: "Super",
      orgId: "org_1",
      systemPrompt: "",
      updatedAt: now,
    });
    const service = new SubagentService(
      {
        runSubAgentPrompt: async () => ({
          output: "nope",
          status: "success",
          summary: "nope",
        }),
      },
      plane,
      db
    );
    await expect(
      service.start({
        agentDepth: 1,
        orgId: "org_1",
        principal: PRINCIPAL,
        profileId: "profile_super",
        task: "Use privileged tools",
      })
    ).rejects.toThrow(/Super Agent/);
  });

  test("completes the durable execution run", async () => {
    const { db, plane } = await seed();
    const service = new SubagentService(
      {
        runSubAgentPrompt: async () => ({
          output: "done",
          status: "success",
          summary: "done",
        }),
      },
      plane,
      db
    );
    const handle = await service.start({
      agentDepth: 1,
      orgId: "org_1",
      principal: PRINCIPAL,
      profileId: "profile_1",
      task: "Research",
    });
    const waited = await service.wait(handle.id, PRINCIPAL);
    expect(waited.handle.status).toBe("succeeded");
    const stored = (await db.listExecutionRuns({ kind: "subagent" }))[0];
    expect(stored?.status).toBe("completed");
  });

  test("parent abort signal cancels the child", async () => {
    const { plane } = await seed();
    const parent = new AbortController();
    let aborted = false;
    const service = new SubagentService(
      {
        runSubAgentPrompt: async (input) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 5000);
            input.signal?.addEventListener("abort", () => {
              aborted = true;
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          });
          return { output: "late", status: "success", summary: "late" };
        },
      },
      plane
    );
    const handle = await service.start({
      agentDepth: 1,
      orgId: "org_1",
      principal: PRINCIPAL,
      profileId: "profile_1",
      signal: parent.signal,
      task: "Research",
      timeoutMs: 5000,
    });
    parent.abort();
    const waited = await service.wait(handle.id, PRINCIPAL);
    expect(waited.handle.status).toBe("cancelled");
    expect(aborted).toBe(true);
  });

  test("fail closed without a principal", async () => {
    const { plane } = await seed();
    const service = new SubagentService(
      {
        runSubAgentPrompt: async () => ({
          output: "nope",
          status: "success",
          summary: "nope",
        }),
      },
      plane
    );

    await expect(
      service.start({
        agentDepth: 1,
        orgId: "org_1",
        principal: {
          isPlatformAdmin: false,
          orgId: "org_1",
          orgRole: "member",
          userId: "",
        },
        profileId: "profile_1",
        task: "Research",
      })
    ).rejects.toThrow(PrincipalRequiredError);
  });
});
