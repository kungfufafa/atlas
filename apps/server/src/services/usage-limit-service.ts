import { AtlasApiError, isSubscriptionProvider } from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";

export const USER_REQUEST_LIMIT_CODE = "USAGE_LIMIT_USER_REQUESTS";
export const WORKSPACE_BUDGET_LIMIT_CODE = "USAGE_LIMIT_WORKSPACE_BUDGET";

export interface UsageLimitCheckInput {
  orgId: string;
  /**
   * Provider type that will serve the execution. Decides whether the USD
   * budget applies: subscription providers record $0 estimated cost, so a
   * dollar budget only gates cost-bearing (API-key) executions. When the
   * provider is unknown the execution is treated as cost-bearing.
   */
  providerType?: string | null;
  userId?: string | null;
}

/**
 * Server-side usage governance gate, evaluated before an AI execution starts.
 *
 * - The per-user monthly request cap applies to every credential path
 *   (subscription and API) because requests are the one honest common unit.
 * - The enforced USD budget rejects cost-bearing executions once month-to-date
 *   estimated spend reaches the workspace limit.
 *
 * The gate reads the usage rollup and does not reserve capacity: concurrent
 * requests near the boundary can overshoot by at most the per-user concurrency
 * cap before the limit closes on the next request. Accounting itself is
 * additive upserts and never loses increments. A rejection is an explicit 429
 * — there is never a silent fallback to another provider or credential.
 */
export class UsageLimitService {
  constructor(private readonly db: DatabaseAdapter) {}

  async assertWithinLimits(input: UsageLimitCheckInput): Promise<void> {
    const policy = await this.db.getOrgUsageBudget(input.orgId);
    if (!policy) {
      return;
    }

    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;

    const userId = input.userId?.trim();
    if (policy.perUserMonthlyRequests > 0 && userId) {
      const rows = await this.db.aggregateLlmUsage({
        from: monthStart,
        groupBy: "user",
        orgId: input.orgId,
        userId,
      });
      const used = rows[0]?.requestCount ?? 0;
      if (used >= policy.perUserMonthlyRequests) {
        throw new AtlasApiError(
          `Atlas usage limit reached: ${used.toLocaleString()} of ${policy.perUserMonthlyRequests.toLocaleString()} AI requests used this month. Ask a Workspace Admin to raise the limit in System → Status.`,
          429,
          USER_REQUEST_LIMIT_CODE
        );
      }
    }

    const costBearing = input.providerType
      ? !isSubscriptionProvider(input.providerType)
      : true;
    if (policy.enforceBudget && policy.monthlyLimitUsd > 0 && costBearing) {
      const rows = await this.db.aggregateLlmUsage({
        from: monthStart,
        groupBy: "workspace",
        orgId: input.orgId,
      });
      const spentUsd = rows[0]?.estimatedCostUsd ?? 0;
      if (spentUsd >= policy.monthlyLimitUsd) {
        throw new AtlasApiError(
          `Atlas workspace budget reached: $${spentUsd.toFixed(2)} of $${policy.monthlyLimitUsd.toFixed(2)} estimated API spend used this month. Ask a Workspace Admin to raise the budget in System → Status.`,
          429,
          WORKSPACE_BUDGET_LIMIT_CODE
        );
      }
    }
  }
}
