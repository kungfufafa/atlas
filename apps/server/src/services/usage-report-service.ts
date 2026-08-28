import type {
  LlmUsageReportGroupBy,
  LlmUsageReportResponse,
  LlmUsageReportRow,
  OrgRole,
  OrgUsageBudgetResponse,
} from "@atlas/core";
import {
  type DatabaseAdapter,
  type LlmUsageGroupBy,
  UNKNOWN_USAGE_DIMENSION,
} from "@atlas/db";

export interface UsageReportAccess {
  isPlatformAdmin?: boolean;
  /** Caller's active workspace; required for non-platform scopes. */
  orgId?: string | null;
  orgRole?: OrgRole | null;
  /** Caller's user id; used to scope members to their own usage. */
  userId?: string | null;
}

export interface UsageReportOptions {
  from?: string;
  groupBy: LlmUsageReportGroupBy;
  limit?: number;
  to?: string;
}

const MAX_ROWS = 100;
const DEFAULT_ROWS = 50;

function normalizeNonNegative(
  value: number | undefined,
  fallback: number
): number {
  if (value === undefined) {
    return fallback;
  }
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Reads the multi-tenant usage rollup with RBAC-aware scoping:
 * - platform admin without an active workspace → every workspace
 * - platform admin or workspace admin in a workspace → that workspace only
 * - member/viewer → only their own usage within their workspace.
 */
export class UsageReportService {
  constructor(private readonly db: DatabaseAdapter) {}

  async getReport(
    options: UsageReportOptions,
    access: UsageReportAccess
  ): Promise<LlmUsageReportResponse> {
    const orgId = access.orgId?.trim() || undefined;
    const isPlatformWide = access.isPlatformAdmin === true && !orgId;
    const isWorkspaceAdmin =
      !isPlatformWide &&
      (access.isPlatformAdmin === true || access.orgRole === "admin");

    const scope = isPlatformWide
      ? "platform"
      : isWorkspaceAdmin
        ? "workspace"
        : "user";

    const userId = scope === "user" ? (access.userId ?? undefined) : undefined;

    const emptyReport: LlmUsageReportResponse = {
      from: options.from ?? null,
      groupBy: options.groupBy,
      rows: [],
      scope,
      to: options.to ?? null,
    };

    // Non-platform callers must be scoped to a workspace; without one there is
    // nothing they are allowed to see.
    if (scope !== "platform" && !orgId) {
      return emptyReport;
    }
    if (scope === "user" && !userId) {
      return emptyReport;
    }

    const limit = Math.min(
      MAX_ROWS,
      Math.max(1, Math.floor(options.limit ?? DEFAULT_ROWS))
    );

    const rows = await this.db.aggregateLlmUsage({
      from: options.from,
      groupBy: options.groupBy as LlmUsageGroupBy,
      limit,
      orgId,
      to: options.to,
      userId,
    });

    const labeled = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        label: await this.resolveLabel(options.groupBy, row.key),
      }))
    );

    return { ...emptyReport, rows: labeled };
  }

  private currentMonth(): { month: string; from: string } {
    const month = new Date().toISOString().slice(0, 7);
    return { from: `${month}-01`, month };
  }

  private async monthToDateSpend(orgId: string): Promise<number> {
    const { from } = this.currentMonth();
    const rows = await this.db.aggregateLlmUsage({
      from,
      groupBy: "workspace",
      orgId,
    });
    return rows[0]?.estimatedCostUsd ?? 0;
  }

  async getBudgetStatus(orgId: string): Promise<OrgUsageBudgetResponse> {
    const { month } = this.currentMonth();
    const [budget, monthToDateUsd] = await Promise.all([
      this.db.getOrgUsageBudget(orgId),
      this.monthToDateSpend(orgId),
    ]);
    const limit =
      budget && budget.monthlyLimitUsd > 0 ? budget.monthlyLimitUsd : null;
    const perUserMonthlyRequests =
      budget && budget.perUserMonthlyRequests > 0
        ? budget.perUserMonthlyRequests
        : null;

    return {
      enforced: budget?.enforceBudget === true,
      fractionUsed: limit ? monthToDateUsd / limit : null,
      month,
      monthlyLimitUsd: limit,
      monthToDateUsd,
      overBudget: limit ? monthToDateUsd > limit : false,
      perUserMonthlyRequests,
    };
  }

  async setBudget(
    orgId: string,
    policy: {
      enforced?: boolean;
      monthlyLimitUsd?: number;
      perUserMonthlyRequests?: number;
    }
  ): Promise<OrgUsageBudgetResponse> {
    const existing = await this.db.getOrgUsageBudget(orgId);
    const monthlyLimitUsd = normalizeNonNegative(
      policy.monthlyLimitUsd,
      existing?.monthlyLimitUsd ?? 0
    );
    const perUserMonthlyRequests = Math.floor(
      normalizeNonNegative(
        policy.perUserMonthlyRequests,
        existing?.perUserMonthlyRequests ?? 0
      )
    );
    await this.db.upsertOrgUsageBudget({
      enforceBudget: policy.enforced ?? existing?.enforceBudget ?? false,
      monthlyLimitUsd,
      orgId,
      perUserMonthlyRequests,
      updatedAt: new Date().toISOString(),
    });
    return this.getBudgetStatus(orgId);
  }

  private async resolveLabel(
    groupBy: LlmUsageReportGroupBy,
    key: string
  ): Promise<string> {
    if (key === UNKNOWN_USAGE_DIMENSION) {
      return "Unknown";
    }

    if (groupBy === "workspace") {
      const org = await this.db.getOrganizationById(key);
      return org?.name ?? key;
    }

    if (groupBy === "user") {
      const user = await this.db.getUserById(key);
      return user?.name?.trim() || user?.email || key;
    }

    return key;
  }
}

export type { LlmUsageReportRow };
