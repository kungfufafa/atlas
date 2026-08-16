export type CostConfidence = "reported" | "estimated" | "unknown";

export interface ModelUsage {
  cachedInputTokens?: number;
  confidence?: CostConfidence;
  estimatedCostUsd?: number | null;
  inputTokens?: number;
  model: string;
  outputTokens?: number;
  pricingSource?: string;
  provider: string;
  reasoningTokens?: number;
}

export interface ExecutionCostSummary {
  artifactGenerationUsd: number;
  browserRuntimeUsd: number;
  confidence: CostConfidence;
  conversationId?: string;
  executionAttemptId: string;
  modelInferenceUsd: number;
  officeConversionUsd: number;
  orgId?: string;
  pricingSource: string;
  rawUnits: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    searchesCount: number;
    browserSeconds: number;
    artifactsCreated: number;
    officeConversions: number;
  };
  totalCostUsd: number;
  userId?: string;
  webSearchUsd: number;
}

export interface ExecutionBudgetGuardrails {
  maxArtifactGenerations?: number;
  maxBrowserRuntimeSeconds?: number;
  maxEstimatedCostUsd?: number;
  maxModelTurns?: number;
  maxResearchBranches?: number;
  maxTokens?: number;
}

export const DEFAULT_EXECUTION_BUDGET: ExecutionBudgetGuardrails = {
  maxArtifactGenerations: 10,
  maxBrowserRuntimeSeconds: 300,
  maxEstimatedCostUsd: 5.0,
  maxModelTurns: 50,
  maxResearchBranches: 10,
  maxTokens: 500_000,
};

// Model rate catalog (USD per 1M tokens)
const MODEL_RATES_PER_MILLION: Record<
  string,
  { input: number; output: number; cachedInput?: number }
