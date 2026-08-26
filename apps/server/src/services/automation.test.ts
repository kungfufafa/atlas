import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AutomationDeliveryService } from "./automation-delivery-service";
import { AutomationRunner } from "./automation-runner";
import { AutomationService } from "./automation-service";
import { ExecutionPlaneService } from "./execution-plane-service";
import { IdentityService } from "./identity-service";
import {
  createMcpAwareEmailOutboundAdapter,
  hasAutomationEmailDeliveryPath,
} from "./mcp-email-delivery";

const ORG_ID = "org_test";
const PROFILE_ID = "profile_default";
const USER_ID = "user_test";
const PRINCIPAL = {
  isPlatformAdmin: false,
  orgId: ORG_ID,
  orgRole: "member" as const,
  userId: USER_ID,
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

  await db.createUser({
    createdAt: now,
    email: "ada@example.com",
    id: USER_ID,
    name: "Ada",
    passwordHash: "x",
    updatedAt: now,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role: "member",
    userId: USER_ID,
  });

  return db;
}

async function archiveTestOrganization(
  db: ReturnType<typeof createInMemoryDatabaseAdapter>
): Promise<boolean> {
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: "org_remaining",
    name: "Remaining Org",
    slug: "remaining-org",
    updatedAt: now,
  });
  return db.tryMarkOrganizationArchived(ORG_ID, now);
}

async function seedTelegramAutomation(
  db: ReturnType<typeof createInMemoryDatabaseAdapter>,
  input: { id: string; name: string; prompt: string }
): Promise<string> {
  const now = new Date().toISOString();
  await db.upsertAutomation({
    createdAt: now,
    definition: {
      delivery: { channel: "telegram" },
      description: input.prompt,
      prompt: input.prompt,
      steps: [],
      trigger: { type: "manual" },
      version: 1,
    },
    enabled: true,
    id: input.id,
    name: input.name,
    orgId: ORG_ID,
    profileId: PROFILE_ID,
    updatedAt: now,
    version: 1,
  });
  return input.id;
}

function createRunner(
  db: ReturnType<typeof createInMemoryDatabaseAdapter>,
  service: AutomationService,
  agentService: unknown,
  deliveryService?: AutomationDeliveryService
) {
  return new AutomationRunner(
    service,
    agentService as never,
    deliveryService,
    new ExecutionPlaneService(db),
    new IdentityService(db)
  );
}

async function assignComposeioGmailSender(
  db: ReturnType<typeof createInMemoryDatabaseAdapter>,
  profileId: string,
  inputSchema?: Record<string, unknown>
) {
  const now = new Date().toISOString();
  const serverId = "mcp_composeio";

  await db.upsertMcpServer({
    cachedTools: [
      {
        description: "Send an email with Gmail",
        inputSchema: inputSchema ?? {
          properties: {
            body: { type: "string" },
            subject: { type: "string" },
            to: { type: "string" },
          },
          type: "object",
        },
        name: "send_email",
      },
    ],
    config: { url: "https://example.com/mcp" },
    createdAt: now,
    enabled: true,
    id: serverId,
    lastError: null,
    name: "composeio-gmail",
    orgId: ORG_ID,
    status: "connected",
    transport: "http",
    updatedAt: now,
  });
  await db.assignMcpServerToProfile(profileId, serverId);
}

