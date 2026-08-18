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

/**
 * Reads the multi-tenant usage rollup with RBAC-aware scoping:
 * - platform admin → every workspace (no org filter),
 * - workspace admin → their workspace only (may still break down by user),
 * - member/viewer → only their own usage within their workspace.
 */
export class UsageReportService {
  constructor(private readonly db: DatabaseAdapter) {}

  async getReport(
    options: UsageReportOptions,
    access: UsageReportAccess
  ): Promise<LlmUsageReportResponse> {
    const isPlatformAdmin = access.isPlatformAdmin === true;
    const isWorkspaceAdmin = !isPlatformAdmin && access.orgRole === "admin";

    const scope = isPlatformAdmin
      ? "platform"
      : isWorkspaceAdmin
        ? "workspace"
        : "user";

    const orgId = isPlatformAdmin ? undefined : (access.orgId ?? undefined);
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

    return {
      fractionUsed: limit ? monthToDateUsd / limit : null,
      month,
      monthlyLimitUsd: limit,
      monthToDateUsd,
      overBudget: limit ? monthToDateUsd > limit : false,
    };
  }

  async setBudget(
    orgId: string,
    monthlyLimitUsd: number
  ): Promise<OrgUsageBudgetResponse> {
    const normalized =
      Number.isFinite(monthlyLimitUsd) && monthlyLimitUsd > 0
        ? monthlyLimitUsd
        : 0;
    await this.db.upsertOrgUsageBudget({
      monthlyLimitUsd: normalized,
      orgId,
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
