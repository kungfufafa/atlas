import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter, type DatabaseAdapter } from "@atlas/db";
import { AuthService } from "../../services/auth-service";
import { OrgService } from "../../services/org-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createHonoApp } from "../app";
import {
  loginPlatformAdminSession,
  loginUserSession,
  seedOrgAdmin,
} from "../test-session-helpers";

setupTestConfigDir("atlas-platform-usage-test-");

function createPlatformApp() {
  const databaseAdapter = createInMemoryDatabaseAdapter();
  const authService = new AuthService();
  return {
    app: createHonoApp({
      agent: {
        listProfiles: async () => ({ profiles: [{ id: "default" }] }),
      } as any,
      authService,
      automationService: {} as any,
      databaseAdapter,
      mcpService: {} as any,
      orgService: new OrgService(databaseAdapter, authService),
      systemStatus: { getStatus: async () => ({ ok: true }) } as any,
      taskService: {} as any,
      webDistDir: null,
      workerManager: {} as any,
    }),
    authService,
    databaseAdapter,
  };
}

async function seedUsage(db: DatabaseAdapter) {
  const now = new Date().toISOString();
  for (const [orgId, name] of [
    ["org_sales", "Sales"],
    ["org_engineering", "Engineering"],
  ] as const) {
    await db.upsertOrganization({
      createdAt: now,
      id: orgId,
      name,
      slug: orgId.replace(/_/g, "-"),
      updatedAt: now,
    });
  }

  await db.incrementLlmUsageDaily(
    {
      capability: "chat.completion",
      modelId: "claude-sonnet-4-6",
      orgId: "org_sales",
      profileId: "p1",
      providerCredentialId: "cred_claude",
      providerType: "claude",
      userId: "user_sales",
    },
    {
      estimatedCostUsd: 0,
      inputTokens: 900,
      outputTokens: 100,
      requestCount: 9,
    }
  );
  await db.incrementLlmUsageDaily(
    {
      capability: "image.generation",
      modelId: "gpt-image-2",
      orgId: "org_engineering",
      profileId: "p1",
      providerCredentialId: "cred_openai",
      providerType: "openai",
      userId: "user_eng",
    },
    { estimatedCostUsd: 2.5, inputTokens: 50, outputTokens: 0, requestCount: 4 }
  );
  await db.upsertOrgUsageBudget({
    enforceBudget: true,
    monthlyLimitUsd: 2,
    orgId: "org_engineering",
    perUserMonthlyRequests: 100,
    updatedAt: now,
  });
}

describe("platform usage routes", () => {
  test("platform admin sees every workspace with budget state", async () => {
    const { app, authService, databaseAdapter } = createPlatformApp();
    await seedUsage(databaseAdapter);
    const session = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter
    );

    const overviewResponse = await app.fetch(
      new Request("http://localhost:4310/v1/platform/usage/overview", {
        headers: session.headers(),
      })
    );
    expect(overviewResponse.status).toBe(200);
    const overview = (await overviewResponse.json()) as {
      month: string;
      workspaces: Array<Record<string, unknown>>;
    };
    expect(overview.workspaces).toHaveLength(2);
    // Engineering carries the API spend and sorts first.
    expect(overview.workspaces[0]).toMatchObject({
      enforced: true,
      estimatedCostUsd: 2.5,
      monthlyLimitUsd: 2,
      orgId: "org_engineering",
      orgName: "Engineering",
      overBudget: true,
      perUserMonthlyRequests: 100,
      requestCount: 4,
    });
    expect(overview.workspaces[1]).toMatchObject({
      enforced: false,
      estimatedCostUsd: 0,
      monthlyLimitUsd: null,
      orgName: "Sales",
      overBudget: false,
      requestCount: 9,
      totalTokens: 1000,
    });

    const reportResponse = await app.fetch(
      new Request("http://localhost:4310/v1/platform/usage?groupBy=workspace", {
        headers: session.headers(),
      })
    );
    expect(reportResponse.status).toBe(200);
    const report = (await reportResponse.json()) as {
      scope: string;
      rows: Array<{ key: string }>;
    };
    expect(report.scope).toBe("platform");
    expect(report.rows.map((row) => row.key).sort()).toEqual([
      "org_engineering",
      "org_sales",
    ]);
  });

  test("workspace admins and members cannot read cross-workspace usage", async () => {
    const { app, authService, databaseAdapter } = createPlatformApp();
    await seedUsage(databaseAdapter);
    const seeded = await seedOrgAdmin(databaseAdapter, {
      authService,
      orgId: "org_sales",
    });
    const session = await loginUserSession(
      app,
      seeded.email,
      seeded.password,
      seeded.orgId
    );

    for (const path of [
      "/v1/platform/usage/overview",
      "/v1/platform/usage?groupBy=workspace",
    ]) {
      const response = await app.fetch(
        new Request(`http://localhost:4310${path}`, {
          headers: session.headers(),
        })
      );
      expect(response.status).toBe(403);
    }
  });
});