describe("AutomationService", () => {
  test("accepts email delivery when composeio MCP email sending is assigned", async () => {
    const db = await createTestDb();
    await assignComposeioGmailSender(db, PROFILE_ID);

    const service = new AutomationService(db, {
      canSendEmail: (profileId) =>
        hasAutomationEmailDeliveryPath(db, profileId, {
          loadConfig: async () => null,
        }),
      getUserTimezone: async () => "UTC",
    });

    const automation = await service.create(
      ORG_ID,
      {
        delivery: { channel: "email", to: "hey@ahmadrosid.com" },
        description: "Daily digest",
        name: "Digest",
        prompt: "Summarize news",
        trigger: { type: "manual" },
      },
      PROFILE_ID
    );

    expect(automation.delivery).toEqual({
      channel: "email",
      to: "hey@ahmadrosid.com",
    });
  });

  test("falls back to the prompt when description is omitted", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });

    // The HTTP route casts the body with readJson, so an absent field reaches
    // create() as undefined however the type is declared.
    const automation = await service.create(
      ORG_ID,
      {
        name: "Nightly pull",
        prompt: "run the tool",
        trigger: { type: "manual" },
      } as Parameters<typeof service.create>[1],
      PROFILE_ID
    );

    expect(automation.description).toBe("run the tool");
  });

  test("defaults schedule timezone from user config", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "Asia/Jakarta",
    });

    const automation = await service.create(
      ORG_ID,
      {
        description: "Morning news",
        name: "HN digest",
        prompt: "Fetch Hacker News headlines",
        trigger: { cron: "0 8 * * *", type: "schedule" },
      },
      PROFILE_ID
    );

    expect(automation.trigger).toEqual({
      cron: "0 8 * * *",
      timezone: "Asia/Jakarta",
      type: "schedule",
    });
    expect(automation.nextRunAt).toBe(
      service.computeNextRunAt(automation.trigger, "Asia/Jakarta")
    );
  });

  test("computes nextRunAt for future runAt triggers", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "Asia/Jakarta",
    });
    const at = new Date(Date.now() + 60_000).toISOString();

    const automation = await service.create(
      ORG_ID,
      {
        description: "One-time",
        name: "Reminder",
        prompt: "Send reminder",
        trigger: { at, type: "runAt" },
      },
      PROFILE_ID
    );

    expect(automation.trigger.type).toBe("runAt");
    expect(automation.nextRunAt).toBe(new Date(at).toISOString());
  });

  test("lists automations only for the active org", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
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

    const orgAutomation = await service.create(
      ORG_ID,
      {
        description: "Scoped",
        name: "Org task",
        prompt: "Run",
        trigger: { type: "manual" },
      },
      PROFILE_ID
    );

    await service.create(
      otherOrgId,
      {
        description: "Hidden",
        name: "Other org task",
        prompt: "Run",
        trigger: { type: "manual" },
      },
      otherProfileId
    );

    const listed = await service.listForOrg(ORG_ID);
    expect(listed.automations.map((entry) => entry.id)).toEqual([
      orgAutomation.id,
    ]);

    expect(await service.get(orgAutomation.id, ORG_ID)).not.toBeNull();
    expect(await service.get(orgAutomation.id, otherOrgId)).toBeNull();
  });

  test("tracks unread runs per user and marks them read", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const userId = "user_test";

    const automation = await service.create(
      ORG_ID,
      {
        description: "Daily digest",
        name: "Digest",
        prompt: "Summarize news",
        trigger: { type: "manual" },
      },
      PROFILE_ID
    );

    await db.insertAutomationRun({
      automationId: automation.id,
      completedAt: "2026-06-29T10:01:00.000Z",
      error: null,
      id: "run_unread_1",
      output: "Summary",
      startedAt: "2026-06-29T10:00:00.000Z",
      status: "completed",
    });

    const unread = await service.getUnreadSummary(ORG_ID, userId);
    expect(unread.totalUnread).toBe(1);
    expect(unread.byAutomationId[automation.id]).toBe(1);

    const runsBeforeRead = await service.listRuns(
      automation.id,
      ORG_ID,
      20,
      userId
    );
    expect(runsBeforeRead[0]?.read).toBe(false);

    await service.markRunsRead(automation.id, ORG_ID, userId);

    const unreadAfter = await service.getUnreadSummary(ORG_ID, userId);
    expect(unreadAfter.totalUnread).toBe(0);

    const runsAfterRead = await service.listRuns(
      automation.id,
      ORG_ID,
      20,
      userId
    );
    expect(runsAfterRead[0]?.read).toBe(true);
  });

  test("deletes a run history item", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });

    const automation = await service.create(
      ORG_ID,
      {
        description: "Daily digest",
        name: "Digest",
        prompt: "Summarize news",
        trigger: { type: "manual" },
      },
      PROFILE_ID
    );

    await db.insertAutomationRun({
      automationId: automation.id,
      completedAt: "2026-06-29T10:01:00.000Z",
      error: null,
      id: "run_delete_me",
      output: "Summary",
      startedAt: "2026-06-29T10:00:00.000Z",
      status: "completed",
    });

    await db.insertAutomationRun({
      automationId: automation.id,
      completedAt: "2026-06-29T11:01:00.000Z",
      error: null,
      id: "run_keep_me",
      output: "Another summary",
      startedAt: "2026-06-29T11:00:00.000Z",
      status: "completed",
    });

    await expect(
      service.deleteRun(automation.id, "run_delete_me", ORG_ID)
    ).resolves.toBe(true);
    await expect(
      service.deleteRun(automation.id, "run_missing", ORG_ID)
    ).resolves.toBe(false);

    const runs = await service.listRuns(automation.id, ORG_ID);
    expect(runs.map((run) => run.id)).toEqual(["run_keep_me"]);
  });
});