> = {
  "claude-3-5-sonnet": { cachedInput: 0.3, input: 3.0, output: 15.0 },
  "claude-3-haiku": { cachedInput: 0.025, input: 0.25, output: 1.25 },
  "claude-3-opus": { cachedInput: 1.5, input: 15.0, output: 75.0 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-pro": { input: 1.25, output: 5.0 },
  "gpt-4o": { cachedInput: 1.25, input: 2.5, output: 10.0 },
  "gpt-4o-mini": { cachedInput: 0.075, input: 0.15, output: 0.6 },
  "qwen/qwen3.8-max-free": { input: 0.0, output: 0.0 },
};

export function estimateModelTurnCostUsd(
  model: string,
  inputTokens = 0,
  outputTokens = 0,
  cachedInputTokens = 0
): number {
  const norm = model.toLowerCase();
  const matchedKey = Object.keys(MODEL_RATES_PER_MILLION).find((k) =>
    norm.includes(k)
  );

  const rates = matchedKey
    ? MODEL_RATES_PER_MILLION[matchedKey]!
    : { cachedInput: 0.5, input: 1.0, output: 3.0 }; // conservative default fallback

  const regularInputs = Math.max(0, inputTokens - cachedInputTokens);
  const cost =
    (regularInputs / 1_000_000) * rates.input +
    (cachedInputTokens / 1_000_000) * (rates.cachedInput ?? rates.input) +
    (outputTokens / 1_000_000) * rates.output;

  return Number(cost.toFixed(6));
}

export class ExecutionCostTracker {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCachedInputTokens = 0;
  private modelInferenceCostUsd = 0;
  private searchesCount = 0;
  private browserRuntimeSeconds = 0;
  private artifactsCreated = 0;
  private officeConversions = 0;

  constructor(
    public readonly executionAttemptId: string,
    public readonly conversationId?: string,
    public readonly orgId?: string,
    public readonly userId?: string,
    public readonly budget: ExecutionBudgetGuardrails = DEFAULT_EXECUTION_BUDGET
  ) {}

  recordModelTurn(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens = 0
  ): { exceededBudget: boolean; reason?: string } {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCachedInputTokens += cachedInputTokens;

    const turnCost = estimateModelTurnCostUsd(
      model,
      inputTokens,
      outputTokens,
      cachedInputTokens
    );
    this.modelInferenceCostUsd += turnCost;

    return this.checkBudget();
  }

  recordSearch(): { exceededBudget: boolean; reason?: string } {
    this.searchesCount += 1;
    return this.checkBudget();
  }

  recordBrowserRuntime(seconds: number): {
    exceededBudget: boolean;
    reason?: string;
  } {
    this.browserRuntimeSeconds += seconds;
    return this.checkBudget();
  }

  recordArtifactCreated(): { exceededBudget: boolean; reason?: string } {
    this.artifactsCreated += 1;
    return this.checkBudget();
  }

  recordOfficeConversion(): { exceededBudget: boolean; reason?: string } {
    this.officeConversions += 1;
    return this.checkBudget();
  }

  checkBudget(): { exceededBudget: boolean; reason?: string } {
    const totalTokens = this.totalInputTokens + this.totalOutputTokens;
    if (this.budget.maxTokens && totalTokens > this.budget.maxTokens) {
      return {
        exceededBudget: true,
        reason: `Exceeded maximum token budget (${totalTokens} > ${this.budget.maxTokens})`,
      };
    }

    const summary = this.getSummary();
    if (
      this.budget.maxEstimatedCostUsd &&
      summary.totalCostUsd > this.budget.maxEstimatedCostUsd
    ) {
      return {
        exceededBudget: true,
        reason: `Exceeded maximum estimated cost budget ($${summary.totalCostUsd.toFixed(4)} > $${this.budget.maxEstimatedCostUsd.toFixed(4)})`,
      };
    }

    if (
      this.budget.maxBrowserRuntimeSeconds &&
      this.browserRuntimeSeconds > this.budget.maxBrowserRuntimeSeconds
    ) {
      return {
        exceededBudget: true,
        reason: `Exceeded maximum browser runtime (${this.browserRuntimeSeconds}s > ${this.budget.maxBrowserRuntimeSeconds}s)`,
      };
    }

    if (
      this.budget.maxArtifactGenerations &&
      this.artifactsCreated > this.budget.maxArtifactGenerations
    ) {
      return {
        exceededBudget: true,
        reason: `Exceeded maximum artifact generations (${this.artifactsCreated} > ${this.budget.maxArtifactGenerations})`,
      };
    }

    return { exceededBudget: false };
  }

  getSummary(): ExecutionCostSummary {
    const browserCost = this.browserRuntimeSeconds * 0.0002; // ~$0.012 per minute
    const artifactCost = this.artifactsCreated * 0.001;
    const officeCost = this.officeConversions * 0.0005;
    const searchCost = 0.0; // Included in platform

    const totalCostUsd =
      this.modelInferenceCostUsd +
      browserCost +
      artifactCost +
      officeCost +
      searchCost;

    return {
      artifactGenerationUsd: Number(artifactCost.toFixed(6)),
      browserRuntimeUsd: Number(browserCost.toFixed(6)),
      confidence: "estimated",
      conversationId: this.conversationId,
      executionAttemptId: this.executionAttemptId,
      modelInferenceUsd: Number(this.modelInferenceCostUsd.toFixed(6)),
      officeConversionUsd: Number(officeCost.toFixed(6)),
      orgId: this.orgId,
      pricingSource: "atlas-catalog",
      rawUnits: {
        artifactsCreated: this.artifactsCreated,
        browserSeconds: this.browserRuntimeSeconds,
        cachedInputTokens: this.totalCachedInputTokens,
        inputTokens: this.totalInputTokens,
        officeConversions: this.officeConversions,
        outputTokens: this.totalOutputTokens,
        searchesCount: this.searchesCount,
      },
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      userId: this.userId,
      webSearchUsd: Number(searchCost.toFixed(6)),
    };
  }
}
