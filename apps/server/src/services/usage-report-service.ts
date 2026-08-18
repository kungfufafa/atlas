import type {
  LlmUsageReportGroupBy,
  LlmUsageReportResponse,
  LlmUsageReportRow,
  OrgRole,
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
