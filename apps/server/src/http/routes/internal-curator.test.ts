import { describe, expect, mock, test } from "bun:test";
import { loadLocalAuthToken } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AuthService } from "../../services/auth-service";
import { AutomationService } from "../../services/automation-service";
import { OrgService } from "../../services/org-service";
import { createHonoApp } from "../app";
import { seedLocalClientUser } from "../test-org-helpers";

const ORG_ID = "org_curator_internal";

function createServerOptions() {
  const databaseAdapter = createInMemoryDatabaseAdapter();
  const authService = new AuthService();
  const orgService = new OrgService(databaseAdapter, authService);
  const runDue = mock(async () => null);
  return {
    agent: { providerConfigured: true } as any,
    authService,
    automationService: new AutomationService(databaseAdapter, {
      getUserTimezone: async () => "UTC",
    }),
    databaseAdapter,
    mcpService: {} as any,
    orgService,
    skillCuratorService: { runDue } as any,
    systemStatus: {} as any,
    taskService: {} as any,
    webDistDir: null,
    workerManager: {} as any,
  };
}

async function seedOrganization(
  database: ReturnType<typeof createInMemoryDatabaseAdapter>,
  input: { enabled?: boolean; id?: string } = {}
): Promise<string> {
  const id = input.id ?? ORG_ID;
  const now = new Date().toISOString();
  await database.upsertOrganization({
    createdAt: now,
    id,
    name: id,
    skillsCuratorConsolidation: input.enabled ?? true,
    slug: id,
    updatedAt: now,
  });
  return id;
}

describe("internal curator routes", () => {
  test("requires local-token authentication", async () => {
    const options = createServerOptions();
    await seedOrganization(options.databaseAdapter);
    const app = createHonoApp(options);

    expect(
      (
        await app.fetch(
          new Request("http://localhost:4310/v1/internal/curator/orgs")
        )
      ).status
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request(
            `http://localhost:4310/v1/internal/curator/orgs/${ORG_ID}/run-due`,
            { method: "POST" }
          )
        )
      ).status
    ).toBe(401);
  });

  test("lists active opted-in workspaces and runs an org-scoped due check", async () => {
    const options = createServerOptions();
    await seedOrganization(options.databaseAdapter);
    await seedOrganization(options.databaseAdapter, {
      enabled: false,
      id: "org_disabled",
    });
    await seedLocalClientUser(options.databaseAdapter);
    const token = await loadLocalAuthToken();
    const headers = { Authorization: `Bearer ${token}` };
    const app = createHonoApp(options);

    const list = await app.fetch(
      new Request("http://localhost:4310/v1/internal/curator/orgs", {
        headers,
      })
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({
      orgs: [{ id: ORG_ID, lastRunAt: null }],
    });

    const run = await app.fetch(
      new Request(
        `http://localhost:4310/v1/internal/curator/orgs/${ORG_ID}/run-due`,
        { headers, method: "POST" }
      )
    );
    expect(run.status).toBe(200);
    await expect(run.json()).resolves.toEqual({ result: null });
    expect(options.skillCuratorService.runDue).toHaveBeenCalledWith(ORG_ID);
  });

  test("refuses an archived workspace before invoking the curator", async () => {
    const options = createServerOptions();
    await seedOrganization(options.databaseAdapter);
    await seedOrganization(options.databaseAdapter, { id: "org_remaining" });
    const archivedAt = new Date().toISOString();
    expect(
      await options.databaseAdapter.tryMarkOrganizationArchived(
        ORG_ID,
        archivedAt
      )
    ).toBe(true);
    await seedLocalClientUser(options.databaseAdapter);
    const token = await loadLocalAuthToken();
    const app = createHonoApp(options);

    const response = await app.fetch(
      new Request(
        `http://localhost:4310/v1/internal/curator/orgs/${ORG_ID}/run-due`,
        {
          headers: { Authorization: `Bearer ${token}` },
          method: "POST",
        }
      )
    );

    expect(response.status).toBe(404);
    expect(options.skillCuratorService.runDue).not.toHaveBeenCalled();
  });
});