describe("AutomationRunner", () => {
  test("does not claim or invoke providers for an archived organization", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const automationId = await seedTelegramAutomation(db, {
      id: "automation_archived_before_run",
      name: "Archived task",
      prompt: "Do not run",
    });
    let promptCalls = 0;
    let deliveryCalls = 0;
    const deliveryService = new AutomationDeliveryService(service, {
      telegram: {
        send: async () => {
          deliveryCalls += 1;
          return { ok: true };
        },
      },
    });
    const runner = createRunner(
      db,
      service,
      {
        runAutomationPrompt: async () => {
          promptCalls += 1;
          return "should not run";
        },
      },
      deliveryService
    );

    expect(await archiveTestOrganization(db)).toBe(true);

    const result = await runner.run(automationId, { principal: PRINCIPAL });

    expect(result).toMatchObject({ skipped: true });
    expect(result.error).toMatch(/organization/i);
    expect(promptCalls).toBe(0);
    expect(deliveryCalls).toBe(0);
    expect(await service.listRuns(automationId)).toHaveLength(0);
    expect(await runner.isRunning(automationId)).toBe(false);
  });

  test("re-checks organization state after claiming and before the prompt", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const automationId = await seedTelegramAutomation(db, {
      id: "automation_archived_before_prompt",
      name: "Archive race task",
      prompt: "Do not run",
    });
    const originalCreateRun = service.createRun.bind(service);
    service.createRun = async (automationId) => {
      const run = await originalCreateRun(automationId);
      expect(await archiveTestOrganization(db)).toBe(true);
      return run;
    };
    let promptCalls = 0;
    let deliveryCalls = 0;
    const deliveryService = new AutomationDeliveryService(service, {
      telegram: {
        send: async () => {
          deliveryCalls += 1;
          return { ok: true };
        },
      },
    });
    const runner = createRunner(
      db,
      service,
      {
        runAutomationPrompt: async () => {
          promptCalls += 1;
          return "should not run";
        },
      },
      deliveryService
    );

    const result = await runner.run(automationId, { principal: PRINCIPAL });

    expect(result).toMatchObject({ skipped: true });
    expect(promptCalls).toBe(0);
    expect(deliveryCalls).toBe(0);
    expect(await runner.isRunning(automationId)).toBe(false);
    const runs = await service.listRuns(automationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      error: "Automation organization is unavailable.",
      status: "failed",
    });
  });

  test("does not deliver when the organization is archived after the prompt", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const automationId = await seedTelegramAutomation(db, {
      id: "automation_archived_before_delivery",
      name: "Archive delivery race",
      prompt: "Archive after generating",
    });
    let promptCalls = 0;
    let deliveryCalls = 0;
    const deliveryService = new AutomationDeliveryService(service, {
      telegram: {
        send: async () => {
          deliveryCalls += 1;
          return { ok: true };
        },
      },
    });
    const runner = createRunner(
      db,
      service,
      {
        runAutomationPrompt: async () => {
          promptCalls += 1;
          expect(await archiveTestOrganization(db)).toBe(true);
          return "Generated while active";
        },
      },
      deliveryService
    );

    const result = await runner.run(automationId, { principal: PRINCIPAL });

    expect(result.output).toBe("Generated while active");
    expect(promptCalls).toBe(1);
    expect(deliveryCalls).toBe(0);
    const runs = await service.listRuns(automationId);
    expect(runs[0]).toMatchObject({
      deliveryError: null,
      deliveryStatus: "skipped",
      status: "completed",
    });
  });

  test("writes completed run records", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });

    const automation = await service.create(
      ORG_ID,
      {
        description: "Run once",
        name: "Manual task",
        prompt: "Say hello",
        trigger: { type: "manual" },
      },
      PROFILE_ID
    );

    const agentService = {
      runAutomationPrompt: async () => "Hello from automation",
    };

    const runner = createRunner(db, service, agentService);
    const result = await runner.run(automation.id, { principal: PRINCIPAL });

    expect(result.output).toBe("Hello from automation");

    const runs = await service.listRuns(automation.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.output).toBe("Hello from automation");
  });

  test("passes automation scope to the agent prompt", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });

    const automation = await service.create(
      ORG_ID,
      {
        description: "Run with history scope",
        name: "Scoped task",
        prompt: "Say hello",
        trigger: { type: "manual" },
      },
      PROFILE_ID
    );

    let received:
      | {
          orgId: string;
          profileId: string;
          prompt: string;
          automationId?: string;
          automationRunId?: string;
        }
      | undefined;

    const agentService = {
      runAutomationPrompt: async (
        orgId: string,
        profileId: string,
        prompt: string,
        automationId?: string,
        automationRunId?: string
      ) => {
        received = { automationId, automationRunId, orgId, profileId, prompt };
        return "Hello from automation";
      },
    };

    const runner = createRunner(db, service, agentService);
    await runner.run(automation.id, { principal: PRINCIPAL });

    const runs = await service.listRuns(automation.id);
    expect(received).toEqual({
      automationId: automation.id,
      automationRunId: runs[0]?.id,
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      prompt: "Say hello",
    });
  });

  test("writes failed run records", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });

    const automation = await service.create(
      ORG_ID,
      {
        description: "Run once",
        name: "Manual task",
        prompt: "Say hello",
        trigger: { type: "manual" },
      },
      PROFILE_ID
    );

    const agentService = {
      runAutomationPrompt: async () => {
        throw new Error("Provider offline");
      },
    };

    const runner = createRunner(db, service, agentService);
    const result = await runner.run(automation.id, { principal: PRINCIPAL });

    expect(result.error).toBe("Provider offline");

    const runs = await service.listRuns(automation.id);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toBe("Provider offline");
  });

  test("disables runAt automations before executing", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const at = new Date(Date.now() + 60_000).toISOString();

    const automation = await service.create(
      ORG_ID,
      {
        description: "One-time",
        name: "Reminder",
        prompt: "Send reminder",
        trigger: { at, type: "runAt" },
      },
      PROFILE_ID
    );

    const agentService = {
      runAutomationPrompt: async () => "Reminder sent",
    };

    const runner = createRunner(db, service, agentService);
    const result = await runner.run(automation.id, { principal: PRINCIPAL });

    expect(result.output).toBe("Reminder sent");

    const updated = await service.get(automation.id, ORG_ID);
    expect(updated?.enabled).toBe(false);
    expect(updated?.nextRunAt).toBeNull();
  });

  test("keeps a one-shot enabled when history write fails", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const at = new Date(Date.now() + 60_000).toISOString();
    const automation = await service.create(
      ORG_ID,
      {
        description: "One-time",
        name: "Reminder",
        prompt: "Send reminder",
        trigger: { at, type: "runAt" },
      },
      PROFILE_ID,
      undefined,
      USER_ID
    );
    service.createRun = async () => {
      throw new Error("history write failed");
    };
    const runner = createRunner(db, service, {
      runAutomationPrompt: async () => "should not run",
    });
    const result = await runner.run(automation.id, {
      fireId: "tick-1",
      principal: PRINCIPAL,
    });
    expect(result.error).toMatch(/history write failed/);
    const updated = await service.get(automation.id, ORG_ID);
    expect(updated?.enabled).toBe(true);
    expect(await service.listRuns(automation.id)).toHaveLength(0);
    const retry = await runner.run(automation.id, {
      fireId: "tick-1",
      principal: PRINCIPAL,
    });
    expect(retry.error).toMatch(/history write failed/);
  });

  test("records delivery status after successful runs", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });

    const now = new Date().toISOString();
    await db.upsertAutomation({
      createdAt: now,
      definition: {
        delivery: { channel: "telegram" },
        description: "Daily digest",
        prompt: "Summarize news",
        steps: [],
        trigger: { type: "manual" },
        version: 1,
      },
      enabled: true,
      id: "automation_delivery_test",
      name: "Digest",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      updatedAt: now,
      version: 1,
    });

    const agentService = {
      runAutomationPrompt: async () => "News summary",
    };

    const deliveryService = new AutomationDeliveryService(service, {
      telegram: {
        send: async () => ({ ok: true }),
      },
    });

    const runner = createRunner(db, service, agentService, deliveryService);
    await runner.run("automation_delivery_test", { principal: PRINCIPAL });

    const runs = await service.listRuns("automation_delivery_test");
    expect(runs[0]?.deliveryStatus).toBe("sent");
  });

  test("records discord delivery status after successful runs", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const now = new Date().toISOString();
    const sent: Array<{ channelId?: string; text: string }> = [];

    await db.upsertAutomation({
      createdAt: now,
      definition: {
        delivery: { channel: "discord" },
        description: "Daily digest",
        prompt: "Summarize news",
        steps: [],
        trigger: { type: "manual" },
        version: 1,
      },
      enabled: true,
      id: "automation_discord_delivery_test",
      name: "Digest",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      updatedAt: now,
      version: 1,
    });

    const deliveryService = new AutomationDeliveryService(service, {
      discord: {
        send: async (input) => {
          sent.push(input);
          return { ok: true };
        },
      },
    });

    const runner = createRunner(
      db,
      service,
      { runAutomationPrompt: async () => "News summary" },
      deliveryService
    );
    await runner.run("automation_discord_delivery_test", {
      principal: PRINCIPAL,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("News summary");

    const runs = await service.listRuns("automation_discord_delivery_test");
    expect(runs[0]?.deliveryStatus).toBe("sent");
  });

  test("skips discord delivery when notifyOn is failure and the run succeeds", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const now = new Date().toISOString();
    let called = false;

    await db.upsertAutomation({
      createdAt: now,
      definition: {
        delivery: { channel: "discord", notifyOn: "failure" },
        description: "Daily digest",
        prompt: "Summarize news",
        steps: [],
        trigger: { type: "manual" },
        version: 1,
      },
      enabled: true,
      id: "automation_discord_skip_test",
      name: "Digest",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      updatedAt: now,
      version: 1,
    });

    const deliveryService = new AutomationDeliveryService(service, {
      discord: {
        send: async () => {
          called = true;
          return { ok: true };
        },
      },
    });

    const runner = createRunner(
      db,
      service,
      { runAutomationPrompt: async () => "News summary" },
      deliveryService
    );
    await runner.run("automation_discord_skip_test", { principal: PRINCIPAL });

    expect(called).toBe(false);
    const runs = await service.listRuns("automation_discord_skip_test");
    expect(runs[0]?.deliveryStatus).toBe("skipped");
  });

  test("records discord delivery failure from the adapter", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const now = new Date().toISOString();

    await db.upsertAutomation({
      createdAt: now,
      definition: {
        delivery: { channel: "discord", channelId: "123456789012345678" },
        description: "Daily digest",
        prompt: "Summarize news",
        steps: [],
        trigger: { type: "manual" },
        version: 1,
      },
      enabled: true,
      id: "automation_discord_fail_test",
      name: "Digest",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      updatedAt: now,
      version: 1,
    });

    const deliveryService = new AutomationDeliveryService(service, {
      discord: {
        send: async () => ({
          error: "Discord API error (403): missing access",
          ok: false,
        }),
      },
    });

    const runner = createRunner(
      db,
      service,
      { runAutomationPrompt: async () => "News summary" },
      deliveryService
    );
    await runner.run("automation_discord_fail_test", { principal: PRINCIPAL });

    const runs = await service.listRuns("automation_discord_fail_test");
    expect(runs[0]?.deliveryStatus).toBe("failed");
    expect(runs[0]?.deliveryError).toContain("403");
  });

  test("delivers automation email through composeio MCP when SMTP is unavailable", async () => {
    const db = await createTestDb();
    await assignComposeioGmailSender(db, PROFILE_ID);

    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const now = new Date().toISOString();
    const sent: Record<string, unknown>[] = [];

    await db.upsertAutomation({
      createdAt: now,
      definition: {
        delivery: { channel: "email", to: "hey@ahmadrosid.com" },
        description: "Daily digest",
        prompt: "Summarize news",
        steps: [],
        trigger: { type: "manual" },
        version: 1,
      },
      enabled: true,
      id: "automation_email_delivery_test",
      name: "Digest",
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      updatedAt: now,
      version: 1,
    });

    const manager = {
      callTool: async (
        _serverId: string,
        _transport: string,
        _toolName: string,
        input: unknown
      ) => {
        sent.push(input as Record<string, unknown>);
        return { ok: true };
      },
      connect: async () => [],
      ensureConnected: async () => undefined,
      isConnected: () => true,
    };

    const deliveryService = new AutomationDeliveryService(service, {
      email: createMcpAwareEmailOutboundAdapter(db, manager as never, {
        loadConfig: async () => null,
      }),
    });

    const agentService = {
      runAutomationPrompt: async () => "News summary",
    };

    const runner = createRunner(db, service, agentService, deliveryService);
    await runner.run("automation_email_delivery_test", {
      principal: PRINCIPAL,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      body: expect.stringContaining("News summary"),
      subject: "[Atlas] Digest — completed",
      to: "hey@ahmadrosid.com",
    });

    const runs = await service.listRuns("automation_email_delivery_test");
    expect(runs[0]?.deliveryStatus).toBe("sent");
  });

  test("maps composeio-style schema aliases when calling MCP email tools", async () => {
    const db = await createTestDb();
    await assignComposeioGmailSender(db, PROFILE_ID, {
      properties: {
        message_body: { type: "string" },
        recipient_email: { type: "string" },
        title: { type: "string" },
      },
      type: "object",
    });

    const sent: Record<string, unknown>[] = [];
    const adapter = createMcpAwareEmailOutboundAdapter(
      db,
      {
        callTool: async (
          _serverId: string,
          _transport: string,
          _toolName: string,
          input: unknown
        ) => {
          sent.push(input as Record<string, unknown>);
          return { ok: true };
        },
        connect: async () => [],
        ensureConnected: async () => undefined,
        isConnected: () => true,
      } as never,
      { loadConfig: async () => null }
    );

    await adapter.send({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      subject: "Daily digest",
      text: "Hello world",
      to: "hey@ahmadrosid.com",
    });

    expect(sent).toEqual([
      {
        message_body: "Hello world",
        recipient_email: "hey@ahmadrosid.com",
        title: "Daily digest",
      },
    ]);
  });

  test("claims via lease and skips a second concurrent fire", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const automation = await service.create(
      ORG_ID,
      {
        description: "Lease claim",
        name: "Lease task",
        prompt: "Say hello",
        trigger: { type: "manual" },
      },
      PROFILE_ID,
      undefined,
      USER_ID
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let promptStarted = false;
    const agentService = {
      runAutomationPrompt: async (
        _orgId: string,
        _profileId: string,
        _prompt: string,
        _automationId?: string,
        _automationRunId?: string,
        principal?: { userId: string }
      ) => {
        expect(principal?.userId).toBe(USER_ID);
        promptStarted = true;
        await gate;
        return "first";
      },
    };
    const plane = new ExecutionPlaneService(db);
    const identity = new IdentityService(db);
    const runnerA = new AutomationRunner(
      service,
      agentService as never,
      undefined,
      plane,
      identity
    );
    const runnerB = new AutomationRunner(
      service,
      agentService as never,
      undefined,
      plane,
      identity
    );

    const first = runnerA.run(automation.id, {
      fireId: "tick-1",
      principal: PRINCIPAL,
    });
    const startedAt = Date.now();
    while (!promptStarted && Date.now() - startedAt < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(promptStarted).toBe(true);
    const second = await runnerB.run(automation.id, {
      fireId: "tick-2",
      principal: PRINCIPAL,
    });
    expect(second.skipped).toBe(true);
    expect(second.error).toMatch(/already running/);
    release();
    const firstResult = await first;
    expect(firstResult.output).toBe("first");
  });

  test("fail closed without a principal or stored owner", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const automation = await service.create(
      ORG_ID,
      {
        description: "No owner",
        name: "Orphan",
        prompt: "Say hello",
        trigger: { type: "manual" },
      },
      PROFILE_ID
    );
    const runner = createRunner(db, service, {
      runAutomationPrompt: async () => "should not run",
    });
    const result = await runner.run(automation.id);
    expect(result.skipped).toBe(true);
    expect(result.error).toMatch(/principal/i);
    expect(await service.listRuns(automation.id)).toHaveLength(0);
  });

  test("demoted viewers cannot run scheduled automations", async () => {
    const db = await createTestDb();
    await db.upsertOrgMember({
      createdAt: new Date().toISOString(),
      orgId: ORG_ID,
      role: "viewer",
      userId: USER_ID,
    });
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const automation = await service.create(
      ORG_ID,
      {
        description: "Viewer",
        name: "Blocked",
        prompt: "Say hello",
        trigger: { type: "manual" },
      },
      PROFILE_ID,
      undefined,
      USER_ID
    );
    const runner = createRunner(db, service, {
      runAutomationPrompt: async () => "should not run",
    });
    const result = await runner.run(automation.id, { fireId: "tick-1" });
    expect(result.skipped).toBe(true);
    expect(result.error).toMatch(/viewer/i);
    expect(await service.listRuns(automation.id)).toHaveLength(0);
  });

  test("replays the same fire idempotency key without a second automation run", async () => {
    const db = await createTestDb();
    const service = new AutomationService(db, {
      getUserTimezone: async () => "UTC",
    });
    const automation = await service.create(
      ORG_ID,
      {
        description: "Idempotent",
        name: "Once",
        prompt: "Say hello",
        trigger: { type: "manual" },
      },
      PROFILE_ID,
      undefined,
      USER_ID
    );
    const runner = createRunner(db, service, {
      runAutomationPrompt: async () => "hello",
    });
    const first = await runner.run(automation.id, {
      fireId: "cron-1",
      principal: PRINCIPAL,
    });
    const second = await runner.run(automation.id, {
      fireId: "cron-1",
      principal: PRINCIPAL,
    });
    expect(first.output).toBe("hello");
    expect(second.skipped).toBe(true);
    expect(await service.listRuns(automation.id)).toHaveLength(1);
  });
});
