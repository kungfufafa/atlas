export class InboundQueueSaturatedError extends Error {
  constructor(message = "WhatsApp inbound queue is saturated.") {
    super(message);
    this.name = "InboundQueueSaturatedError";
  }
}

export interface BoundedWorkQueueOptions {
  maxConcurrent: number;
  maxQueued: number;
  maxWaitMs: number;
}

interface QueuedWork {
  execute: () => Promise<void>;
  key?: string;
  timeout: ReturnType<typeof setTimeout>;
}

/** Bounds concurrent Baileys event handlers and their queued message batches. */
export class BoundedWorkQueue {
  private active = 0;
  private readonly activeKeys = new Set<string>();
  private readonly pending: QueuedWork[] = [];

  constructor(private readonly options: BoundedWorkQueueOptions) {
    if (
      !(
        Number.isInteger(options.maxConcurrent) &&
        options.maxConcurrent > 0 &&
        Number.isInteger(options.maxQueued) &&
        options.maxQueued >= 0 &&
        Number.isFinite(options.maxWaitMs) &&
        options.maxWaitMs > 0
      )
    ) {
      throw new Error("Invalid bounded work queue options.");
    }
  }

  run<T>(work: () => Promise<T>, key?: string): Promise<T> {
    if (this.canStart(key)) {
      return this.runNow(work, key);
    }
    if (this.pending.length >= this.options.maxQueued) {
      return Promise.reject(new InboundQueueSaturatedError());
    }

    return new Promise<T>((resolve, reject) => {
      const queued: QueuedWork = {
        execute: async () => {
          try {
            resolve(await this.runNow(work, key));
          } catch (error) {
            reject(error);
          }
        },
        key,
        timeout: setTimeout(() => {
          const index = this.pending.indexOf(queued);
          if (index === -1) {
            return;
          }
          this.pending.splice(index, 1);
          reject(
            new InboundQueueSaturatedError(
              "WhatsApp inbound queue wait limit exceeded."
            )
          );
        }, this.options.maxWaitMs),
      };
      this.pending.push(queued);
    });
  }

  snapshot(): { active: number; queued: number } {
    return { active: this.active, queued: this.pending.length };
  }

  private canStart(key?: string): boolean {
    return (
      this.active < this.options.maxConcurrent &&
      (key === undefined || !this.activeKeys.has(key))
    );
  }

  private async runNow<T>(work: () => Promise<T>, key?: string): Promise<T> {
    this.active += 1;
    if (key !== undefined) {
      this.activeKeys.add(key);
    }
    try {
      return await work();
    } finally {
      this.active = Math.max(0, this.active - 1);
      if (key !== undefined) {
        this.activeKeys.delete(key);
      }
      this.startNext();
    }
  }

  private startNext(): void {
    while (this.active < this.options.maxConcurrent) {
      // Skip a busy chat without letting its waiters occupy global slots.
      // The first eligible item preserves arrival order within each chat.
      const index = this.pending.findIndex((work) => this.canStart(work.key));
      if (index === -1) {
        return;
      }
      const [next] = this.pending.splice(index, 1);
      if (!next) {
        return;
      }
      clearTimeout(next.timeout);
      void next.execute();
    }
  }
}
