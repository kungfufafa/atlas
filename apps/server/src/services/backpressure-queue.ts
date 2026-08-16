import { AtlasApiError, metrics } from "@atlas/core";

export type WorkloadClass =
  | "interactive_fast"
  | "interactive_standard"
  | "research"
  | "browser"
  | "artifact"
  | "background";

export interface QueueOptions {
  maxConcurrent?: number;
  maxConcurrentPerOrg?: number;
  maxConcurrentPerUser?: number;
  maxQueueDepth?: number;
}

interface QueuedJob<T> {
  cancelled: boolean;
  enqueuedAt: number;
  fn: () => Promise<T>;
  id: string;
  orgId?: string;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
  userId?: string;
  workloadClass: WorkloadClass;
}

export class BackpressureQueue {
  private activeCount = 0;
  private readonly queue: QueuedJob<any>[] = [];
  private readonly maxConcurrent: number;
  private readonly maxQueueDepth: number;
  private readonly maxConcurrentPerOrg: number;
  private readonly maxConcurrentPerUser: number;
  private readonly activeByOrg = new Map<string, number>();
  private readonly activeByUser = new Map<string, number>();

  constructor(
    public readonly name: string = "default",
    options: QueueOptions = {}
  ) {
    this.maxConcurrent = options.maxConcurrent ?? 50;
    this.maxQueueDepth = options.maxQueueDepth ?? 200;
    this.maxConcurrentPerOrg = options.maxConcurrentPerOrg ?? 20;
    this.maxConcurrentPerUser = options.maxConcurrentPerUser ?? 10;
  }

  async enqueue<T>(
    id: string,
    workloadClass: WorkloadClass,
    fn: () => Promise<T>,
    context: { orgId?: string; userId?: string } = {}
  ): Promise<T> {
    const { orgId, userId } = context;

    // Check queue saturation
    if (this.queue.length >= this.maxQueueDepth) {
      metrics.queueRejectedTotal.inc({ queue: this.name });
      throw new AtlasApiError(
        "Atlas is handling unusually high load. Try again shortly.",
        503,
        "SYSTEM_BUSY"
      );
    }

    // Check per-org or per-user concurrency
    if (
      orgId &&
      (this.activeByOrg.get(orgId) ?? 0) >= this.maxConcurrentPerOrg
    ) {
      // Check if queue has too many for this org
      const orgQueueCount = this.queue.filter((j) => j.orgId === orgId).length;
      if (orgQueueCount >= this.maxConcurrentPerOrg) {
        metrics.queueRejectedTotal.inc({ queue: this.name });
        throw new AtlasApiError(
          "Organization concurrency limit reached. Please wait for in-flight tasks to complete.",
          429,
          "ORG_LIMIT_EXCEEDED"
        );
      }
    }

    if (
      userId &&
      (this.activeByUser.get(userId) ?? 0) >= this.maxConcurrentPerUser
    ) {
      const userQueueCount = this.queue.filter(
        (j) => j.userId === userId
      ).length;
      if (userQueueCount >= this.maxConcurrentPerUser) {
        metrics.queueRejectedTotal.inc({ queue: this.name });
        throw new AtlasApiError(
          "User concurrency limit reached. Please wait for in-flight tasks to complete.",
          429,
          "USER_LIMIT_EXCEEDED"
        );
      }
    }

    const enqueuedAt = Date.now();
    metrics.queueDepth.set(this.queue.length + 1, { queue: this.name });

    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob<T> = {
        cancelled: false,
        enqueuedAt,
        fn,
        id,
        orgId,
        reject,
        resolve,
        userId,
        workloadClass,
      };

      this.queue.push(job);
      this.processNext();
    });
  }

  cancel(jobId: string): boolean {
    const index = this.queue.findIndex((j) => j.id === jobId);
    if (index !== -1) {
      const job = this.queue[index]!;
      job.cancelled = true;
      this.queue.splice(index, 1);
      metrics.queueDepth.set(this.queue.length, { queue: this.name });
      job.reject(
        new AtlasApiError("Task cancelled before execution.", 499, "CANCELLED")
      );
      return true;
    }
    return false;
  }

  getActiveByOrg(orgId: string): number {
    return this.activeByOrg.get(orgId) ?? 0;
  }

  getActiveByUser(userId: string): number {
    return this.activeByUser.get(userId) ?? 0;
  }

  getQueuedByOrg(orgId: string): number {
    return this.queue.filter((j) => j.orgId === orgId).length;
  }

  getQueuedByUser(userId: string): number {
    return this.queue.filter((j) => j.userId === userId).length;
  }

  getMaxConcurrentPerOrg(): number {
    return this.maxConcurrentPerOrg;
  }

  getMaxConcurrentPerUser(): number {
    return this.maxConcurrentPerUser;
  }

  getStats(): {
    active: number;
    queued: number;
    maxConcurrent: number;
    maxQueueDepth: number;
  } {
    return {
      active: this.activeCount,
      maxConcurrent: this.maxConcurrent,
      maxQueueDepth: this.maxQueueDepth,
      queued: this.queue.length,
    };
  }

  private processNext(): void {
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    // Find next eligible job considering fairness
    let candidateIndex = -1;
    for (let i = 0; i < this.queue.length; i += 1) {
      const candidate = this.queue[i]!;
      const orgActive = candidate.orgId
        ? (this.activeByOrg.get(candidate.orgId) ?? 0)
        : 0;
      const userActive = candidate.userId
        ? (this.activeByUser.get(candidate.userId) ?? 0)
        : 0;

      if (
        (!candidate.orgId || orgActive < this.maxConcurrentPerOrg) &&
        (!candidate.userId || userActive < this.maxConcurrentPerUser)
      ) {
        candidateIndex = i;
        break;
      }
    }

    if (candidateIndex === -1) {
      return;
    }

    const job = this.queue.splice(candidateIndex, 1)[0];
    if (!job) {
      return;
    }

    metrics.queueDepth.set(this.queue.length, { queue: this.name });

    if (job.cancelled) {
      this.processNext();
      return;
    }

    const waitMs = Date.now() - job.enqueuedAt;
    metrics.queueWaitMs.observe(waitMs, { queue: this.name });

    this.activeCount += 1;
    metrics.queueActiveWorkers.set(this.activeCount, { queue: this.name });

    if (job.orgId) {
      this.activeByOrg.set(
        job.orgId,
        (this.activeByOrg.get(job.orgId) ?? 0) + 1
      );
    }
    if (job.userId) {
      this.activeByUser.set(
        job.userId,
        (this.activeByUser.get(job.userId) ?? 0) + 1
      );
    }

    job
      .fn()
      .then((res) => {
        job.resolve(res);
      })
      .catch((err) => {
        job.reject(err);
      })
      .finally(() => {
        this.activeCount -= 1;
        metrics.queueActiveWorkers.set(this.activeCount, { queue: this.name });

        if (job.orgId) {
          const current = this.activeByOrg.get(job.orgId) ?? 1;
          if (current <= 1) {
            this.activeByOrg.delete(job.orgId);
          } else {
            this.activeByOrg.set(job.orgId, current - 1);
          }
        }
        if (job.userId) {
          const current = this.activeByUser.get(job.userId) ?? 1;
          if (current <= 1) {
            this.activeByUser.delete(job.userId);
          } else {
            this.activeByUser.set(job.userId, current - 1);
          }
        }

        this.processNext();
      });
  }
}

export const defaultExecutionQueue = new BackpressureQueue("execution");
