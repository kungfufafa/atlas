import type { LlmUsageReportGroupBy } from "@atlas/core";
import { UsageReportService } from "../../services/usage-report-service";
import type { ServerOptions } from "../context";
import { getRequestAuth, json } from "../shared";
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
        {
          isPlatformAdmin: auth.isPlatformAdmin,
          orgId: auth.activeOrgId,
          orgRole: auth.orgRole,
          userId: auth.user.id,
        }
      )
      .then((report) => json(report));
  });
}
