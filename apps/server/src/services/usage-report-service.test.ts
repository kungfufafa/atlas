import { beforeEach, describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter, type DatabaseAdapter } from "@atlas/db";
import { UsageReportService } from "./usage-report-service";

let db: DatabaseAdapter;
let service: UsageReportService;

async function seedOrg(id: string, name: string) {
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id,
    name,
    slug: id.replace(/_/g, "-"),
    updatedAt: now,
  });
}

async function seedUser(id: string, name: string, email: string) {
  const now = new Date().toISOString();
  await db.createUser({
    createdAt: now,
    email,
    id,
    isPlatformAdmin: false,
    name,
    passwordHash: "x",
    updatedAt: now,
  });
}

async function record(
  orgId: string,
  userId: string,
  modelId: string,
  tokens: number,
  overrides: {
    capability?: string;
    estimatedCostUsd?: number;
    providerCredentialId?: string;
    providerType?: string;
  } = {}
) {
  await db.incrementLlmUsageDaily(
    {
      capability: overrides.capability ?? "chat.completion",
      modelId,
      orgId,
      profileId: "p1",
      providerCredentialId: overrides.providerCredentialId ?? "cred_shared",
      providerType: overrides.providerType ?? "openrouter",
      userId,
    },
    {
      estimatedCostUsd: overrides.estimatedCostUsd ?? 0.01,
      inputTokens: tokens,
      outputTokens: 0,
      requestCount: 1,
    }
  );
}

beforeEach(async () => {
  db = createInMemoryDatabaseAdapter();
  service = new UsageReportService(db);
  await seedOrg("org_a", "Acme");
  await seedOrg("org_b", "Globex");
  await seedUser("user_1", "Alice", "alice@acme.test");
  await seedUser("user_2", "Bob", "bob@acme.test");
  await record("org_a", "user_1", "gpt-x", 300);
  await record("org_a", "user_2", "gpt-x", 100);
  await record("org_b", "user_3", "claude-y", 1000);
});

describe("UsageReportService RBAC scoping", () => {
  test("platform admin in a workspace only sees that workspace", async () => {
    const report = await service.getReport(
      { groupBy: "workspace" },
      { isPlatformAdmin: true, orgId: "org_a" }
    );
    expect(report.scope).toBe("workspace");
    expect(report.rows.map((row) => row.label)).toEqual(["Acme"]);
  });

  test("platform admin sees every workspace with resolved names", async () => {
    const report = await service.getReport(
      { groupBy: "workspace" },
      { isPlatformAdmin: true }
    );
    expect(report.scope).toBe("platform");
    expect(report.rows.map((row) => row.label)).toEqual(["Globex", "Acme"]);
  });

  test("workspace admin is scoped to their workspace, broken down by user", async () => {
    const report = await service.getReport(
      { groupBy: "user" },
      { orgId: "org_a", orgRole: "admin" }
    );
    expect(report.scope).toBe("workspace");
    // Only org_a users, labeled by name, and never org_b's user_3.
    expect(report.rows.map((row) => row.label).sort()).toEqual([
      "Alice",
      "Bob",
    ]);
  });

  test("member only sees their own usage", async () => {
    const report = await service.getReport(
      { groupBy: "model" },
      { orgId: "org_a", orgRole: "member", userId: "user_1" }
    );
    expect(report.scope).toBe("user");
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ key: "gpt-x", requestCount: 1 });
  });

  test("non-platform caller without a workspace gets nothing", async () => {
    const report = await service.getReport(
      { groupBy: "workspace" },
      { orgRole: "admin" }
    );
    expect(report.rows).toEqual([]);
  });

  test("shared credential in one workspace does not include other workspaces", async () => {
    const report = await service.getReport(
      { groupBy: "credential" },
      { isPlatformAdmin: true, orgId: "org_a" }
    );
    const shared = report.rows.find((row) => row.key === "cred_shared");
    expect(shared?.requestCount).toBe(2);
    expect(shared?.totalTokens).toBe(400);
  });

  test("shared credential aggregates across workspaces for platform admin", async () => {
    const report = await service.getReport(
      { groupBy: "credential" },
      { isPlatformAdmin: true }
    );
    const shared = report.rows.find((row) => row.key === "cred_shared");
    expect(shared?.requestCount).toBe(3);
    expect(shared?.totalTokens).toBe(1400);
  });
});

