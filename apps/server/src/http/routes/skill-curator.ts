import { AtlasApiError } from "@atlas/core";
import type {
  SkillCuratorRunResult,
  SkillCuratorStatusResponse,
} from "@atlas/core/contract";
import { createRoute, z } from "@hono/zod-openapi";
import type { SkillCuratorService } from "../../services/skill-curator-service";
import type { ServerOptions } from "../context";
import { requireOrgAdminFromContext } from "../org-guards";
import { json } from "../shared";
import type { HonoApp } from "../types";

const orgParams = z.object({
  orgId: z.string().openapi({ param: { in: "path", name: "orgId" } }),
});
const genericResponse = z.object({}).passthrough();

export function registerSkillCuratorRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  const requireService = (): SkillCuratorService => {
    if (!options.skillCuratorService) {
      throw new AtlasApiError("Skill curator service not configured.", 500);
    }
    return options.skillCuratorService;
  };
  const resolveOrgId = (pathOrgId: string, activeOrgId: string): string => {
    const orgId = decodeURIComponent(pathOrgId);
    if (orgId !== activeOrgId) {
      throw new AtlasApiError("Not found", 404);
    }
    return orgId;
  };

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getSkillCuratorStatus",
      path: "/v1/orgs/{orgId}/skill-curator",
      request: { params: orgParams },
      responses: {
        200: {
          content: { "application/json": { schema: genericResponse } },
          description: "Skill curator status",
        },
      },
      summary: "Get skill curator status",
      tags: ["Organizations"],
    })
  );
  app.get("/v1/orgs/:orgId/skill-curator", async (c) => {
    const auth = requireOrgAdminFromContext(c);
    const orgId = resolveOrgId(c.req.param("orgId"), auth.activeOrgId ?? "");
    return json<SkillCuratorStatusResponse>(
      await requireService().status(orgId)
    );
  });

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "runSkillCurator",
      path: "/v1/orgs/{orgId}/skill-curator/consolidate",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({ profileId: z.string().optional() }),
            },
          },
        },
        params: orgParams,
      },
      responses: {
        200: {
          content: { "application/json": { schema: genericResponse } },
          description: "Skill curator result",
        },
      },
      summary: "Run skill consolidation",
      tags: ["Organizations"],
    })
  );
  app.post("/v1/orgs/:orgId/skill-curator/consolidate", async (c) => {
    const auth = requireOrgAdminFromContext(c);
    const orgId = resolveOrgId(c.req.param("orgId"), auth.activeOrgId ?? "");
    const body = (await c.req.json().catch(() => ({}))) as {
      profileId?: unknown;
    };
    if (body.profileId !== undefined && typeof body.profileId !== "string") {
      throw new AtlasApiError("profileId must be a string.", 400);
    }
    const profileId = body.profileId?.trim() || undefined;
    return json<SkillCuratorRunResult>(
      await requireService().run(orgId, {
        profileId,
        proposedByUserId: auth.user.id,
        trigger: "manual",
      })
    );
  });
}
