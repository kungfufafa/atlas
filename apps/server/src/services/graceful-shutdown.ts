export type ShutdownState = "SERVING" | "DRAINING" | "STOPPING" | "STOPPED";

export interface ShutdownHook {
  fn: () => Promise<void> | void;
  name: string;
}

export class GracefulShutdownManager {
  private state: ShutdownState = "SERVING";
  private inFlightTasks = 0;
  private readonly hooks: ShutdownHook[] = [];

  constructor(private readonly drainTimeoutMs = 15_000) {}

  getState(): ShutdownState {
    return this.state;
  }

  addHook(name: string, fn: () => Promise<void> | void): void {
    this.hooks.push({ fn, name });
  }

  isDraining(): boolean {
    return this.state !== "SERVING";
  }

  trackTask<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isDraining()) {
      throw new Error("Server is shutting down. No new requests accepted.");
    }
    this.inFlightTasks += 1;
    return fn().finally(() => {
      this.inFlightTasks -= 1;
    });
  }

  async shutdown(): Promise<void> {
    if (this.state !== "SERVING") {
      return;
    }
    this.state = "DRAINING";

    const start = Date.now();
    // Wait for in-flight tasks to drain
    while (this.inFlightTasks > 0 && Date.now() - start < this.drainTimeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }

    this.state = "STOPPING";

    // Run registered shutdown hooks (DB close, worker stop, browser context release)
    for (const hook of this.hooks) {
      try {
        await hook.fn();
      } catch (error) {
        console.error(`Shutdown hook [${hook.name}] failed:`, error);
      }
    }

    this.state = "STOPPED";
  }

  reset(): void {
    this.state = "SERVING";
    this.inFlightTasks = 0;
  }

  setupSignalHandlers(): void {
    const handleSignal = (sig: string) => {
      console.log(`Received ${sig}. Starting graceful shutdown...`);
      this.shutdown()
        .then(() => {
          process.exit(0);
        })
        .catch((err) => {
          console.error("Graceful shutdown failed:", err);
          process.exit(1);
        });
    };

    process.once("SIGTERM", () => handleSignal("SIGTERM"));
    process.once("SIGINT", () => handleSignal("SIGINT"));
  }
}

export const gracefulShutdownManager = new GracefulShutdownManager();
