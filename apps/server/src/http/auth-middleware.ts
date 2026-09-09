import { isWorkspaceWorkerAuthToken } from "@atlas/core";
import type { MiddlewareHandler } from "hono";
import type { ServerOptions } from "./context";
import { isPublicRouteRequest } from "./public-routes";
import { assertBrowserCsrf, authenticateRequest } from "./shared";
import type { AppEnv } from "./types";

const WORKSPACE_WORKER_SESSION_MESSAGES_PATH =
  /^\/v1\/sessions\/[^/]+\/messages$/;
const WORKSPACE_WORKER_SESSION_COMPACT_PATH =
  /^\/v1\/sessions\/[^/]+\/compact$/;
const WORKSPACE_WORKER_SESSION_PATH = /^\/v1\/sessions\/[^/]+$/;
const WORKSPACE_WORKER_PUBLICATION_PATH =
  /^\/v1\/sessions\/[^/]+\/artifact-publications(?:\/[^/]+\/content)?$/;
const WORKSPACE_WORKER_ARTIFACT_LIST_PATH =
  /^\/v1\/profiles\/[^/]+\/artifacts$/;
const WORKSPACE_WORKER_ARTIFACT_CONTENT_PATH =
  /^\/v1\/profiles\/[^/]+\/artifacts\/content$/;
const WORKSPACE_WORKER_ARTIFACT_SHARE_PATH =
  /^\/v1\/profiles\/[^/]+\/artifacts\/shares$/;

function requestHasWorkspaceWorkerToken(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return isWorkspaceWorkerAuthToken(authorization.slice(7).trim());
  }
  const apiKey = request.headers.get("x-api-key")?.trim();
  return apiKey ? isWorkspaceWorkerAuthToken(apiKey) : false;
}

function isWorkspaceWorkerRestrictedPath(path: string): boolean {
  return (
    path === "/v1/auth" ||
    path.startsWith("/v1/auth/") ||
    path === "/v1/platform" ||
    path.startsWith("/v1/platform/")
  );
}

function isWorkspaceWorkerAllowedRoute(method: string, path: string): boolean {
  if (method === "GET") {
    return (
      path === "/v1/models" ||
      path === "/v1/profiles" ||
      WORKSPACE_WORKER_SESSION_MESSAGES_PATH.test(path) ||
      WORKSPACE_WORKER_PUBLICATION_PATH.test(path) ||
      WORKSPACE_WORKER_ARTIFACT_LIST_PATH.test(path) ||
      WORKSPACE_WORKER_ARTIFACT_CONTENT_PATH.test(path)
    );
  }

  if (method === "POST") {
    return (
      path === "/v1/audio/transcribe" ||
      path === "/v1/channel-principals" ||
      path === "/v1/channel-principals/authorize" ||
      path === "/v1/channel-principals/approvals/decide" ||
      path === "/v1/channel-actions/context" ||
      path === "/v1/channel-actions/claim" ||
      path === "/v1/channel-actions/complete" ||
      path === "/v1/channel-voice/capabilities" ||
      path === "/v1/channel-voice/speech" ||
      path === "/v1/channel-voice/transcribe" ||
      path === "/v1/channels/discord/allowed-users" ||
      path === "/v1/sessions" ||
      WORKSPACE_WORKER_SESSION_MESSAGES_PATH.test(path) ||
      WORKSPACE_WORKER_SESSION_COMPACT_PATH.test(path) ||
      WORKSPACE_WORKER_ARTIFACT_SHARE_PATH.test(path)
    );
  }

  return method === "DELETE" && WORKSPACE_WORKER_SESSION_PATH.test(path);
}

export function createAuthMiddleware(
  options: ServerOptions
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { authService, databaseAdapter } = options;

    const isPublic = isPublicRouteRequest(c.req.method, c.req.path);
    if (
      !authService ||
      (isPublic && !requestHasWorkspaceWorkerToken(c.req.raw))
    ) {
      await next();
      return;
    }

    if (!databaseAdapter) {
      c.res = Response.json(
        { error: "Authentication not configured" },
        { status: 500 }
      );
      return;
    }

    const auth = await authenticateRequest(
      c.req.raw,
      authService,
      databaseAdapter
    );
    if (!auth) {
      c.res = Response.json(
        { error: "Authentication required" },
        { status: 401 }
      );
      return;
    }

    if (auth.workspaceWorker) {
      if (isWorkspaceWorkerRestrictedPath(c.req.path)) {
        c.res = Response.json(
          { error: "Workspace worker credentials cannot access this route" },
          { status: 403 }
        );
        return;
      }
      if (
        !(isPublic || isWorkspaceWorkerAllowedRoute(c.req.method, c.req.path))
      ) {
        c.res = Response.json(
          { error: "Workspace worker credential cannot access this route" },
          { status: 403 }
        );
        return;
      }
      const requestedOrgId = c.req.header("X-Org-Id")?.trim();
      if (requestedOrgId && requestedOrgId !== auth.workspaceWorker.orgId) {
        c.res = Response.json(
          {
            error:
              "Workspace worker credential is scoped to another organization",
          },
          { status: 403 }
        );
        return;
      }
    }

    try {
      assertBrowserCsrf(c.req.raw, auth, authService);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        "status" in error
      ) {
        c.res = Response.json(
          { error: String(error.message) },
          { status: Number(error.status) }
        );
        return;
      }

      throw error;
    }

    c.set("auth", auth);
    await next();
  };
}
