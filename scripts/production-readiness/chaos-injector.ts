export interface ChaosOptions {
  injectLatencyMs?: number;
  rateLimit429Probability?: number;
  serverError5xxProbability?: number;
  timeoutProbability?: number;
  toolFailureProbability?: number;
}

export class ChaosInjector {
  private options: ChaosOptions = {};
  public enabled = false;

  configure(options: ChaosOptions): void {
    this.options = { ...options };
    this.enabled = true;
  }

  disable(): void {
    this.options = {};
    this.enabled = false;
  }

  async maybeApplyProviderChaos(): Promise<{
    error?: { message: string; status: number };
  } | null> {
    if (!this.enabled) {
      return null;
    }

    if (this.options.injectLatencyMs && this.options.injectLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.options.injectLatencyMs));
    }

    if (
      this.options.rateLimit429Probability &&
      Math.random() < this.options.rateLimit429Probability
    ) {
      return {
        error: {
          message:
            "Rate limit exceeded (429): Token quota exhausted. Retry after 2s.",
          status: 429,
        },
      };
    }

    if (
      this.options.serverError5xxProbability &&
      Math.random() < this.options.serverError5xxProbability
    ) {
      return {
        error: {
          message:
            "Provider internal error (502 Bad Gateway). Service temporarily unavailable.",
          status: 502,
        },
      };
    }

    if (
      this.options.timeoutProbability &&
      Math.random() < this.options.timeoutProbability
    ) {
      await new Promise((r) => setTimeout(r, 8000));
      return {
        error: {
          message: "Provider upstream gateway timed out (504).",
          status: 504,
        },
      };
    }

    return null;
  }

  maybeApplyToolChaos(toolName: string): void {
    if (!this.enabled) {
      return;
    }

    if (
      this.options.toolFailureProbability &&
      Math.random() < this.options.toolFailureProbability
    ) {
      throw new Error(`Chaos injected failure on tool [${toolName}]`);
    }
  }
}

export const chaosInjector = new ChaosInjector();
