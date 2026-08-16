import {
  ATLAS_API_VERSION,
  ExecutionCostTracker,
  ExecutionSummaryBuilder,
  generateSafeDebugBundle,
  isComposioConfiguredAsync,
  metrics,
} from "@atlas/core";
import type { UpdateWebPublicUrlRequest } from "@atlas/core/contract";
import { createRoute, z } from "@hono/zod-openapi";
import { defaultExecutionQueue } from "../../services/backpressure-queue";
import {
  getWebPublicUrlSettings,
  persistWebPublicUrl,
  resolveRequestClientOrigin,
} from "../../services/composio-callback-url";
import { gracefulShutdownManager } from "../../services/graceful-shutdown";
import { stuckJobReaper } from "../../services/stuck-job-reaper";
import type { ServerOptions } from "../context";
import {
  requireActiveOrgIdFromContext,
  requirePlatformAdminFromContext,
} from "../org-guards";
import { errorResponse, readJson } from "../shared";
import type { HonoApp } from "../types";

const DOCS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Atlas API</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference("#app", {
        url: "/openapi.json",
        theme: "default",
      });
    </script>
  </body>
</html>
`;

export function registerSystemRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  const { agent, databaseAdapter, systemStatus } = options;
  const healthResponseSchema = z
    .object({
      apiVersion: z.number().int(),
      composioAvailable: z.boolean().openapi({
        description:
          "Whether Composio is reachable. Always false on /health (no live probe). Check GET /v1/system/status for the probed value.",
      }),
      composioConfigured: z.boolean().openapi({
        description: "Whether a Composio project API key is saved locally.",
      }),
      ok: z.literal(true),
      providerConfigured: z.boolean(),
      userConfigured: z.boolean(),
    })
    .openapi("HealthResponse");
  const systemStatusSchema = z
    .object({ ok: z.boolean() })
    .passthrough()
    .openapi("SystemStatusResponse");
  const errorSchema = z
    .object({ error: z.string() })
    .openapi("ApiErrorResponse");

  const healthRoute = createRoute({
    method: "get",
    operationId: "getHealth",
    path: "/health",
    responses: {
      200: {
        content: { "application/json": { schema: healthResponseSchema } },
        description: "Server is healthy",
      },
    },
    summary: "Health check",
    tags: ["Health"],
  });

  const systemStatusRoute = createRoute({
    method: "get",
    operationId: "getSystemStatus",
    path: "/v1/system/status",
    responses: {
      200: {
        content: { "application/json": { schema: systemStatusSchema } },
        description: "Server and automation worker status",
      },
      500: {
        content: { "application/json": { schema: errorSchema } },
        description: "Error",
      },
    },
    summary: "System status",
    tags: ["Health"],
  });

  const updateWebPublicUrlRoute = createRoute({
    method: "put",
    operationId: "updateWebPublicUrl",
    path: "/v1/system/web-public-url",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                webPublicUrl: z.string(),
              })
              .openapi("UpdateWebPublicUrlRequest"),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z
              .object({ webPublicUrl: z.string() })
              .openapi("UpdateWebPublicUrlResponse"),
          },
        },
        description: "Saved web public URL",
      },
      400: {
        content: { "application/json": { schema: errorSchema } },
        description: "Error",
      },
    },
    summary: "Persist the public web app URL for OAuth callbacks",
    tags: ["Health"],
  });

  const getWebPublicUrlRoute = createRoute({
    method: "get",
    operationId: "getWebPublicUrl",
    path: "/v1/system/web-public-url",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z
              .object({
                envOverride: z.string().nullable(),
                webPublicUrl: z.string().nullable(),
              })
              .openapi("WebPublicUrlSettingsResponse"),
          },
        },
        description: "Web public URL settings",
      },
    },
    summary: "Read the saved public web app URL for OAuth callbacks",
    tags: ["Health"],
  });

  app.get(
    "/docs",
    () =>
      new Response(DOCS_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
  );

  app.get(
    "/docs/",
    () =>
      new Response(DOCS_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
  );

  app.openapi(healthRoute, async (c) => {
    // Local checks only — Composio reachability is on GET /v1/system/status.
    const humanUserCount = (await databaseAdapter?.countHumanUsers()) ?? 0;
    const composioConfigured = await isComposioConfiguredAsync();
    return c.json(
      {
        apiVersion: ATLAS_API_VERSION,
        composioAvailable: false,
        composioConfigured,
        ok: true,
        providerConfigured: agent.providerConfigured,
        userConfigured: humanUserCount > 0,
      },
      200
    );
  });

  // /health/live - Liveness probe
  app.get("/health/live", (c) =>
    c.json({ ok: true, status: "live", uptime: process.uptime() }, 200)
  );

  // /health/ready - Readiness probe
  app.get("/health/ready", async (c) => {
    if (gracefulShutdownManager.isDraining()) {
      return c.json(
        {
          ok: false,
          reason: "Server is draining / shutting down",
          status: "not_ready",
        },
        503
      );
    }

    try {
      // Test database connectivity
      await databaseAdapter?.countHumanUsers();
    } catch {
      return c.json(
        { ok: false, reason: "Database unreachable", status: "not_ready" },
        503
      );
    }

    const queueStats = defaultExecutionQueue.getStats();
    if (queueStats.queued >= queueStats.maxQueueDepth) {
      return c.json(
        { ok: false, reason: "Execution queue saturated", status: "not_ready" },
        503
      );
    }

    return c.json({ ok: true, status: "ready" }, 200);
  });

  // /health/deep - Deep health diagnostics (Admin only)
  app.get("/health/deep", async (c) => {
    requirePlatformAdminFromContext(c);

    let dbOk = false;
    let usersCount = 0;
    try {
      usersCount = (await databaseAdapter?.countHumanUsers()) ?? 0;
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const queueStats = defaultExecutionQueue.getStats();
    const mem = process.memoryUsage();

    return c.json(
      {
        database: { ok: dbOk, userCount: usersCount },
        environment: {
          gitSha: process.env.GIT_SHA || process.env.COMMIT_SHA || "local-dev",
          nodeEnv: process.env.NODE_ENV || "development",
          platform: process.platform,
          version: ATLAS_API_VERSION,
        },
        memory: {
          external: Math.round(mem.external / 1024 / 1024),
          heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
          heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
          rssMb: Math.round(mem.rss / 1024 / 1024),
        },
        ok: dbOk && !gracefulShutdownManager.isDraining(),
        queue: queueStats,
        reaper: { activeLeases: stuckJobReaper.getActiveLeasesCount() },
        uptimeSeconds: Math.round(process.uptime()),
      },
      200
    );
  });

  // Prometheus text format metrics
  app.get("/metrics", (c) => {
    requirePlatformAdminFromContext(c);
    return new Response(metrics.toPrometheus(), {
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
      status: 200,
    });
  });

  // JSON operational metrics (Admin only)
  app.get("/v1/system/metrics", (c) => {
    requirePlatformAdminFromContext(c);
    return c.json({ metrics: metrics.getAllMetrics() }, 200);
  });

  // Safe debug bundle diagnostics export (Tenant isolated)
  app.get("/v1/system/diagnostics/debug-bundle/:sessionId", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const sessionId = decodeURIComponent(c.req.param("sessionId"));

    const session = await agent.getSessionMessages(orgId, sessionId);
    if (!session) {
      return errorResponse("Session not found", 404);
    }

    const builder = new ExecutionSummaryBuilder(
      `diag_${sessionId}`,
      sessionId,
      orgId
    );
    builder.recordEvent("diagnostics.requested", "Diagnostics bundle exported");

    const costSummary = new ExecutionCostTracker(
      `diag_${sessionId}`,
      sessionId,
      orgId
    ).getSummary();
    const summary = builder.build(costSummary);
    const bundle = generateSafeDebugBundle(summary);

    return c.json(bundle, 200);
  });

  app.openapi(systemStatusRoute, async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    return c.json(await systemStatus.getStatus(orgId), 200);
  });

  app.openapi(getWebPublicUrlRoute, async (c) => {
    requirePlatformAdminFromContext(c);
    return c.json(await getWebPublicUrlSettings(), 200);
  });

  app.openAPIRegistry.registerPath(updateWebPublicUrlRoute);

  app.put("/v1/system/web-public-url", async (c) => {
    requirePlatformAdminFromContext(c);
    const body = await readJson<UpdateWebPublicUrlRequest>(c.req.raw);
    const webPublicUrl = resolveRequestClientOrigin(
      c.req.raw,
      body.webPublicUrl
    );

    if (!webPublicUrl) {
      return errorResponse("webPublicUrl is required.", 400);
    }

    try {
      return c.json(
        { webPublicUrl: await persistWebPublicUrl(webPublicUrl) },
        200
      );
    } catch (error) {
      return errorResponse(
        error instanceof Error ? error.message : String(error),
        400
      );
    }
  });
}
