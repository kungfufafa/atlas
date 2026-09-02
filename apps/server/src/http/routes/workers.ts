import type { WorkerLogsResponse } from "@atlas/core";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ServerOptions } from "../context";
import {
  requireNotViewerFromContext,
  requireOrgAdminOrPlatformAdminFromContext,
  requirePlatformAdminFromContext,
} from "../org-guards";
import { errorResponse, getRequestAuth, json } from "../shared";
import type { AppEnv, HonoApp } from "../types";

const WORKSPACE_WORKER_NAMES = new Set(["telegram", "whatsapp", "discord"]);

function isWorkspaceWorkerName(
  workerManager: ServerOptions["workerManager"],
  name: string
): boolean {
  if (typeof workerManager.isWorkspaceWorker === "function") {
    return workerManager.isWorkspaceWorker(name);
  }
  return WORKSPACE_WORKER_NAMES.has(name);
}

function requireWorkerAuthorization(c: Context<AppEnv>, name: string): void {
  requireNotViewerFromContext(c);
  if (name === "automation") {
    requirePlatformAdminFromContext(c);
  } else {
    requireOrgAdminOrPlatformAdminFromContext(c);
  }
}

export function registerWorkerRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  const { workerManager } = options;
  const errorSchema = z
    .object({ error: z.string() })
    .openapi("ApiErrorResponse");
  const workerLogsSchema = z
    .object({
      lines: z.array(z.string()),
      worker: z.string(),
    })
    .passthrough()
    .openapi("WorkerLogsResponse");
  const okSchema = z.object({ ok: z.boolean() });
  const workerParam = z.object({
    name: z.string().openapi({ param: { in: "path", name: "name" } }),
  });
  const workerActionParam = z.object({
    action: z
      .enum(["start", "stop", "restart"])
      .openapi({ param: { in: "path", name: "action" } }),
    name: z.string().openapi({ param: { in: "path", name: "name" } }),
  });
  const workerLogsQuery = z.object({
    lines: z.string().optional(),
  });

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "workerAction",
      path: "/v1/workers/{name}/{action}",
      request: { params: workerActionParam },
      responses: {
        200: {
          content: { "application/json": { schema: okSchema } },
          description: "Worker action succeeded",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Control a worker",
      tags: ["Workers"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getWorkerLogs",
      path: "/v1/workers/{name}/logs",
      request: { params: workerParam, query: workerLogsQuery },
      responses: {
        200: {
          content: { "application/json": { schema: workerLogsSchema } },
          description: "Worker logs",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Get worker logs",
      tags: ["Workers"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "clearWorkerLogs",
      path: "/v1/workers/{name}/clear-logs",
      request: { params: workerParam },
      responses: {
        200: {
          content: { "application/json": { schema: okSchema } },
          description: "Worker logs cleared",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Clear worker logs",
      tags: ["Workers"],
    })
  );

  app.post("/v1/workers/:name/:action{start|stop|restart}", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const action = c.req.param("action");
    requireWorkerAuthorization(c, name);

    if (!workerManager.isValidWorker(name)) {
      return errorResponse(`Unknown worker: ${name}`, 400);
    }

    const orgId = getRequestAuth(c).activeOrgId?.trim();

    try {
      if (orgId && isWorkspaceWorkerName(workerManager, name)) {
        if (action === "start") {
          if (typeof workerManager.startWorkspaceWorker === "function") {
            await workerManager.startWorkspaceWorker(name as any, orgId);
          } else {
            await workerManager.startWorker(name);
          }
        } else if (action === "stop") {
          if (typeof workerManager.stopWorkspaceWorker === "function") {
            await workerManager.stopWorkspaceWorker(name as any, orgId);
          } else {
            await workerManager.stopWorker(name);
          }
        } else if (typeof workerManager.restartWorkspaceWorker === "function") {
          await workerManager.restartWorkspaceWorker(name as any, orgId);
        } else if (typeof workerManager.restartWorker === "function") {
          await workerManager.restartWorker(name);
        } else {
          await workerManager.startWorker(name);
        }
      } else if (action === "start") {
        await workerManager.startWorker(name);
      } else if (action === "stop") {
        await workerManager.stopWorker(name);
      } else {
        await workerManager.restartWorker(name);
      }

      return json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(message, 500);
    }
  });

  app.get("/v1/workers/:name/logs", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    requireWorkerAuthorization(c, name);

    if (!workerManager.isValidWorker(name)) {
      return errorResponse(`Unknown worker: ${name}`, 400);
    }

    const orgId = getRequestAuth(c).activeOrgId?.trim();
    const linesParam = c.req.query("lines");
    const parsedLines = linesParam ? Number.parseInt(linesParam, 10) : 200;
    const lines = Math.min(
      Math.max(1, Number.isFinite(parsedLines) ? parsedLines : 200),
      2000
    );

    try {
      const logs = await workerManager.getWorkerLogs(name, lines, orgId);
      return json<WorkerLogsResponse>(logs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(message, 500);
    }
  });

  app.post("/v1/workers/:name/clear-logs", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    requireWorkerAuthorization(c, name);

    if (!workerManager.isValidWorker(name)) {
      return errorResponse(`Unknown worker: ${name}`, 400);
    }

    const orgId = getRequestAuth(c).activeOrgId?.trim();

    try {
      await workerManager.clearWorkerLogs(name, orgId);
      return json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(message, 500);
    }
  });
}
