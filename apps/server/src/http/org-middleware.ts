import { isServiceAccountUserId, type OrgRole } from "@atlas/core";
import type { MiddlewareHandler } from "hono";
import type { ServerOptions } from "./context";
import { isPublicRouteRequest } from "./public-routes";
import { errorResponse, type RequestAuthContext } from "./shared";
import type { AppEnv } from "./types";

export const ORG_ID_HEADER = "x-org-id";

function isPlatformRoute(pathname: string): boolean {
  return pathname === "/v1/platform" || pathname.startsWith("/v1/platform/");
}

function isAuthRoute(pathname: string): boolean {
  return pathname === "/v1/auth" || pathname.startsWith("/v1/auth/");
}

function resolveOrgId(
  request: Request,
  auth: RequestAuthContext
): string | null {
  if (auth.workspaceWorker) {
    return auth.workspaceWorker.orgId;
  }

  const headerOrgId = request.headers.get(ORG_ID_HEADER)?.trim();
  if (headerOrgId) {
    return headerOrgId;
  }

  const sessionOrgId = auth.session?.activeOrgId?.trim();
  return sessionOrgId || null;
}

function sessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/|$)/);
  if (!match?.[1]) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function artifactProfileIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/profiles\/([^/]+)\/artifacts(?:\/|$)/);
  if (!match?.[1]) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function createOrgContextMiddleware(
  options: ServerOptions
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { databaseAdapter } = options;

    if (isPublicRouteRequest(c.req.method, c.req.path)) {
      await next();
      return;
    }

    const auth = c.get("auth");
    if (!auth) {
      await next();
      return;
    }

    if (!databaseAdapter) {
      c.res = errorResponse("Authentication not configured", 500);
      return;
    }

    if (isPlatformRoute(c.req.path) || isAuthRoute(c.req.path)) {
      await next();
      return;
    }

    let orgId = resolveOrgId(c.req.raw, auth);
    if (!orgId && auth.mode === "local-token") {
      const memberships = await databaseAdapter.listUserOrganizations(
        auth.user.id
      );
      if (memberships.length > 1) {
        c.res = errorResponse("Organization context required", 400);
        return;
      }
      orgId = memberships[0]?.organization.id ?? null;
    }
    if (!orgId) {
      c.res = errorResponse("Organization context required", 400);
      return;
    }

    const organization = await databaseAdapter.getOrganizationById(orgId);
    if (!organization || organization.archivedAt) {
      c.res = errorResponse("Not found", 404);
      return;
    }

    if (auth.workspaceWorker) {
      const sessionId = sessionIdFromPath(c.req.path);
      if (sessionId) {
        const session = await databaseAdapter.getSession(sessionId);
        const sessionUserId = session?.userId?.trim();
        const sessionMember = sessionUserId
          ? await databaseAdapter.getOrgMember(orgId, sessionUserId)
          : null;
        const sessionProfile = session
          ? await databaseAdapter.getProfileForOrg(session.profileId, orgId)
          : null;
        if (
          session &&
          (session.orgId !== orgId ||
            session.channel !== auth.workspaceWorker.channel ||
            !sessionUserId ||
            isServiceAccountUserId(sessionUserId) ||
            !sessionMember ||
            (c.req.method !== "GET" && sessionMember.role === "viewer") ||
            !sessionProfile ||
            sessionProfile.isSuper)
        ) {
          c.res = errorResponse("Not found", 404);
          return;
        }
      }

      const artifactProfileId = artifactProfileIdFromPath(c.req.path);
      if (artifactProfileId) {
        const artifactSessionId = c.req.query("sessionId")?.trim();
        const artifactSession = artifactSessionId
          ? await databaseAdapter.getSession(artifactSessionId)
          : null;
        const artifactSessionUserId = artifactSession?.userId?.trim();
        const artifactSessionMember = artifactSessionUserId
          ? await databaseAdapter.getOrgMember(orgId, artifactSessionUserId)
          : null;
        const artifactProfile = await databaseAdapter.getProfileForOrg(
          artifactProfileId,
          orgId
        );
        if (
          !(artifactSession && artifactProfile) ||
          artifactProfile.isSuper ||
          !artifactSessionUserId ||
          isServiceAccountUserId(artifactSessionUserId) ||
          !artifactSessionMember ||
          (c.req.method !== "GET" && artifactSessionMember.role === "viewer") ||
          artifactSession.orgId !== orgId ||
          artifactSession.channel !== auth.workspaceWorker.channel ||
          artifactSession.profileId !== artifactProfileId
        ) {
          c.res = errorResponse("Not found", 404);
          return;
        }
      }

      c.set("auth", {
        ...auth,
        activeOrgId: orgId,
        isPlatformAdmin: false,
        orgRole: "member",
      });
      await next();
      return;
    }

    const member = await databaseAdapter.getOrgMember(orgId, auth.user.id);
    if (!member) {
      c.res = errorResponse("Not found", 404);
      return;
    }

    c.set("auth", {
      ...auth,
      activeOrgId: orgId,
      orgRole: member.role as OrgRole,
    });

    await next();
  };
}
