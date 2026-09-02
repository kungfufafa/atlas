import {
  AtlasApiError,
  type LlmUsageChannelFilter,
  type LlmUsageReportGroupBy,
} from "@atlas/core";
import {
  type UsageReportAccess,
  UsageReportService,
} from "../../services/usage-report-service";
import type { ServerOptions } from "../context";
import {
  requireActiveOrgIdFromContext,
  requireOrgAdminFromContext,
  requirePlatformAdminFromContext,
} from "../org-guards";
import { getRequestAuth, json, readJson, readOptionalJson } from "../shared";
import type { HonoApp } from "../types";

const GROUP_BY_VALUES: LlmUsageReportGroupBy[] = [
  "workspace",
  "user",
  "profile",
  "channel",
  "provider",
  "model",
  "credential",
  "capability",
  "auth",
];

const CHANNEL_VALUES: LlmUsageChannelFilter[] = [
  "web",
  "cli",
  "telegram",
  "whatsapp",
  "discord",
  "automation",
  "task",
  "subagent",
  "unknown",
];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CSV_FORMULA_PREFIX_PATTERN = /^[\u0000-\u0020]*[+\-=@]/;

export interface UsageReportQuery {
  channel?: LlmUsageChannelFilter;
  from?: string;
  groupBy: LlmUsageReportGroupBy;
  limit?: number;
  to?: string;
}

export function parseUsageReportQuery(input: {
  channel?: string;
  from?: string;
  groupBy?: string;
  limit?: string;
  to?: string;
}): UsageReportQuery {
  const groupBy = input.groupBy ?? "workspace";
  if (!GROUP_BY_VALUES.includes(groupBy as LlmUsageReportGroupBy)) {
    throw new AtlasApiError("Invalid usage groupBy filter.", 400);
  }

  if (
    input.channel !== undefined &&
    !CHANNEL_VALUES.includes(input.channel as LlmUsageChannelFilter)
  ) {
    throw new AtlasApiError("Invalid usage channel filter.", 400);
  }

  const from = parseUsageDate(input.from, "from");
  const to = parseUsageDate(input.to, "to");
  if (from && to && from > to) {
    throw new AtlasApiError(
      "Usage from date must be on or before the to date.",
      400
    );
  }

  let limit: number | undefined;
  if (input.limit !== undefined) {
    limit = Number(input.limit);
    if (!(Number.isSafeInteger(limit) && limit > 0)) {
      throw new AtlasApiError("Invalid usage limit.", 400);
    }
  }

  return {
    channel: input.channel as LlmUsageChannelFilter | undefined,
    from,
    groupBy: groupBy as LlmUsageReportGroupBy,
    limit,
    to,
  };
}

function parseUsageDate(
  value: string | undefined,
  field: "from" | "to"
): string | undefined {
  if (value === undefined) {
    return;
  }
  const timestamp = DATE_PATTERN.test(value)
    ? Date.parse(`${value}T00:00:00.000Z`)
    : Number.NaN;
  const isValid =
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value;
  if (!isValid) {
    throw new AtlasApiError(`Invalid usage ${field} date.`, 400);
  }
  return value;
}

export function csvField(value: string | number): string {
  const source = String(value);
  const text =
    typeof value === "string" && CSV_FORMULA_PREFIX_PATTERN.test(source)
      ? `'${source}`
      : source;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function accessFromContext(
  auth: ReturnType<typeof getRequestAuth>
): UsageReportAccess {
  return {
    isPlatformAdmin: auth.isPlatformAdmin,
    orgId: auth.activeOrgId,
    orgRole: auth.orgRole,
    userId: auth.user.id,
  };
}

/**
 * Multi-tenant LLM usage breakdown. RBAC scoping lives in UsageReportService:
 * platform admin without an active workspace → every workspace; otherwise the
 * active workspace (admins) or the caller's own usage (members).
 */
export function registerUsageRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  app.get("/v1/usage", (c) => {
    const db = options.databaseAdapter;
    if (!db) {
      throw new Error("Database adapter is not configured.");
    }

    const auth = getRequestAuth(c);
    const service = new UsageReportService(db);

    const query = parseUsageReportQuery({
      channel: c.req.query("channel"),
      from: c.req.query("from"),
      groupBy: c.req.query("groupBy"),
      limit: c.req.query("limit"),
      to: c.req.query("to"),
    });

    return service
      .getReport(query, accessFromContext(auth))
      .then((report) => json(report));
  });

  app.get("/v1/usage/export.csv", async (c) => {
    const db = options.databaseAdapter;
    if (!db) {
      throw new Error("Database adapter is not configured.");
    }
    const auth = getRequestAuth(c);
    const query = parseUsageReportQuery({
      channel: c.req.query("channel"),
      from: c.req.query("from"),
      groupBy: c.req.query("groupBy"),
      to: c.req.query("to"),
    });
    const { groupBy } = query;
    const report = await new UsageReportService(db).getReport(
      {
        ...query,
        limit: null,
      },
      accessFromContext(auth)
    );

    const header =
      "key,label,requests,input_tokens,output_tokens,total_tokens,estimated_cost_usd";
    const lines = report.rows.map((row) =>
      [
        csvField(row.key),
        csvField(row.label),
        row.requestCount,
        row.inputTokens,
        row.outputTokens,
        row.totalTokens,
        row.estimatedCostUsd,
      ].join(",")
    );

    return new Response([header, ...lines].join("\n"), {
      headers: {
        "Content-Disposition": `attachment; filename="usage-${groupBy}.csv"`,
        "Content-Type": "text/csv; charset=utf-8",
      },
    });
  });

  app.get("/v1/usage/budget", async (c) => {
    const db = options.databaseAdapter;
    if (!db) {
      throw new Error("Database adapter is not configured.");
    }
    const orgId = requireActiveOrgIdFromContext(c);
    const status = await new UsageReportService(db).getBudgetStatus(orgId);
    return json(status);
  });

  app.put("/v1/usage/budget", async (c) => {
    const db = options.databaseAdapter;
    if (!db) {
      throw new Error("Database adapter is not configured.");
    }
    requireOrgAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<{ monthlyLimitUsd?: number }>(c.req.raw);
    const status = await new UsageReportService(db).setBudget(
      orgId,
      Number(body.monthlyLimitUsd ?? 0)
    );
    return json(status);
  });

  // Retention: platform admins can prune old rollup rows (default: >365 days).
  app.post("/v1/usage/prune", async (c) => {
    const db = options.databaseAdapter;
    if (!db) {
      throw new Error("Database adapter is not configured.");
    }
    requirePlatformAdminFromContext(c);
    const body = await readOptionalJson<{ days?: number }>(c.req.raw, {});
    const requested = Number(body.days);
    const days =
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 365;
    const before = new Date(Date.now() - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const removed = await db.pruneLlmUsageDaily(before);
    return json({ before, removed });
  });
}
