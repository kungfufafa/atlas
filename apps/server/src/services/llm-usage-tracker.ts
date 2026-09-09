import type {
  LlmUsageModelStats,
  LlmUsageProvenance,
  LlmUsageStats,
} from "@atlas/core";
import type { DatabaseAdapter, LlmUsageStatsDelta } from "@atlas/db";
import {
  estimateUsageCostUsd,
  type PricingContext,
} from "../providers/pricing";

export type LlmInvocationUsage =
  | {
      source: "reported" | "estimated";
      inputTokens: number;
      outputTokens: number;
    }
  | { source: "unknown" };

type InvocationCounts = Pick<
  LlmUsageProvenance,
  "reportedInvocations" | "estimatedInvocations" | "unknownInvocations"
>;

function counts(value?: Partial<InvocationCounts>): InvocationCounts {
  return {
    estimatedInvocations: value?.estimatedInvocations ?? 0,
    reportedInvocations: value?.reportedInvocations ?? 0,
    unknownInvocations: value?.unknownInvocations ?? 0,
  };
}

function provenance(
  requestCount: number,
  value: InvocationCounts
): LlmUsageProvenance {
  const unclassifiedInvocations = Math.max(
    0,
    requestCount -
      value.reportedInvocations -
      value.estimatedInvocations -
      value.unknownInvocations
  );
  return {
    ...value,
    allInvocationsReported:
      requestCount === value.reportedInvocations &&
      value.estimatedInvocations === 0 &&
      value.unknownInvocations === 0,
    unclassifiedInvocations,
  };
}

export class LlmUsageTracker {
  private invocationCounts = counts();
  private readonly pendingWrites = new Set<Promise<void>>();
  private requestCount = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private estimatedCostUsd = 0;
  private trackedSince = new Date().toISOString();
  private readonly usageByModel = new Map<
    string,
    Omit<LlmUsageModelStats, "totalTokens" | "provenance"> & InvocationCounts
  >();
  private constructor(private readonly db?: DatabaseAdapter) {}

  static async create(db?: DatabaseAdapter): Promise<LlmUsageTracker> {
    const tracker = new LlmUsageTracker(db);
    await tracker.load();
    return tracker;
  }

  private async load(): Promise<void> {
    if (!this.db) {
      return;
    }

    const stored = await this.db.getLlmUsageStats();
    if (stored) {
      this.requestCount = stored.requestCount;
      this.invocationCounts = counts(stored);
      this.inputTokens = stored.inputTokens;
      this.outputTokens = stored.outputTokens;
      this.estimatedCostUsd = stored.estimatedCostUsd;
      this.trackedSince = stored.trackedSince;
    }

    const byModel = await this.db.listLlmUsageStatsByModel();
    for (const entry of byModel) {
      this.usageByModel.set(entry.modelId, {
        ...counts(entry),
        estimatedCostUsd: entry.estimatedCostUsd,
        inputTokens: entry.inputTokens,
        modelId: entry.modelId,
        outputTokens: entry.outputTokens,
        requestCount: entry.requestCount,
        trackedSince: entry.trackedSince,
      });
    }
  }

  async reloadFromDatabase(): Promise<void> {
    this.requestCount = 0;
    this.invocationCounts = counts();
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.estimatedCostUsd = 0;
    this.trackedSince = new Date().toISOString();
    this.usageByModel.clear();
    await this.load();
  }

  /** Wait for already scheduled persistence; recording itself never delays a provider result. */
  async flush(): Promise<void> {
    await Promise.all(this.pendingWrites);
  }

  recordInvocation(
    modelId: string,
    usage: LlmInvocationUsage,
    pricingContext: PricingContext = {}
  ): void {
    if (usage.source === "unknown") {
      this.recordValues(modelId, 0, 0, pricingContext, "unknown");
      return;
    }
    if (
      ![usage.inputTokens, usage.outputTokens].every(
        (value) => Number.isSafeInteger(value) && value >= 0
      )
    ) {
      this.recordValues(modelId, 0, 0, pricingContext, "unknown");
      return;
    }
    this.recordValues(
      modelId,
      usage.inputTokens,
      usage.outputTokens,
      pricingContext,
      usage.source
    );
  }

