export interface CircuitBreakerOptions {
  failureThreshold?: number; // consecutive failures before opening (default 5)
  halfOpenSuccessThreshold?: number; // successes in HALF_OPEN before CLOSING (default 2)
  resetTimeoutMs?: number; // time in OPEN before HALF_OPEN (default 10s)
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount = 0;
  private successCount = 0;
  private nextAttemptAt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccessThreshold: number;

  constructor(
    public readonly name: string,
    options: CircuitBreakerOptions = {}
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 10_000;
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 2;
  }

  getState(): CircuitState {
    if (this.state === "OPEN" && Date.now() >= this.nextAttemptAt) {
      this.state = "HALF_OPEN";
      this.successCount = 0;
    }
    return this.state;
  }

  canExecute(): boolean {
    const currentState = this.getState();
    return currentState !== "OPEN";
  }

  recordSuccess(): void {
    const currentState = this.getState();
    if (currentState === "HALF_OPEN") {
      this.successCount += 1;
      if (this.successCount >= this.halfOpenSuccessThreshold) {
        this.state = "CLOSED";
        this.failureCount = 0;
        this.successCount = 0;
      }
    } else if (currentState === "CLOSED") {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    const currentState = this.getState();
    if (currentState === "HALF_OPEN") {
      this.state = "OPEN";
      this.nextAttemptAt = Date.now() + this.resetTimeoutMs;
    } else if (currentState === "CLOSED") {
      this.failureCount += 1;
      if (this.failureCount >= this.failureThreshold) {
        this.state = "OPEN";
        this.nextAttemptAt = Date.now() + this.resetTimeoutMs;
      }
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      throw new Error(
        `Circuit breaker [${this.name}] is OPEN. Requests temporarily halted until ${new Date(this.nextAttemptAt).toISOString()}`
      );
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  reset(): void {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttemptAt = 0;
  }
}
