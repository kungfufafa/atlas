import { beforeEach, describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter, type DatabaseAdapter } from "@atlas/db";
import {
  USER_REQUEST_LIMIT_CODE,
  UsageLimitService,
  WORKSPACE_BUDGET_LIMIT_CODE,
} from "./usage-limit-service";

const ORG_ID = "org_limits";
const OTHER_ORG_ID = "org_other";

let db: DatabaseAdapter;
let service: UsageLimitService;

async function recordUsage(options: {
  orgId?: string;
  userId: string;
  requestCount: number;
  estimatedCostUsd?: number;
  providerType?: string;
}) {
  await db.incrementLlmUsageDaily(
    {
      capability: "chat.completion",
      modelId: "model-x",
      orgId: options.orgId ?? ORG_ID,
      profileId: "p1",
      providerCredentialId: "cred_1",
      providerType: options.providerType ?? "openai",
      userId: options.userId,
    },
    {
      estimatedCostUsd: options.estimatedCostUsd ?? 0,
      inputTokens: 10,
      outputTokens: 5,
      requestCount: options.requestCount,
    }
  );
}

async function setPolicy(policy: {
  enforceBudget?: boolean;
  monthlyLimitUsd?: number;
  perUserMonthlyRequests?: number;
}) {
  await db.upsertOrgUsageBudget({
    enforceBudget: policy.enforceBudget ?? false,
    monthlyLimitUsd: policy.monthlyLimitUsd ?? 0,
    orgId: ORG_ID,
    perUserMonthlyRequests: policy.perUserMonthlyRequests ?? 0,
    updatedAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  db = createInMemoryDatabaseAdapter();
  service = new UsageLimitService(db);
});

describe("UsageLimitService per-user request limit", () => {
  test("passes when no policy exists", async () => {
    await recordUsage({ requestCount: 1000, userId: "user_1" });
    await expect(
      service.assertWithinLimits({ orgId: ORG_ID, userId: "user_1" })
    ).resolves.toBeUndefined();
  });

  test("rejects a user at the limit and leaves other users unaffected", async () => {
    await setPolicy({ perUserMonthlyRequests: 10 });
    await recordUsage({ requestCount: 10, userId: "user_heavy" });
    await recordUsage({ requestCount: 2, userId: "user_light" });

    await expect(
      service.assertWithinLimits({ orgId: ORG_ID, userId: "user_heavy" })
    ).rejects.toMatchObject({ path: USER_REQUEST_LIMIT_CODE, status: 429 });
    await expect(
      service.assertWithinLimits({ orgId: ORG_ID, userId: "user_light" })
    ).resolves.toBeUndefined();
  });

  test("applies to subscription-backed executions too", async () => {
    await setPolicy({ perUserMonthlyRequests: 5 });
    await recordUsage({
      providerType: "claude",
      requestCount: 5,
      userId: "user_sub",
    });

    await expect(
      service.assertWithinLimits({
        orgId: ORG_ID,
        providerType: "claude",
        userId: "user_sub",
      })
    ).rejects.toMatchObject({ path: USER_REQUEST_LIMIT_CODE, status: 429 });
  });

  test("only counts usage inside the caller's workspace", async () => {
    await setPolicy({ perUserMonthlyRequests: 10 });
    await recordUsage({
      orgId: OTHER_ORG_ID,
      requestCount: 50,
      userId: "user_1",
    });

    await expect(
      service.assertWithinLimits({ orgId: ORG_ID, userId: "user_1" })
    ).resolves.toBeUndefined();
  });

  test("skips the user check when the caller identity is unknown", async () => {
    await setPolicy({ perUserMonthlyRequests: 1 });
    await recordUsage({ requestCount: 5, userId: "unknown" });

    await expect(
      service.assertWithinLimits({ orgId: ORG_ID })
    ).resolves.toBeUndefined();
  });
});

describe("UsageLimitService workspace budget", () => {
  test("soft budget never rejects", async () => {
    await setPolicy({ enforceBudget: false, monthlyLimitUsd: 1 });
    await recordUsage({
      estimatedCostUsd: 5,
      requestCount: 1,
      userId: "user_1",
    });

    await expect(
      service.assertWithinLimits({
        orgId: ORG_ID,
        providerType: "openai",
        userId: "user_1",
      })
    ).resolves.toBeUndefined();
  });

  test("enforced budget rejects cost-bearing executions once reached", async () => {
    await setPolicy({ enforceBudget: true, monthlyLimitUsd: 1 });
    await recordUsage({
      estimatedCostUsd: 1.2,
      requestCount: 1,
      userId: "user_1",
    });

    await expect(
      service.assertWithinLimits({
        orgId: ORG_ID,
        providerType: "openai",
        userId: "user_1",
      })
    ).rejects.toMatchObject({
      path: WORKSPACE_BUDGET_LIMIT_CODE,
      status: 429,
    });
  });

  test("enforced budget does not block subscription executions", async () => {
    await setPolicy({ enforceBudget: true, monthlyLimitUsd: 1 });
    await recordUsage({
      estimatedCostUsd: 1.2,
      requestCount: 1,
      userId: "user_1",
    });

    await expect(
      service.assertWithinLimits({
        orgId: ORG_ID,
        providerType: "chatgpt",
        userId: "user_1",
      })
    ).resolves.toBeUndefined();
    await expect(
      service.assertWithinLimits({
        orgId: ORG_ID,
        providerType: "claude",
        userId: "user_1",
      })
    ).resolves.toBeUndefined();
  });

  test("unknown provider counts as cost-bearing", async () => {
    await setPolicy({ enforceBudget: true, monthlyLimitUsd: 1 });
    await recordUsage({
      estimatedCostUsd: 2,
      requestCount: 1,
      userId: "user_1",
    });

    await expect(
      service.assertWithinLimits({ orgId: ORG_ID, userId: "user_1" })
    ).rejects.toMatchObject({ path: WORKSPACE_BUDGET_LIMIT_CODE });
  });

  test("under-budget cost-bearing executions pass", async () => {
    await setPolicy({ enforceBudget: true, monthlyLimitUsd: 10 });
    await recordUsage({
      estimatedCostUsd: 2,
      requestCount: 1,
      userId: "user_1",
    });

    await expect(
      service.assertWithinLimits({
        orgId: ORG_ID,
        providerType: "openai",
        userId: "user_1",
      })
    ).resolves.toBeUndefined();
  });
});