  /** Existing callers provide no provenance evidence; retain them as unclassified. */
  record(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    pricingContext: PricingContext = {}
  ): void {
    this.recordValues(modelId, inputTokens, outputTokens, pricingContext);
  }

  private recordValues(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    pricingContext: PricingContext,
    source?: LlmInvocationUsage["source"]
  ): void {
    const deltaCounts = {
      estimatedInvocations: source === "estimated" ? 1 : 0,
      reportedInvocations: source === "reported" ? 1 : 0,
      unknownInvocations: source === "unknown" ? 1 : 0,
    };
    this.invocationCounts.reportedInvocations +=
      deltaCounts.reportedInvocations;
    this.invocationCounts.estimatedInvocations +=
      deltaCounts.estimatedInvocations;
    this.invocationCounts.unknownInvocations += deltaCounts.unknownInvocations;
    const costDelta = estimateUsageCostUsd(
      modelId,
      inputTokens,
      outputTokens,
      pricingContext
    );

    this.requestCount += 1;
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    this.estimatedCostUsd += costDelta;

    const existing = this.usageByModel.get(modelId);
    this.usageByModel.set(modelId, {
      estimatedCostUsd: (existing?.estimatedCostUsd ?? 0) + costDelta,
      estimatedInvocations:
        (existing?.estimatedInvocations ?? 0) +
        deltaCounts.estimatedInvocations,
      inputTokens: (existing?.inputTokens ?? 0) + inputTokens,
      modelId,
      outputTokens: (existing?.outputTokens ?? 0) + outputTokens,
      reportedInvocations:
        (existing?.reportedInvocations ?? 0) + deltaCounts.reportedInvocations,
      requestCount: (existing?.requestCount ?? 0) + 1,
      trackedSince: existing?.trackedSince ?? new Date().toISOString(),
      unknownInvocations:
        (existing?.unknownInvocations ?? 0) + deltaCounts.unknownInvocations,
    });

    const pending = this.persist(
      {
        ...deltaCounts,
        estimatedCostUsd: costDelta,
        inputTokens,
        outputTokens,
        requestCount: 1,
      },
      modelId
    );
    this.pendingWrites.add(pending);
    void pending.finally(() => this.pendingWrites.delete(pending));
  }

  private async persist(
    delta: LlmUsageStatsDelta,
    modelId: string
  ): Promise<void> {
    if (!this.db) {
      return;
    }

    try {
      await this.db.incrementLlmUsageStats(delta, this.trackedSince);
      await this.db.incrementLlmUsageStatsByModel(
        modelId,
        delta,
        this.usageByModel.get(modelId)?.trackedSince ?? this.trackedSince
      );
    } catch (error) {
      console.warn("Failed to persist LLM usage stats:", error);
    }
  }

  getStats(): LlmUsageStats {
    return {
      estimatedCostUsd: this.estimatedCostUsd,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      provenance: provenance(this.requestCount, this.invocationCounts),
      requestCount: this.requestCount,
      totalTokens: this.inputTokens + this.outputTokens,
      trackedSince: this.trackedSince,
    };
  }

  getStatsByModel(): LlmUsageModelStats[] {
    return [...this.usageByModel.values()]
      .map(
        ({
          reportedInvocations,
          estimatedInvocations,
          unknownInvocations,
          ...entry
        }) => ({
          ...entry,
          provenance: provenance(entry.requestCount, {
            estimatedInvocations,
            reportedInvocations,
            unknownInvocations,
          }),
          totalTokens: entry.inputTokens + entry.outputTokens,
        })
      )
      .sort((left, right) => {
        if (right.requestCount !== left.requestCount) {
          return right.requestCount - left.requestCount;
        }

        if (right.totalTokens !== left.totalTokens) {
          return right.totalTokens - left.totalTokens;
        }

        return left.modelId.localeCompare(right.modelId);
      });
  }
}
