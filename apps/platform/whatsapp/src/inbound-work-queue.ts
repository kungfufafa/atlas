export class InboundQueueSaturatedError extends Error {
  constructor(message = "WhatsApp inbound queue is saturated.") {
    super(message);
    this.name = "InboundQueueSaturatedError";
  }
}

interface BoundedWorkQueueOptions {
  maxConcurrent: number;
  maxQueued: number;
  maxWaitMs: number;
}

interface QueuedWork {
  execute: () => Promise<void>;
  timeout: ReturnType<typeof setTimeout>;
}

/** Bounds concurrent Baileys event handlers and their queued message batches. */
export class BoundedWorkQueue {
  private active = 0;
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

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.options.maxConcurrent) {
      return this.runNow(work);
    }
    if (this.pending.length >= this.options.maxQueued) {
      return Promise.reject(new InboundQueueSaturatedError());
    }

    return new Promise<T>((resolve, reject) => {
      const queued: QueuedWork = {
        execute: async () => {
          try {
            resolve(await this.runNow(work));
          } catch (error) {
            reject(error);
          }
        },
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

  private async runNow<T>(work: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active = Math.max(0, this.active - 1);
      this.startNext();
    }
  }

  private startNext(): void {
    if (
      this.active >= this.options.maxConcurrent ||
      this.pending.length === 0
    ) {
      return;
    }

    const next = this.pending.shift();
    if (!next) {
      return;
    }
    clearTimeout(next.timeout);
    void next.execute();
  }
}
