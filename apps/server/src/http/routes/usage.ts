import type { LlmUsageReportGroupBy } from "@atlas/core";
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
import { getRequestAuth, json, readJson } from "../shared";
import type { HonoApp } from "../types";

const GROUP_BY_VALUES: LlmUsageReportGroupBy[] = [
  "workspace",
  "user",
  "provider",
  "model",
  "credential",
];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseGroupBy(value: string | undefined): LlmUsageReportGroupBy {
  return GROUP_BY_VALUES.includes(value as LlmUsageReportGroupBy)
    ? (value as LlmUsageReportGroupBy)
    : "workspace";
}

function parseDate(value: string | undefined): string | undefined {
  return value && DATE_PATTERN.test(value) ? value : undefined;
}

function csvField(value: string | number): string {
  const text = String(value);
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
 * Multi-tenant LLM usage breakdown. RBAC scoping (platform admin → all
 * workspaces; workspace admin → own workspace; member → self) lives in
 * UsageReportService so it stays consistent and testable.
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

    const limitRaw = Number(c.req.query("limit"));
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

    return service
      .getReport(
        {
          from: parseDate(c.req.query("from")),
          groupBy: parseGroupBy(c.req.query("groupBy")),
          limit,
          to: parseDate(c.req.query("to")),
        },
        accessFromContext(auth)
      )
      .then((report) => json(report));
  });

  app.get("/v1/usage/export.csv", async (c) => {
    const db = options.databaseAdapter;
    if (!db) {
      throw new Error("Database adapter is not configured.");
    }
    const auth = getRequestAuth(c);
    const groupBy = parseGroupBy(c.req.query("groupBy"));
    const report = await new UsageReportService(db).getReport(
      {
        from: parseDate(c.req.query("from")),
        groupBy,
        limit: 1000,
        to: parseDate(c.req.query("to")),
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
    const body = await readJson<{ days?: number }>(c.req.raw).catch(() => ({}));
    const requested = Number((body as { days?: number }).days);
    const days =
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 365;
    const before = new Date(Date.now() - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const removed = await db.pruneLlmUsageDaily(before);
    return json({ before, removed });
  });
}
