import type {
  AutomationTrigger,
  DiscordWorkerStatus,
  HealthResponse,
  LlmUsageModelStats,
  LlmUsageStatus,
  SystemStatusResponse,
  WhatsAppWorkerStatus,
  WorkerProcessInfo,
} from "@atlas/core";
import {
  ATLAS_API_VERSION,
  getAutomationWorkerHeartbeatStatus,
  getDiscordWorkerStatus,
  getTelegramWorkerStatus,
  getWhatsAppWorkerStatus,
  isComposioConfiguredAsync,
  isWorkerSchedulable,
} from "@atlas/core";
import type { DatabaseAdapter, StoredAutomationRecord } from "@atlas/db";
import type { AgentService } from "./agent-service";
import type { AutomationRunner } from "./automation-runner";
import type { ComposioService } from "./composio-service";
import type { McpService } from "./mcp-service";
import type { TaskRunner } from "./task-runner";
import type { WorkerManagerService } from "./worker-manager-service";

export class SystemStatusService {
  constructor(
    private readonly agent: AgentService,
    private readonly automationRunner: AutomationRunner,
    private readonly taskRunner: TaskRunner,
    private readonly workerManager: WorkerManagerService,
    private readonly mcpService: McpService | null = null,
    private readonly composioService: ComposioService | null = null,
    private readonly databaseAdapter: DatabaseAdapter | null = null
  ) {}

  async getStatus(orgId?: string): Promise<SystemStatusResponse> {
    const usageFields = orgId
      ? await this.agent.getUsageStatusFieldsForOrg(orgId)
      : {
          ...this.agent.getUsageStatusFields(),
          providerConfigured: this.agent.providerConfigured,
        };
    const providerConfigured = usageFields.providerConfigured;
    const models = await this.agent.getModels(orgId);

    const statuses = await this.workerManager.getAllWorkerStatuses();
    const automationProcess = statuses.automation ?? null;
    const automationHeartbeat = await getAutomationWorkerHeartbeatStatus();
    const automationRunning = automationHeartbeat.running;
    const automationManagedOnline =
      automationProcess?.managed === true &&
      automationProcess.status === "online";
    const automationCounts = orgId
      ? await this.getWorkspaceAutomationCounts(orgId)
      : {
          activeRuns: this.automationRunner.getActiveRunCount(),
          scheduledJobs: automationRunning
            ? automationHeartbeat.scheduledJobs
            : 0,
        };

    const canReadWorkspaceProcesses =
      typeof this.workerManager.getWorkspaceWorkerStatus === "function";
    const workspaceProcesses =
      orgId && canReadWorkspaceProcesses
        ? await Promise.all([
            this.workerManager.getWorkspaceWorkerStatus("telegram", orgId),
            this.workerManager.getWorkspaceWorkerStatus("whatsapp", orgId),
            this.workerManager.getWorkspaceWorkerStatus("discord", orgId),
          ])
        : [statuses.telegram, statuses.whatsapp, statuses.discord];
    const [telegramStatus, whatsappStatus, discordStatus] = await Promise.all([
      this.resolveWorkerStatus(
        "telegram",
        workspaceProcesses[0] ?? null,
        orgId
      ),
      this.resolveWorkerStatus(
        "whatsapp",
        workspaceProcesses[1] ?? null,
        orgId
      ),
      this.resolveWorkerStatus("discord", workspaceProcesses[2] ?? null, orgId),
    ]);

    return {
      automationWorker: {
        activeRuns: automationCounts.activeRuns,
        ok: automationManagedOnline && automationRunning,
        process: automationProcess ?? undefined,
        providerConfigured,
        running: automationRunning,
        scheduledJobs: automationCounts.scheduledJobs,
      },
      checkedAt: new Date().toISOString(),
      discordWorker: discordStatus as DiscordWorkerStatus,
      llmUsage: await this.getLlmUsage(
        orgId,
        models.provider,
        usageFields.currentModel,
        providerConfigured,
        usageFields
      ),
      mcp: this.mcpService
        ? await this.mcpService.getStatusSummary(orgId)
        : { assignedProfileCount: 0, connectedCount: 0, serverCount: 0 },
      server: await this.getServerStatus(providerConfigured),
      taskWorker: {
        activeRuns: orgId
          ? await this.countWorkspaceTaskRuns(orgId)
          : this.taskRunner.getActiveRunCount(),
        ok: true,
        providerConfigured,
      },
      telegramWorker: telegramStatus,
      whatsappWorker: whatsappStatus as WhatsAppWorkerStatus,
    };
  }

  private async resolveWorkerStatus(
    name: "telegram" | "whatsapp" | "discord",
    processStatus: WorkerProcessInfo | null,
    orgId?: string
  ) {
    const isOnline = processStatus?.status === "online";

    if (name === "telegram") {
      const heartbeat = await getTelegramWorkerStatus(orgId);
      return {
        ...heartbeat,
        process: processStatus ?? undefined,
        running: isOnline || heartbeat.running,
      };
    }

    if (name === "discord") {
      const heartbeat = await getDiscordWorkerStatus(orgId);
      return {
        ...heartbeat,
        process: processStatus ?? undefined,
        running: isOnline || heartbeat.running,
      };
    }

    const heartbeat = await getWhatsAppWorkerStatus(orgId);
    return {
      ...heartbeat,
      process: processStatus ?? undefined,
      running: isOnline || heartbeat.running,
    };
  }

