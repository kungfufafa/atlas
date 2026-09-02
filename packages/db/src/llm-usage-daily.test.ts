import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
import { createSqliteDatabase } from "./adapters/sqlite";
import type { LlmUsageDimensions } from "./types";

function dims(overrides: Partial<LlmUsageDimensions>): LlmUsageDimensions {
  return {
    capability: "chat.completion",
    channel: "web",
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
  await db.incrementLlmUsageDaily(
    dims({ channel: "whatsapp", userId: "user_2" }),
    {
      estimatedCostUsd: 0.05,
      inputTokens: 50,
      outputTokens: 10,
      requestCount: 1,
    }
  );
  // org_b / user_3 — same shared credential, different workspace
  await db.incrementLlmUsageDaily(
    dims({
      channel: "discord",
      modelId: "claude-y",
      orgId: "org_b",
      userId: "user_3",
    }),
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

  test("groups and filters by initiating channel", async () => {
    const db = await seed();
    const byChannel = await db.aggregateLlmUsage({ groupBy: "channel" });
    expect(byChannel.map((row) => row.key)).toEqual([
      "discord",
      "web",
      "whatsapp",
    ]);

    const whatsappUsers = await db.aggregateLlmUsage({
      channel: "whatsapp",
      groupBy: "user",
      orgId: "org_a",
    });
    expect(whatsappUsers).toEqual([
      {
        estimatedCostUsd: 0.05,
        inputTokens: 50,
        key: "user_2",
        outputTokens: 10,
        requestCount: 1,
        totalTokens: 60,
      },
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

  test("ranks zero-token billable capabilities by cost before token-only activity", async () => {
    const db = await seed();
    await db.incrementLlmUsageDaily(
      dims({
        capability: "image.generation",
        modelId: "gpt-image-2",
        userId: "user_image",
      }),
      {
        estimatedCostUsd: 2,
        inputTokens: 0,
        outputTokens: 0,
        requestCount: 10,
      }
    );

    const users = await db.aggregateLlmUsage({ groupBy: "user", limit: 1 });
    expect(users[0]).toMatchObject({
      estimatedCostUsd: 2,
      key: "user_image",
      requestCount: 10,
      totalTokens: 0,
    });
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
      monthlyLimitUsd: 25,
      orgId: "org_a",
      updatedAt: new Date().toISOString(),
    });
    expect((await db.getOrgUsageBudget("org_a"))?.monthlyLimitUsd).toBe(25);
    await db.upsertOrgUsageBudget({
      monthlyLimitUsd: 40,
      orgId: "org_a",
      updatedAt: new Date().toISOString(),
    });
    expect((await db.getOrgUsageBudget("org_a"))?.monthlyLimitUsd).toBe(40);
    expect(await db.listOrgUsageBudgets()).toHaveLength(1);
  });
});

describe("llm_usage_daily channel dimensions (sqlite)", () => {
  test("keeps otherwise identical usage separate by channel", async () => {
    const database = await createSqliteDatabase(":memory:");

    try {
      await database.adapter.incrementLlmUsageDaily(dims({ channel: "web" }), {
        estimatedCostUsd: 0.1,
        inputTokens: 100,
        outputTokens: 20,
        requestCount: 1,
      });
      await database.adapter.incrementLlmUsageDaily(
        dims({ channel: "whatsapp" }),
        {
          estimatedCostUsd: 0.2,
          inputTokens: 200,
          outputTokens: 40,
          requestCount: 1,
        }
      );
      await database.adapter.incrementLlmUsageDaily(
        dims({
          capability: "image.generation",
          channel: "unknown",
          userId: "user_image",
        }),
        {
          estimatedCostUsd: 1,
          inputTokens: 0,
          outputTokens: 0,
          requestCount: 20,
        }
      );

      const channels = await database.adapter.aggregateLlmUsage({
        groupBy: "channel",
        orgId: "org_a",
      });
      expect(channels.map((row) => row.key)).toEqual([
        "unknown",
        "whatsapp",
        "web",
      ]);

      const whatsapp = await database.adapter.aggregateLlmUsage({
        channel: "whatsapp",
        groupBy: "workspace",
        orgId: "org_a",
      });
      expect(whatsapp[0]).toMatchObject({
        inputTokens: 200,
        outputTokens: 40,
        requestCount: 1,
        totalTokens: 240,
      });

      const highestCostUser = await database.adapter.aggregateLlmUsage({
        groupBy: "user",
        limit: 1,
        orgId: "org_a",
      });
      expect(highestCostUser[0]?.key).toBe("user_image");
    } finally {
      database.close();
    }
  });
});
