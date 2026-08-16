import { AtlasApiError } from "../api-error";
import { metrics } from "../telemetry/metrics";

export type ResourceType =
  | "provider"
  | "browser"
  | "research"
  | "office_conversion"
  | "artifact_generation"
  | "subagent";

export interface ResourceCapacityConfig {
  artifact_generation?: number;
  browser?: number;
  office_conversion?: number;
  provider?: number;
  research?: number;
  subagent?: number;
}

export interface ResourceTelemetry {
  acquireAttempts: number;
  acquireCancelled: number;
  acquireRejected: number;
  acquireSuccess: number;
  capacity: number;
  currentActive: number;
  currentWaiting: number;
  peakActive: number;
  totalHoldTimeMs: number;
}

export const DEFAULT_RESOURCE_CAPACITIES: Record<ResourceType, number> = {
  artifact_generation: 20,
  browser: 8,
  office_conversion: 5,
  provider: 50,
  research: 15,
  subagent: 20,
};

interface WaitingAcquire {
  enqueuedAt: number;
  reject: (err: unknown) => void;
  resolve: () => void;
  signal?: AbortSignal;
}

export class ResourceLimiter {
  private activeCounts = new Map<ResourceType, number>();
  private waitingQueues = new Map<ResourceType, WaitingAcquire[]>();
  private attempts = new Map<ResourceType, number>();
  private successes = new Map<ResourceType, number>();
  private cancelled = new Map<ResourceType, number>();
  private rejected = new Map<ResourceType, number>();
  private peakCounts = new Map<ResourceType, number>();
  private holdTimes = new Map<ResourceType, number>();
  private readonly capacities: Record<ResourceType, number>;

  constructor(customCapacities: ResourceCapacityConfig = {}) {
    this.capacities = { ...DEFAULT_RESOURCE_CAPACITIES, ...customCapacities };
    for (const res of Object.keys(
      DEFAULT_RESOURCE_CAPACITIES
    ) as ResourceType[]) {
      this.activeCounts.set(res, 0);
      this.waitingQueues.set(res, []);
      this.attempts.set(res, 0);
      this.successes.set(res, 0);
      this.cancelled.set(res, 0);
      this.rejected.set(res, 0);
      this.peakCounts.set(res, 0);
      this.holdTimes.set(res, 0);
    }
  }

  getActive(resource: ResourceType): number {
    return this.activeCounts.get(resource) ?? 0;
  }

  getCapacity(resource: ResourceType): number {
    return this.capacities[resource] ?? 10;
  }

  getWaitingCount(resource: ResourceType): number {
    return this.waitingQueues.get(resource)?.length ?? 0;
  }

  getTelemetry(resource: ResourceType): ResourceTelemetry {
    return {
      acquireAttempts: this.attempts.get(resource) ?? 0,
      acquireCancelled: this.cancelled.get(resource) ?? 0,
      acquireRejected: this.rejected.get(resource) ?? 0,
      acquireSuccess: this.successes.get(resource) ?? 0,
      capacity: this.getCapacity(resource),
      currentActive: this.getActive(resource),
      currentWaiting: this.getWaitingCount(resource),
      peakActive: this.peakCounts.get(resource) ?? 0,
      totalHoldTimeMs: this.holdTimes.get(resource) ?? 0,
    };
  }

  getAllTelemetry(): Record<ResourceType, ResourceTelemetry> {
    const result: Partial<Record<ResourceType, ResourceTelemetry>> = {};
    for (const res of Object.keys(
      DEFAULT_RESOURCE_CAPACITIES
    ) as ResourceType[]) {
      result[res] = this.getTelemetry(res);
    }
    return result as Record<ResourceType, ResourceTelemetry>;
  }