  private async getLlmUsage(
    orgId: string | undefined,
    provider: LlmUsageStatus["provider"],
    currentModel: string | null,
    providerConfigured: boolean,
    usageFields: { displayName: string | null; costEstimated: boolean }
  ): Promise<LlmUsageStatus> {
    const usage = orgId
      ? await this.getWorkspaceLlmUsage(orgId)
      : {
          ...this.agent.getLlmUsageStats(),
          models: this.agent.getLlmUsageStatsByModel(),
        };

    return {
      ...usage,
      costEstimated: usageFields.costEstimated,
      currentModel,
      displayName: usageFields.displayName,
      provider,
      providerConfigured,
    };
  }

  private async getWorkspaceLlmUsage(orgId: string): Promise<{
    estimatedCostUsd: number;
    inputTokens: number;
    models: LlmUsageModelStats[];
    outputTokens: number;
    requestCount: number;
    totalTokens: number;
    trackedSince: string;
  }> {
    const empty = {
      estimatedCostUsd: 0,
      inputTokens: 0,
      models: [] as LlmUsageModelStats[],
      outputTokens: 0,
      requestCount: 0,
      totalTokens: 0,
      trackedSince: new Date().toISOString(),
    };

    if (!this.databaseAdapter) {
      return empty;
    }

    const rows = await this.databaseAdapter.aggregateLlmUsage({
      groupBy: "model",
      orgId,
    });
    const trackedSince = empty.trackedSince;
    const models: LlmUsageModelStats[] = rows.map((row) => ({
      estimatedCostUsd: row.estimatedCostUsd,
      inputTokens: row.inputTokens,
      modelId: row.key,
      outputTokens: row.outputTokens,
      requestCount: row.requestCount,
      totalTokens: row.totalTokens,
      trackedSince,
    }));
    const totals = models.reduce(
      (sum, model) => ({
        estimatedCostUsd: sum.estimatedCostUsd + model.estimatedCostUsd,
        inputTokens: sum.inputTokens + model.inputTokens,
        outputTokens: sum.outputTokens + model.outputTokens,
        requestCount: sum.requestCount + model.requestCount,
        totalTokens: sum.totalTokens + model.totalTokens,
      }),
      {
        estimatedCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        requestCount: 0,
        totalTokens: 0,
      }
    );

    return { ...totals, models, trackedSince };
  }

  private async getWorkspaceAutomationCounts(orgId: string): Promise<{
    activeRuns: number;
    scheduledJobs: number;
  }> {
    const automations =
      (await this.databaseAdapter?.listAutomationsForOrg(orgId)) ?? [];
    const scheduledJobs = automations.filter((record) =>
      isWorkerSchedulable({
        enabled: record.enabled,
        trigger: automationTrigger(record),
      })
    ).length;
    const runningIds =
      typeof this.automationRunner.getActiveAutomationIds === "function"
        ? this.automationRunner.getActiveAutomationIds()
        : [];
    const automationIds = new Set(automations.map((record) => record.id));
    const activeRuns = runningIds.filter((id) => automationIds.has(id)).length;

    return { activeRuns, scheduledJobs };
  }

  private async countWorkspaceTaskRuns(orgId: string): Promise<number> {
    if (typeof this.taskRunner.getActiveTaskIds !== "function") {
      return 0;
    }

    const runningIds = this.taskRunner.getActiveTaskIds();
    if (!(this.databaseAdapter && runningIds.length > 0)) {
      return 0;
    }

    const tasks = await Promise.all(
      runningIds.map((id) => this.databaseAdapter?.getTask(id))
    );
    return tasks.filter((task) => task?.orgId === orgId).length;
  }

  private async getServerStatus(
    providerConfigured: boolean
  ): Promise<HealthResponse> {
    const composioConfigured = await isComposioConfiguredAsync();
    const humanUserCount = (await this.databaseAdapter?.countHumanUsers()) ?? 0;

    return {
      apiVersion: ATLAS_API_VERSION,
      // Live probe — intentional here; /health skips this to stay fast.
      composioAvailable: composioConfigured
        ? await (this.composioService?.isReachable() ?? false)
        : false,
      composioConfigured,
      ok: true,
      providerConfigured,
      userConfigured: humanUserCount > 0,
    };
  }
}

function automationTrigger(record: StoredAutomationRecord): AutomationTrigger {
  if (typeof record.definition !== "object" || record.definition === null) {
    return { type: "manual" };
  }

  const trigger = (record.definition as { trigger?: AutomationTrigger })
    .trigger;

  if (!trigger || typeof trigger !== "object" || !("type" in trigger)) {
    return { type: "manual" };
  }

  return trigger;
}
