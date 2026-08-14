import { AtlasApiError } from "@atlas/core";
import type { Context } from "hono";
import { getRequestAuth, type RequestAuthContext } from "./shared";
import type { AppEnv } from "./types";

export function requireOrgAdmin(auth: RequestAuthContext): void {
  if (auth.orgRole !== "admin" && !auth.isPlatformAdmin) {
    throw new AtlasApiError("Workspace Admin access required", 403);
  }
}

export function requireNotViewer(auth: RequestAuthContext): void {
  if (auth.orgRole === "viewer") {
    throw new AtlasApiError("Viewer access is read-only", 403);
  }
}

export function requirePlatformAdmin(auth: RequestAuthContext): void {
  if (!auth.isPlatformAdmin) {
    throw new AtlasApiError("Superadmin access required", 403);
  }
}

export function requireOrgAdminFromContext(
  c: Context<AppEnv>
): RequestAuthContext {
  const auth = getRequestAuth(c);
  requireOrgAdmin(auth);
  return auth;
}

export function requireOrgAdminOrPlatformAdmin(auth: RequestAuthContext): void {
  if (auth.orgRole === "admin" || auth.isPlatformAdmin) {
    return;
  }

  throw new AtlasApiError("Workspace Admin or Superadmin access required", 403);
}

export function requireOrgAdminOrPlatformAdminFromContext(
  c: Context<AppEnv>
): RequestAuthContext {
  const auth = getRequestAuth(c);
  requireOrgAdminOrPlatformAdmin(auth);
  return auth;
}

export function requireNotViewerFromContext(
  c: Context<AppEnv>
): RequestAuthContext {
  const auth = getRequestAuth(c);
  requireNotViewer(auth);
  return auth;
}

export function requirePlatformAdminFromContext(
  c: Context<AppEnv>
): RequestAuthContext {
  const auth = getRequestAuth(c);
  requirePlatformAdmin(auth);
  return auth;
}

export function requireSystemOperatorFromContext(
  c: Context<AppEnv>
): RequestAuthContext {
  const auth = getRequestAuth(c);
  if (auth.mode !== "local-token") {
    requirePlatformAdmin(auth);
  }
  return auth;
}

export function requireActiveOrgIdFromContext(c: Context<AppEnv>): string {
  const orgId = getRequestAuth(c).activeOrgId?.trim();

  if (!orgId) {
    throw new AtlasApiError("Workspace context required", 400);
  }

  return orgId;
}
