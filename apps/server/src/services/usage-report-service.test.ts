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
  tokens: number
) {
  await db.incrementLlmUsageDaily(
    {
      modelId,
      orgId,
      profileId: "p1",
      providerCredentialId: "cred_shared",
      providerType: "openrouter",
      userId,
    },
    {
      estimatedCostUsd: 0.01,
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

    const set = await service.setBudget("org_a", 0.5);
    expect(set.monthlyLimitUsd).toBe(0.5);
    expect(set.overBudget).toBe(true);
    expect(set.fractionUsed).toBeCloseTo(1.2, 5);
  });
});
