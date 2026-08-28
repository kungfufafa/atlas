import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
import type { LlmUsageDimensions } from "./types";

function dims(overrides: Partial<LlmUsageDimensions>): LlmUsageDimensions {
  return {
    capability: "chat.completion",
    modelId: "gpt-x",
    orgId: "org_a",
    profileId: "profile_1",
    providerCredentialId: "cred_shared",
    providerType: "openrouter",
    userId: "user_1",
    ...overrides,
  };
}

async function seed() {
  const db = createInMemoryDatabaseAdapter();
  // org_a / user_1 — two turns, same shared credential
  await db.incrementLlmUsageDaily(dims({}), {
    estimatedCostUsd: 0.1,
    inputTokens: 100,
    outputTokens: 20,
    requestCount: 1,
  });
  await db.incrementLlmUsageDaily(dims({}), {
    estimatedCostUsd: 0.1,
    inputTokens: 100,
    outputTokens: 20,
    requestCount: 1,
  });
  // org_a / user_2 — one turn
  await db.incrementLlmUsageDaily(dims({ userId: "user_2" }), {
    estimatedCostUsd: 0.05,
    inputTokens: 50,
    outputTokens: 10,
    requestCount: 1,
  });
  // org_b / user_3 — same shared credential, different workspace
  await db.incrementLlmUsageDaily(
    dims({ modelId: "claude-y", orgId: "org_b", userId: "user_3" }),
    {
      estimatedCostUsd: 1,
      inputTokens: 1000,
      outputTokens: 300,
      requestCount: 1,
    }
  );
  return db;
}

describe("llm_usage_daily rollup + aggregation (in-memory)", () => {
  test("folds repeated turns into one row and totals by workspace", async () => {
    const db = await seed();
    const byWorkspace = await db.aggregateLlmUsage({ groupBy: "workspace" });

    expect(byWorkspace.map((row) => row.key)).toEqual(["org_b", "org_a"]);
    const orgA = byWorkspace.find((row) => row.key === "org_a");
    expect(orgA).toMatchObject({
      inputTokens: 250,
      outputTokens: 50,
      requestCount: 3,
      totalTokens: 300,
    });
    expect(orgA?.estimatedCostUsd).toBeCloseTo(0.25, 5);
  });

  test("ranks users by total tokens", async () => {
    const db = await seed();
    const byUser = await db.aggregateLlmUsage({ groupBy: "user" });
    expect(byUser.map((row) => row.key)).toEqual([
      "user_3",
      "user_1",
      "user_2",
    ]);
  });

  test("groups a shared credential across workspaces", async () => {
    const db = await seed();
    const byCredential = await db.aggregateLlmUsage({ groupBy: "credential" });
    const shared = byCredential.find((row) => row.key === "cred_shared");
    // 3 turns in org_a + 1 in org_b all used the same credential.
    expect(shared?.requestCount).toBe(4);
    expect(shared?.totalTokens).toBe(1600);
  });

  test("scopes to a single workspace (org-admin view)", async () => {
    const db = await seed();
    const usersInOrgA = await db.aggregateLlmUsage({
      groupBy: "user",
      orgId: "org_a",
    });
    expect(usersInOrgA.map((row) => row.key).sort()).toEqual([
      "user_1",
      "user_2",
    ]);
  });

  test("keeps capabilities as separate rows and aggregates by capability", async () => {
    const db = await seed();
    await db.incrementLlmUsageDaily(
      dims({ capability: "image.generation", modelId: "gpt-image-2" }),
      {
        estimatedCostUsd: 0.02,
        inputTokens: 0,
        outputTokens: 0,
        requestCount: 1,
      }
    );

    const byCapability = await db.aggregateLlmUsage({
      groupBy: "capability",
      orgId: "org_a",
    });
    const chat = byCapability.find((row) => row.key === "chat.completion");
    const image = byCapability.find((row) => row.key === "image.generation");
    expect(chat?.requestCount).toBe(3);
    expect(image?.requestCount).toBe(1);
  });

  test("scopes to a single user (member view) and honors limit", async () => {
    const db = await seed();
    const models = await db.aggregateLlmUsage({
      groupBy: "model",
      limit: 1,
      userId: "user_1",
    });
    expect(models).toHaveLength(1);
    expect(models[0]?.key).toBe("gpt-x");
    expect(models[0]?.requestCount).toBe(2);
  });

  test("prune removes only rows on or before the cutoff day", async () => {
    const db = await seed();
    const removedOld = await db.pruneLlmUsageDaily("1970-01-01");
    expect(removedOld).toBe(0);
    expect(await db.aggregateLlmUsage({ groupBy: "workspace" })).not.toEqual(
      []
    );

    const today = new Date().toISOString().slice(0, 10);
    const removed = await db.pruneLlmUsageDaily(today);
    expect(removed).toBeGreaterThan(0);
    expect(await db.aggregateLlmUsage({ groupBy: "workspace" })).toEqual([]);
  });

  test("org usage budget get/upsert/list", async () => {
    const db = await seed();
    expect(await db.getOrgUsageBudget("org_a")).toBeNull();
    await db.upsertOrgUsageBudget({
      enforceBudget: false,
      monthlyLimitUsd: 25,
      orgId: "org_a",
      perUserMonthlyRequests: 0,
      updatedAt: new Date().toISOString(),
    });
    expect((await db.getOrgUsageBudget("org_a"))?.monthlyLimitUsd).toBe(25);
    await db.upsertOrgUsageBudget({
      enforceBudget: true,
      monthlyLimitUsd: 40,
      orgId: "org_a",
      perUserMonthlyRequests: 500,
      updatedAt: new Date().toISOString(),
    });
    const updated = await db.getOrgUsageBudget("org_a");
    expect(updated?.monthlyLimitUsd).toBe(40);
    expect(updated?.enforceBudget).toBe(true);
    expect(updated?.perUserMonthlyRequests).toBe(500);
    expect(await db.listOrgUsageBudgets()).toHaveLength(1);
  });
});
