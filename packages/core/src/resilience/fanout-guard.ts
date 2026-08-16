export interface FanoutLimits {
  maxResearchQueriesPerSession?: number;
  maxResearchSourcesPerSession?: number;
  maxSubAgentDepth?: number;
  maxSubAgentsPerExecution?: number;
}

export const DEFAULT_FANOUT_LIMITS: FanoutLimits = {
  maxResearchQueriesPerSession: 8,
  maxResearchSourcesPerSession: 20,
  maxSubAgentDepth: 3,
  maxSubAgentsPerExecution: 10,
};

export class FanoutGuard {
  private activeSubAgentsCount = 0;
  private researchQueriesCount = 0;
  private researchSourcesCount = 0;
  private readonly limits: FanoutLimits;

  constructor(limits: FanoutLimits = DEFAULT_FANOUT_LIMITS) {
    this.limits = { ...DEFAULT_FANOUT_LIMITS, ...limits };
  }

  canSpawnSubAgent(depth = 1): { allowed: boolean; reason?: string } {
    if (this.limits.maxSubAgentDepth && depth > this.limits.maxSubAgentDepth) {
      return {
        allowed: false,
        reason: `Sub-agent recursion depth ${depth} exceeds max allowed depth of ${this.limits.maxSubAgentDepth}`,
      };
    }

    if (
      this.limits.maxSubAgentsPerExecution &&
      this.activeSubAgentsCount >= this.limits.maxSubAgentsPerExecution
    ) {
      return {
        allowed: false,
        reason: `Total sub-agents spawned (${this.activeSubAgentsCount}) reached maximum execution limit (${this.limits.maxSubAgentsPerExecution})`,
      };
    }

    return { allowed: true };
  }

  recordSubAgentSpawned(): void {
    this.activeSubAgentsCount += 1;
  }

  canExecuteResearchQuery(): { allowed: boolean; reason?: string } {
    if (
      this.limits.maxResearchQueriesPerSession &&
      this.researchQueriesCount >= this.limits.maxResearchQueriesPerSession
    ) {
      return {
        allowed: false,
        reason: `Research query fanout limit (${this.limits.maxResearchQueriesPerSession}) reached`,
      };
    }
    return { allowed: true };
  }

  recordResearchQuery(): void {
    this.researchQueriesCount += 1;
  }

  canAddResearchSource(): { allowed: boolean; reason?: string } {
    if (
      this.limits.maxResearchSourcesPerSession &&
      this.researchSourcesCount >= this.limits.maxResearchSourcesPerSession
    ) {
      return {
        allowed: false,
        reason: `Research sources limit (${this.limits.maxResearchSourcesPerSession}) reached`,
      };
    }
    return { allowed: true };
  }

  recordResearchSource(): void {
    this.researchSourcesCount += 1;
  }
}
