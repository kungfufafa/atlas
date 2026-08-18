import type {
  DiscordWorkerStatus,
  HealthResponse,
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
} from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";
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
        activeRuns: this.automationRunner.getActiveRunCount(),
        ok: automationManagedOnline && automationRunning,
        process: automationProcess ?? undefined,
        providerConfigured,
        running: automationRunning,
        scheduledJobs: automationRunning
          ? automationHeartbeat.scheduledJobs
          : 0,
      },
      checkedAt: new Date().toISOString(),
      discordWorker: discordStatus as DiscordWorkerStatus,
      llmUsage: this.getLlmUsage(
        models.provider,
        usageFields.currentModel,
        providerConfigured,
        usageFields,
        this.agent.getLlmUsageStatsByModel()
      ),
      mcp: this.mcpService
        ? await this.mcpService.getStatusSummary()
        : { assignedProfileCount: 0, connectedCount: 0, serverCount: 0 },
      server: await this.getServerStatus(providerConfigured),
      taskWorker: {
        activeRuns: this.taskRunner.getActiveRunCount(),
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

  private getLlmUsage(
    provider: LlmUsageStatus["provider"],
    currentModel: string | null,
    providerConfigured: boolean,
    usageFields: { displayName: string | null; costEstimated: boolean },
    models: LlmUsageStatus["models"]
  ): LlmUsageStatus {
    return {
      ...this.agent.getLlmUsageStats(),
      costEstimated: usageFields.costEstimated,
      currentModel,
      displayName: usageFields.displayName,
      models,
      provider,
      providerConfigured,
    };
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
