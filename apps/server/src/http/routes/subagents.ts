import {
  canAccessSuperAgentProfile,
  PrincipalRequiredError,
} from "@atlas/core";
import type { ServerOptions } from "../context";
import {
  requireActiveOrgIdFromContext,
  requireNotViewerFromContext,
} from "../org-guards";
import { errorResponse, getRequestAuth, json, readJson } from "../shared";
import type { HonoApp } from "../types";

export function registerSubagentRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  const { agent } = options;

  app.post("/v1/subagents", async (c) => {
    requireNotViewerFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const auth = getRequestAuth(c);
    const body = await readJson<{
      context?: string;
      profileId: string;
      sessionId?: string;
      task: string;
      timeoutMs?: number;
    }>(c.req.raw);
    if (!auth.orgRole) {
      return errorResponse("Canonical principal is required.", 403);
    }
    const principal = {
      isPlatformAdmin: auth.isPlatformAdmin === true,
      orgId,
      orgRole: auth.orgRole,
      userId: auth.user.id,
    };
    if (
      body.sessionId &&
      !(await agent.canAccessSession(
        orgId,
        body.sessionId,
        {
          isPlatformAdmin: principal.isPlatformAdmin,
          orgRole: principal.orgRole,
          userId: principal.userId,
        },
        "invoke"
      ))
    ) {
      return errorResponse("Session not found.", 404);
    }
    if (
      !canAccessSuperAgentProfile({
        isPlatformAdmin: auth.isPlatformAdmin,
        orgRole: auth.orgRole,
      })
    ) {
      const profile = await options.databaseAdapter?.getProfileForOrg(
        body.profileId,
        orgId
      );
      if (profile?.isSuper) {
        return errorResponse(
          "Super Agent is only available to Workspace Admins and Superadmins.",
          403
        );
      }
    }
    try {
      const handle = await agent.subagents.start({
        agentDepth: 1,
        context: body.context,
        orgId,
        principal,
        profileId: body.profileId,
        sessionId: body.sessionId,
        task: body.task,
        timeoutMs: body.timeoutMs,
      });
      return json({ handle }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        error instanceof PrincipalRequiredError ||
        /Super Agent is only available/i.test(message)
          ? 403
          : 400;
      return errorResponse(message, status);
    }
  });

  app.get("/v1/subagents/:subagentId", async (c) => {
    requireNotViewerFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const auth = getRequestAuth(c);
    if (!auth.orgRole) {
      return errorResponse("Canonical principal is required.", 403);
    }
    try {
      const handle = await agent.subagents.poll(c.req.param("subagentId"), {
        isPlatformAdmin: auth.isPlatformAdmin === true,
        orgId,
        orgRole: auth.orgRole,
        userId: auth.user.id,
      });
      return json({ handle });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 404);
    }
  });

  app.post("/v1/subagents/:subagentId/wait", async (c) => {
    requireNotViewerFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const auth = getRequestAuth(c);
    if (!auth.orgRole) {
      return errorResponse("Canonical principal is required.", 403);
    }
    try {
      const waited = await agent.subagents.wait(c.req.param("subagentId"), {
        isPlatformAdmin: auth.isPlatformAdmin === true,
        orgId,
        orgRole: auth.orgRole,
        userId: auth.user.id,
      });
      return json(waited);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 404);
    }
  });

  app.post("/v1/subagents/:subagentId/cancel", async (c) => {
    requireNotViewerFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const auth = getRequestAuth(c);
    if (!auth.orgRole) {
      return errorResponse("Canonical principal is required.", 403);
    }
    try {
      const handle = await agent.subagents.cancel(c.req.param("subagentId"), {
        isPlatformAdmin: auth.isPlatformAdmin === true,
        orgId,
        orgRole: auth.orgRole,
        userId: auth.user.id,
      });
      return json({ handle });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });
}
