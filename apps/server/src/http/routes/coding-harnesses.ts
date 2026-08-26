import type {
  CodingHarnessSettingsResponse,
  UpdateCodingHarnessSettingsRequest,
} from "@atlas/core";
import { AtlasApiError } from "@atlas/core";
import {
  listCodingHarnessLoginCommands,
  loadCodingAgentProviderPassthroughForOrg,
  saveCodingAgentProviderPassthroughForOrg,
} from "../../services/coding-agent-harness-service";
import type { ServerOptions } from "../context";
import {
  requireActiveOrgIdFromContext,
  requirePlatformAdminFromContext,
} from "../org-guards";
import { json, readJson } from "../shared";
import type { HonoApp } from "../types";

export function registerCodingHarnessSettingsRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  app.get("/v1/settings/coding-harnesses", async (context) => {
    requirePlatformAdminFromContext(context);
    const orgId = requireActiveOrgIdFromContext(context);
    const db = options.databaseAdapter;
    if (!db) {
      throw new Error("Database adapter is not configured.");
    }
    return json<CodingHarnessSettingsResponse>({
      loginCommands: listCodingHarnessLoginCommands(),
      providerPassthroughEnabled:
        await loadCodingAgentProviderPassthroughForOrg(db, orgId),
    });
  });

  app.put("/v1/settings/coding-harnesses", async (context) => {
    requirePlatformAdminFromContext(context);
    const orgId = requireActiveOrgIdFromContext(context);
    const body = await readJson<UpdateCodingHarnessSettingsRequest>(
      context.req.raw
    );
    if (typeof body.providerPassthroughEnabled !== "boolean") {
      throw new AtlasApiError(
        "providerPassthroughEnabled must be a boolean.",
        400
      );
    }
    const db = options.databaseAdapter;
    if (!db) {
      throw new Error("Database adapter is not configured.");
    }
    const providerPassthroughEnabled =
      await saveCodingAgentProviderPassthroughForOrg(
        db,
        orgId,
        body.providerPassthroughEnabled
      );
    options.agent.invalidateSessionsForOrg(orgId);
    return json<CodingHarnessSettingsResponse>({
      loginCommands: listCodingHarnessLoginCommands(),
      providerPassthroughEnabled,
    });
  });
}
