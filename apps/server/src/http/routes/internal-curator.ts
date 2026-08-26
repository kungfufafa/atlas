import type {
  ListSkillCuratorScheduleOrgsResponse,
  SkillCuratorDueRunResponse,
} from "@atlas/core/contract";
import type { ServerOptions } from "../context";
import { errorResponse, json } from "../shared";
import type { HonoApp } from "../types";

export function registerInternalCuratorRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  const { orgService, skillCuratorService } = options;

  app.get("/v1/internal/curator/orgs", async (c) => {
    const auth = c.get("auth");
    if (!auth || auth.mode !== "local-token") {
      return errorResponse("Authentication required", 401);
    }
    if (!orgService) {
      return errorResponse("Organization service not configured", 500);
    }
    return json<ListSkillCuratorScheduleOrgsResponse>({
      orgs: await orgService.listSkillCuratorOrgs(),
    });
  });

  app.post("/v1/internal/curator/orgs/:orgId/run-due", async (c) => {
    const auth = c.get("auth");
    if (!auth || auth.mode !== "local-token") {
      return errorResponse("Authentication required", 401);
    }
    if (!(orgService && skillCuratorService)) {
      return errorResponse("Skill curator service not configured", 500);
    }

    const orgId = decodeURIComponent(c.req.param("orgId"));
    const organization = await orgService.getOrganization(orgId);
    if (!organization || organization.archivedAt) {
      return errorResponse("Not found", 404);
    }

    return json<SkillCuratorDueRunResponse>({
      result: await skillCuratorService.runDue(orgId),
    });
  });
}
