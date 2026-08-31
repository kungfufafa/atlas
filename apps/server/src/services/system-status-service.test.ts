import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAutomationWorkerHeartbeat,
  getWhatsAppConfigDir,
  getWhatsAppConfigPath,
  getWhatsAppDevicePairingCodePath,
  getWhatsAppQrCodePath,
  saveComposioConfig,
  type WorkerProcessInfo,
  writeAutomationWorkerHeartbeat,
  writePrivateTextFile,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { SystemStatusService } from "./system-status-service";

let configDir: string | null = null;

afterEach(async () => {
  await clearAutomationWorkerHeartbeat();

  if (configDir) {
    await rm(configDir, { force: true, recursive: true });
    configDir = null;
  }

  delete process.env.ATLAS_CONFIG_DIR;
});

async function withConfigDir(): Promise<void> {
  configDir = await mkdtemp(join(tmpdir(), "atlas-system-status-"));
  process.env.ATLAS_CONFIG_DIR = configDir;
}

function createService(
  automationProcess: WorkerProcessInfo | null,
  extras?: {
    composioService?: { isReachable: () => Promise<boolean> } | null;
    databaseAdapter?: ReturnType<typeof createInMemoryDatabaseAdapter>;
    getActiveAutomationIds?: () => string[];
    getActiveTaskIds?: () => string[];
  }
) {
  return new SystemStatusService(
    {
      getLlmUsageStats: () => ({
        estimatedCostUsd: 99,
        inputTokens: 9000,
        outputTokens: 900,
        requestCount: 99,
        totalTokens: 9900,
        trackedSince: new Date().toISOString(),
      }),
      getLlmUsageStatsByModel: () => [
        {
          estimatedCostUsd: 99,
          inputTokens: 9000,
          modelId: "host-wide-model",
          outputTokens: 900,
          requestCount: 99,
          totalTokens: 9900,
          trackedSince: new Date().toISOString(),
        },
      ],
      getModels: async () => ({ models: [], provider: "openai" }),
      getUsageStatusFields: () => ({
        costEstimated: false,
        currentModel: "gpt-4o",
        displayName: "OpenAI",
      }),
      getUsageStatusFieldsForOrg: async () => ({
        costEstimated: false,
        currentModel: "gpt-4o",
        displayName: "OpenAI",
        providerConfigured: true,
      }),
      providerConfigured: true,
    } as any,
    {
      getActiveAutomationIds: extras?.getActiveAutomationIds ?? (() => []),
      getActiveRunCount: () => 2,
    } as any,
    {
      getActiveRunCount: () => 1,
      getActiveTaskIds: extras?.getActiveTaskIds ?? (() => []),
    } as any,
    {
      getAllWorkerStatuses: async () => ({
        automation: automationProcess,
        discord: null,
        telegram: null,
        whatsapp: null,
      }),
    } as any,
    null,
    extras?.composioService as any,
    extras?.databaseAdapter ?? null
  );
}