describe("UsageReportService subscription vs API visibility", () => {
  beforeEach(async () => {
    // Mixed credentials in org_a: Claude subscription coding plus OpenAI
    // API-key image generation by the same user.
    await record("org_a", "user_1", "claude-sonnet-4-6", 500, {
      capability: "chat.completion",
      estimatedCostUsd: 0,
      providerCredentialId: "cred_claude_sub",
      providerType: "claude",
    });
    await record("org_a", "user_1", "gpt-image-2", 40, {
      capability: "image.generation",
      estimatedCostUsd: 0.08,
      providerCredentialId: "cred_openai_key",
      providerType: "openai",
    });
  });

  test("auth grouping splits subscription and API usage within the workspace", async () => {
    const report = await service.getReport(
      { groupBy: "auth" },
      { orgId: "org_a", orgRole: "admin" }
    );

    const subscription = report.rows.find((row) => row.key === "subscription");
    const api = report.rows.find((row) => row.key === "api");
    expect(subscription).toMatchObject({
      authKind: "subscription",
      requestCount: 1,
      totalTokens: 500,
    });
    expect(subscription?.estimatedCostUsd).toBe(0);
    // API bucket = openrouter chat rows from the shared seed + openai image row.
    expect(api?.authKind).toBe("api");
    expect(api?.requestCount).toBe(3);
    expect(api?.estimatedCostUsd).toBeCloseTo(0.1, 5);
  });

  test("auth grouping respects member self-scoping", async () => {
    const report = await service.getReport(
      { groupBy: "auth" },
      { orgId: "org_a", orgRole: "member", userId: "user_2" }
    );
    // user_2 only has one API chat turn from the shared seed.
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      key: "api",
      requestCount: 1,
    });
  });

  test("provider rows carry authKind and display names", async () => {
    const report = await service.getReport(
      { groupBy: "provider" },
      { orgId: "org_a", orgRole: "admin" }
    );
    const claude = report.rows.find((row) => row.key === "claude");
    const openai = report.rows.find((row) => row.key === "openai");
    expect(claude).toMatchObject({
      authKind: "subscription",
      label: "Claude",
    });
    expect(openai).toMatchObject({ authKind: "api", label: "OpenAI" });
  });

  test("capability grouping separates chat from image generation", async () => {
    const report = await service.getReport(
      { groupBy: "capability" },
      { orgId: "org_a", orgRole: "admin" }
    );
    const chat = report.rows.find((row) => row.key === "chat.completion");
    const image = report.rows.find((row) => row.key === "image.generation");
    expect(chat?.label).toBe("Chat");
    expect(chat?.requestCount).toBe(3);
    expect(image).toMatchObject({
      label: "Image generation",
      requestCount: 1,
    });
  });

  test("credential rows resolve workspace instance labels and auth kind", async () => {
    await db.upsertOrgAiConfig({
      config: {
        defaultProviderId: "cred_claude_sub",
        providers: [
          {
            apiKey: "",
            createdAt: "2026-01-01T00:00:00.000Z",
            id: "cred_claude_sub",
            label: "Claude (host)",
            type: "claude",
          },
          {
            apiKey: "sk-test",
            createdAt: "2026-01-01T00:00:00.000Z",
            id: "cred_openai_key",
            label: "OpenAI production",
            type: "openai",
          },
        ],
      },
      orgId: "org_a",
      updatedAt: new Date().toISOString(),
    });

    const report = await service.getReport(
      { groupBy: "credential" },
      { orgId: "org_a", orgRole: "admin" }
    );
    const sub = report.rows.find((row) => row.key === "cred_claude_sub");
    const key = report.rows.find((row) => row.key === "cred_openai_key");
    const removed = report.rows.find((row) => row.key === "cred_shared");
    expect(sub).toMatchObject({
      authKind: "subscription",
      label: "Claude (host)",
    });
    expect(key).toMatchObject({
      authKind: "api",
      label: "OpenAI production",
    });
    // Historical usage for a removed instance keeps its raw key un-reassigned.
    expect(removed?.label).toBe("cred_shared");
    expect(removed?.authKind).toBeUndefined();
  });
});

describe("UsageReportService budgets", () => {
  test("reports month-to-date spend and over-budget after setting a limit", async () => {
    const db = createInMemoryDatabaseAdapter();
    const service = new UsageReportService(db);
    await db.incrementLlmUsageDaily(
      {
        modelId: "gpt-x",
        orgId: "org_a",
        profileId: "p1",
        providerCredentialId: "cred",
        providerType: "openrouter",
        userId: "user_1",
      },
      {
        estimatedCostUsd: 0.6,
        inputTokens: 100,
        outputTokens: 20,
        requestCount: 1,
      }
    );

    const noBudget = await service.getBudgetStatus("org_a");
    expect(noBudget.monthlyLimitUsd).toBeNull();
    expect(noBudget.monthToDateUsd).toBeCloseTo(0.6, 5);
    expect(noBudget.overBudget).toBe(false);
    expect(noBudget.enforced).toBe(false);
    expect(noBudget.perUserMonthlyRequests).toBeNull();

    const set = await service.setBudget("org_a", { monthlyLimitUsd: 0.5 });
    expect(set.monthlyLimitUsd).toBe(0.5);
    expect(set.overBudget).toBe(true);
    expect(set.fractionUsed).toBeCloseTo(1.2, 5);
  });

  test("policy updates merge instead of clobbering unrelated fields", async () => {
    const db = createInMemoryDatabaseAdapter();
    const service = new UsageReportService(db);

    await service.setBudget("org_a", {
      monthlyLimitUsd: 20,
      perUserMonthlyRequests: 500,
    });
    const enforcedOnly = await service.setBudget("org_a", { enforced: true });
    expect(enforcedOnly).toMatchObject({
      enforced: true,
      monthlyLimitUsd: 20,
      perUserMonthlyRequests: 500,
    });

    const limitOnly = await service.setBudget("org_a", { monthlyLimitUsd: 35 });
    expect(limitOnly).toMatchObject({
      enforced: true,
      monthlyLimitUsd: 35,
      perUserMonthlyRequests: 500,
    });

    const cleared = await service.setBudget("org_a", {
      perUserMonthlyRequests: 0,
    });
    expect(cleared.perUserMonthlyRequests).toBeNull();
    expect(cleared.monthlyLimitUsd).toBe(35);
  });
});
