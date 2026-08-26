import type { AtlasClient } from "@atlas/client";
import {
  AutomationScheduler,
  type AutomationSchedulerDelegate,
  type AutomationSchedulerStatus,
} from "@atlas/core/automation-scheduler";
import type { AutomationSchedule } from "@atlas/core/contract";
import { tickSkillCurator } from "./curator-tick";

export interface AutomationWorkerSchedulerDelegate
  extends AutomationSchedulerDelegate {}

export class AutomationWorkerScheduler {
  private readonly scheduler: AutomationScheduler;
  private polling = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: AtlasClient,
    private readonly onStatusChange?: (
      status: AutomationSchedulerStatus
    ) => void
  ) {
    this.scheduler = new AutomationScheduler({
      getDefaultTimezone: () => this.fetchDefaultTimezone(),
      listScheduledAutomations: () => this.fetchSchedules(),
      runAutomation: (id, fireId, orgId) =>
        this.runAutomation(id, fireId, orgId),
    });
  }

  async start(): Promise<void> {
    await this.scheduler.start();
    await this.tickCurator();
    this.notifyStatus();
  }

  stop(): void {
    this.stopPolling();
    this.scheduler.stop();
    this.notifyStatus();
  }

  beginPolling(intervalMs: number): void {
    this.stopPolling();

    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
  }

  async pollOnce(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      try {
        await this.scheduler.reload();
      } catch (error) {
        console.error("Failed to reload automation schedules:", error);
      }
      await this.tickCurator();
      this.notifyStatus();
    } finally {
      this.polling = false;
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async fetchSchedules(): Promise<AutomationSchedule[]> {
    return this.client.listAutomationSchedules();
  }

  private async tickCurator(): Promise<void> {
    try {
      await tickSkillCurator(this.client);
    } catch (error) {
      console.error("Failed to tick skill curator:", error);
    }
  }

  private async runAutomation(
    automationId: string,
    fireId: string,
    orgId: string
  ): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
    try {
      await this.client.runAutomationInternal(automationId, fireId, orgId);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message, ok: false };
    }
  }

  private async fetchDefaultTimezone(): Promise<string> {
    try {
      return await this.client.getTimezone();
    } catch {
      return "UTC";
    }
  }

  getStatus(): AutomationSchedulerStatus {
    return this.scheduler.getStatus();
  }

  private notifyStatus(): void {
    this.onStatusChange?.(this.scheduler.getStatus());
  }
}