  async acquire(
    resource: ResourceType,
    signal?: AbortSignal
  ): Promise<() => void> {
    this.attempts.set(resource, (this.attempts.get(resource) ?? 0) + 1);

    if (signal?.aborted) {
      this.cancelled.set(resource, (this.cancelled.get(resource) ?? 0) + 1);
      throw new AtlasApiError(
        `Acquisition for resource [${resource}] aborted before queueing.`,
        499,
        "CANCELLED"
      );
    }

    const active = this.activeCounts.get(resource) ?? 0;
    const capacity = this.capacities[resource] ?? 10;

    if (active < capacity) {
      const newActive = active + 1;
      this.activeCounts.set(resource, newActive);
      this.successes.set(resource, (this.successes.get(resource) ?? 0) + 1);
      const currentPeak = this.peakCounts.get(resource) ?? 0;
      if (newActive > currentPeak) {
        this.peakCounts.set(resource, newActive);
      }
      metrics.queueActiveWorkers.set(newActive, { queue: resource });
      const acquiredAt = Date.now();
      return () => this.release(resource, acquiredAt);
    }

    const enqueuedAt = Date.now();
    const queue = this.waitingQueues.get(resource) ?? [];

    return new Promise<() => void>((resolve, reject) => {
      const waiter: WaitingAcquire = {
        enqueuedAt,
        reject: (err) => {
          this.rejected.set(resource, (this.rejected.get(resource) ?? 0) + 1);
          reject(err);
        },
        resolve: () => {
          const waitMs = Date.now() - enqueuedAt;
          metrics.queueWaitMs.observe(waitMs, { queue: resource });
          this.successes.set(resource, (this.successes.get(resource) ?? 0) + 1);
          const acquiredAt = Date.now();
          resolve(() => this.release(resource, acquiredAt));
        },
        signal,
      };

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            const currentQueue = this.waitingQueues.get(resource) ?? [];
            const index = currentQueue.indexOf(waiter);
            if (index !== -1) {
              currentQueue.splice(index, 1);
              this.cancelled.set(
                resource,
                (this.cancelled.get(resource) ?? 0) + 1
              );
              reject(
                new AtlasApiError(
                  `Acquisition for resource [${resource}] aborted while waiting.`,
                  499,
                  "CANCELLED"
                )
              );
            }
          },
          { once: true }
        );
      }

      queue.push(waiter);
      this.waitingQueues.set(resource, queue);
    });
  }

  private release(resource: ResourceType, acquiredAt?: number): void {
    if (acquiredAt) {
      const holdTime = Date.now() - acquiredAt;
      this.holdTimes.set(
        resource,
        (this.holdTimes.get(resource) ?? 0) + holdTime
      );
    }

    const queue = this.waitingQueues.get(resource) ?? [];

    while (queue.length > 0) {
      const next = queue.shift()!;
      if (next.signal?.aborted) {
        this.cancelled.set(resource, (this.cancelled.get(resource) ?? 0) + 1);
        continue;
      }
      next.resolve();
      return;
    }

    const active = this.activeCounts.get(resource) ?? 1;
    const updated = Math.max(0, active - 1);
    this.activeCounts.set(resource, updated);
    metrics.queueActiveWorkers.set(updated, { queue: resource });
  }

  async withPermit<T>(
    resource: ResourceType,
    fn: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const release = await this.acquire(resource, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  reset(): void {
    for (const res of Object.keys(
      DEFAULT_RESOURCE_CAPACITIES
    ) as ResourceType[]) {
      this.activeCounts.set(res, 0);
      this.peakCounts.set(res, 0);
      this.holdTimes.set(res, 0);
      this.attempts.set(res, 0);
      this.successes.set(res, 0);
      this.cancelled.set(res, 0);
      this.rejected.set(res, 0);
      const queue = this.waitingQueues.get(res) ?? [];
      for (const waiter of queue) {
        waiter.reject(
          new AtlasApiError("Resource limiter reset", 503, "SYSTEM_BUSY")
        );
      }
      this.waitingQueues.set(res, []);
    }
  }
}

export const defaultResourceLimiter = new ResourceLimiter();