describe("SystemStatusService", () => {
  test("reports automation worker from PM2 status plus fresh heartbeat", async () => {
    await withConfigDir();
    await writeAutomationWorkerHeartbeat(true, 5, process.pid);

    const service = createService({
      cpuPercent: 1.2,
      managed: true,
      memoryMb: 12.5,
      status: "online",
      uptimeSeconds: 30,
    });

    const status = await service.getStatus();

    expect(status.automationWorker).toEqual({
      activeRuns: 2,
      ok: true,
      process: {
        cpuPercent: 1.2,
        managed: true,
        memoryMb: 12.5,
        status: "online",
        uptimeSeconds: 30,
      },
      providerConfigured: true,
      running: true,
      scheduledJobs: 5,
    });
    expect(status.llmUsage.requestCount).toBe(99);
    expect(status.llmUsage.models[0]?.modelId).toBe("host-wide-model");
    expect(status.taskWorker.activeRuns).toBe(1);
  });

  test("reports automation worker not ok when heartbeat is stale", async () => {
    await withConfigDir();
    await writeAutomationWorkerHeartbeat(
      true,
      5,
      process.pid,
      new Date(Date.now() - 60_000).toISOString()
    );

    const service = createService({
      cpuPercent: 0,
      managed: true,
      memoryMb: 0,
      status: "online",
      uptimeSeconds: 30,
    });

    const status = await service.getStatus();

    expect(status.automationWorker.ok).toBe(false);
    expect(status.automationWorker.running).toBe(false);
    expect(status.automationWorker.scheduledJobs).toBe(0);
  });

  test("never includes WhatsApp pairing secrets in general status", async () => {
    await withConfigDir();
    const orgId = "org_status_secret";
    await writePrivateTextFile(
      getWhatsAppConfigPath(orgId),
      "profile_id=default\naccess_mode=pairing\n",
      { ensureDir: getWhatsAppConfigDir(orgId) }
    );
    await writePrivateTextFile(getWhatsAppQrCodePath(orgId), "qr-secret", {
      ensureDir: getWhatsAppConfigDir(orgId),
    });
    await writePrivateTextFile(
      getWhatsAppDevicePairingCodePath(orgId),
      "device-secret",
      { ensureDir: getWhatsAppConfigDir(orgId) }
    );

    const status = await createService(null).getStatus(orgId);

    expect(status.whatsappWorker.qrCode).toBeNull();
    expect(status.whatsappWorker.devicePairingCode).toBeNull();
  });

  test("reports automation worker process when PM2 is unavailable", async () => {
    await withConfigDir();

    const service = createService({
      cpuPercent: null,
      managed: false,
      memoryMb: null,
      status: null,
      uptimeSeconds: null,
    });

    const status = await service.getStatus();

    expect(status.automationWorker.ok).toBe(false);
    expect(status.automationWorker.process?.managed).toBe(false);
  });

  test("probes Composio reachability on system status when configured", async () => {
    await withConfigDir();
    await saveComposioConfig({ apiKey: "test-key" });

    let reachabilityCalls = 0;
    const service = createService(null, {
      composioService: {
        isReachable: async () => {
          reachabilityCalls += 1;
          return true;
        },
      },
    });

    const status = await service.getStatus();

    expect(reachabilityCalls).toBe(1);
    expect(status.server).toMatchObject({
      composioAvailable: true,
      composioConfigured: true,
    });
  });

  test("scopes LLM usage, scheduled jobs, and active runs to the requested workspace", async () => {
    await withConfigDir();
    await writeAutomationWorkerHeartbeat(true, 5, process.pid);

    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();

    await db.incrementLlmUsageDaily(
      {
        capability: "chat.completion",
        channel: "web",
        modelId: "gpt-workspace-a",
        orgId: "org_a",
        profileId: "p_a",
        providerCredentialId: "cred_a",
        providerType: "openai",
        userId: "user_a",
      },
      {
        estimatedCostUsd: 0.02,
        inputTokens: 100,
        outputTokens: 20,
        requestCount: 2,
      }
    );
    await db.incrementLlmUsageDaily(
      {
        capability: "chat.completion",
        channel: "web",
        modelId: "claude-workspace-b",
        orgId: "org_b",
        profileId: "p_b",
        providerCredentialId: "cred_b",
        providerType: "anthropic",
        userId: "user_b",
      },
      {
        estimatedCostUsd: 1.5,
        inputTokens: 8000,
        outputTokens: 400,
        requestCount: 40,
      }
    );

    await db.upsertAutomation({
      createdAt: now,
      definition: {
        prompt: "Digest A",
        trigger: { cron: "0 9 * * *", type: "schedule" },
      },
      enabled: true,
      id: "auto_a_scheduled",
      name: "Workspace A digest",
      orgId: "org_a",
      profileId: "p_a",
      updatedAt: now,
      version: 1,
    });
    await db.upsertAutomation({
      createdAt: now,
      definition: {
        prompt: "Manual A",
        trigger: { type: "manual" },
      },
      enabled: true,
      id: "auto_a_manual",
      name: "Workspace A manual",
      orgId: "org_a",
      profileId: "p_a",
      updatedAt: now,
      version: 1,
    });
    await db.upsertAutomation({
      createdAt: now,
      definition: {
        prompt: "Digest B",
        trigger: { cron: "0 9 * * *", type: "schedule" },
      },
      enabled: true,
      id: "auto_b_scheduled",
      name: "Workspace B digest",
      orgId: "org_b",
      profileId: "p_b",
      updatedAt: now,
      version: 1,
    });

    await db.upsertTask({
      createdAt: now,
      description: "A",
      id: "task_a",
      orgId: "org_a",
      position: 0,
      profileId: "p_a",
      prompt: "Do A",
      status: "running",
      title: "Task A",
      updatedAt: now,
    });
    await db.upsertTask({
      createdAt: now,
      description: "B",
      id: "task_b",
      orgId: "org_b",
      position: 0,
      profileId: "p_b",
      prompt: "Do B",
      status: "running",
      title: "Task B",
      updatedAt: now,
    });

    const service = createService(
      {
        cpuPercent: 1.2,
        managed: true,
        memoryMb: 12.5,
        status: "online",
        uptimeSeconds: 30,
      },
      {
        databaseAdapter: db,
        getActiveAutomationIds: () => [
          "auto_a_scheduled",
          "auto_a_manual",
          "auto_b_scheduled",
        ],
        getActiveTaskIds: () => ["task_a", "task_b"],
      }
    );

    const status = await service.getStatus("org_a");

    expect(status.automationWorker.scheduledJobs).toBe(1);
    expect(status.automationWorker.activeRuns).toBe(2);
    expect(status.taskWorker.activeRuns).toBe(1);
    expect(status.llmUsage).toMatchObject({
      estimatedCostUsd: 0.02,
      inputTokens: 100,
      outputTokens: 20,
      requestCount: 2,
      totalTokens: 120,
    });
    expect(status.llmUsage.models).toEqual([
      expect.objectContaining({
        modelId: "gpt-workspace-a",
        requestCount: 2,
        totalTokens: 120,
      }),
    ]);
  });
});
