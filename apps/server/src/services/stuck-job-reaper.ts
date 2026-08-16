import { metrics } from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";

export interface ExecutionLease {
  jobId: string;
  lastHeartbeatAt: number;
  leaseTtlMs: number;
  onCancel?: () => Promise<void> | void;
  startedAt: number;
  type: "chat" | "research" | "browser" | "artifact" | "office";
  workerId: string;
}

export class StuckJobReaper {
  private activeLeases = new Map<string, ExecutionLease>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly _db?: DatabaseAdapter,
    private readonly checkIntervalMs = 5000
  ) {}

  start(): void {
    if (this.intervalHandle) {
      return;
    }
    this.intervalHandle = setInterval(() => {
      this.reapStuckJobs().catch(() => {});
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  registerLease(lease: Omit<ExecutionLease, "lastHeartbeatAt">): void {
    this.activeLeases.set(lease.jobId, {
      ...lease,
      lastHeartbeatAt: Date.now(),
    });
  }

  heartbeat(jobId: string): boolean {
    const lease = this.activeLeases.get(jobId);
    if (!lease) {
      return false;
    }
    lease.lastHeartbeatAt = Date.now();
    return true;
  }

  releaseLease(jobId: string): boolean {
    return this.activeLeases.delete(jobId);
  }

  async reapStuckJobs(): Promise<number> {
    const now = Date.now();
    let reapedCount = 0;

    for (const [jobId, lease] of this.activeLeases.entries()) {
      const elapsedSinceHeartbeat = now - lease.lastHeartbeatAt;
      if (elapsedSinceHeartbeat > lease.leaseTtlMs) {
        metrics.cancellationZombieDetectedTotal.inc();
        this.activeLeases.delete(jobId);
        reapedCount += 1;

        try {
          if (lease.onCancel) {
            await lease.onCancel();
          }
        } catch {
          // Swallow cleanup errors during reaping
        }
      }
    }

    return reapedCount;
  }

  getActiveLeasesCount(): number {
    return this.activeLeases.size;
  }
}

export const stuckJobReaper = new StuckJobReaper();
