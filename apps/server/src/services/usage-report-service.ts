import type {
  LlmUsageAuthKind,
  LlmUsageReportGroupBy,
  LlmUsageReportResponse,
  LlmUsageReportRow,
  OrgRole,
  OrgUsageBudgetResponse,
} from "@atlas/core";
import {
  getBuiltinProviderDefinition,
  isSubscriptionProvider,
} from "@atlas/core";
import {
  type DatabaseAdapter,
  type LlmUsageAggregateRow,
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

    if (options.groupBy === "auth") {
      const providerRows = await this.db.aggregateLlmUsage({
        from: options.from,
        groupBy: "provider",
        orgId,
        to: options.to,
        userId,
      });
      return { ...emptyReport, rows: foldRowsByAuthKind(providerRows) };
    }

    const rows = await this.db.aggregateLlmUsage({
      from: options.from,
      groupBy: options.groupBy as LlmUsageGroupBy,
      limit,
      orgId,
      to: options.to,
      userId,
    });

    const credentialInfo =
      options.groupBy === "credential" && orgId
        ? await this.loadCredentialInfo(orgId)
        : null;

    const labeled = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        ...this.resolveAuthKind(options.groupBy, row.key, credentialInfo),
        label: await this.resolveLabel(
          options.groupBy,
          row.key,
          credentialInfo
        ),
      }))
    );

    return { ...emptyReport, rows: labeled };
  }

  /**
   * Maps provider instance id → label/type for the caller's workspace so
   * credential rows read as the configured provider instance instead of a raw
   * id. Rows for since-deleted instances keep their raw key: historical usage
   * is never reassigned when configuration changes.
   */
  private async loadCredentialInfo(
    orgId: string
  ): Promise<Map<string, { label: string; type: string }>> {
    const record = await this.db.getOrgAiConfig(orgId).catch(() => null);
    const providers =
      record &&
      typeof record.config === "object" &&
      record.config !== null &&
      Array.isArray((record.config as { providers?: unknown }).providers)
        ? ((record.config as { providers: unknown[] }).providers ?? [])
        : [];

    const info = new Map<string, { label: string; type: string }>();
    for (const entry of providers) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const { id, label, type } = entry as {
        id?: unknown;
        label?: unknown;
        type?: unknown;
      };
      if (typeof id === "string" && typeof type === "string") {
        info.set(id, {
          label: typeof label === "string" && label.trim() ? label : id,
          type,
        });
      }
    }
    return info;
  }

  private resolveAuthKind(
    groupBy: LlmUsageReportGroupBy,
    key: string,
    credentialInfo: Map<string, { label: string; type: string }> | null
  ): Pick<LlmUsageReportRow, "authKind"> {
    if (groupBy === "provider") {
      return { authKind: authKindForProviderType(key) };
    }
    if (groupBy === "credential") {
      const type = credentialInfo?.get(key)?.type;
      return type ? { authKind: authKindForProviderType(type) } : {};
    }
    return {};
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
    key: string,
    credentialInfo: Map<string, { label: string; type: string }> | null
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

    if (groupBy === "provider") {
      return getBuiltinProviderDefinition(key)?.displayName ?? key;
    }

    if (groupBy === "credential") {
      return credentialInfo?.get(key)?.label ?? key;
    }

    if (groupBy === "capability") {
      return CAPABILITY_LABELS[key] ?? key;
    }

    return key;
  }
}

const CAPABILITY_LABELS: Record<string, string> = {
  "audio.transcription": "Audio transcription",
  "chat.completion": "Chat",
  "image.generation": "Image generation",
  "image.understanding": "Image parsing",
};

const AUTH_KIND_LABELS: Record<LlmUsageAuthKind, string> = {
  api: "API keys",
  subscription: "Subscriptions",
};

function authKindForProviderType(providerType: string): LlmUsageAuthKind {
  return isSubscriptionProvider(providerType) ? "subscription" : "api";
}

/**
 * Collapses provider-type rows into the credential path that served them.
 * Subscription usage is Atlas-observed activity with no API billing; API rows
 * carry the estimated spend.
 */
function foldRowsByAuthKind(
  providerRows: LlmUsageAggregateRow[]
): LlmUsageReportRow[] {
  const buckets = new Map<LlmUsageAuthKind, LlmUsageReportRow>();
  for (const row of providerRows) {
    const authKind = authKindForProviderType(row.key);
    const bucket = buckets.get(authKind) ?? {
      authKind,
      estimatedCostUsd: 0,
      inputTokens: 0,
      key: authKind,
      label: AUTH_KIND_LABELS[authKind],
      outputTokens: 0,
      requestCount: 0,
      totalTokens: 0,
    };
    bucket.estimatedCostUsd += row.estimatedCostUsd;
    bucket.inputTokens += row.inputTokens;
    bucket.outputTokens += row.outputTokens;
    bucket.requestCount += row.requestCount;
    bucket.totalTokens += row.totalTokens;
    buckets.set(authKind, bucket);
  }

  return [...buckets.values()].sort(
    (left, right) => right.totalTokens - left.totalTokens
  );
}

export type { LlmUsageReportRow };
