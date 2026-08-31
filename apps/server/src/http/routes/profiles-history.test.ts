import { describe, expect, test } from "bun:test";
import {
  createInMemoryDatabaseAdapter,
  ensureBuiltinToolDefinitions,
} from "@atlas/db";
import {
  ProfileChangeHistoryService,
  type ProfileChangeMeta,
} from "../../services/profile-change-history";
import { ProfileService } from "../../services/profile-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import {
  loginUserSession,
  setupFreshInstallSession,
} from "../test-session-helpers";

setupTestConfigDir("atlas-profile-history-routes-");

const BASE_URL = "http://localhost:4310";

function createApp() {
  const databaseAdapter = createInMemoryDatabaseAdapter();
  const profileService = new ProfileService(databaseAdapter);
  const soulContents = new Map<string, string>();
  const agent = {
    assignTool: (
      orgId: string,
      profileId: string,
      request: { toolId: string }
    ) => profileService.assignTool(orgId, profileId, request),
    deleteTool: (orgId: string, toolId: string) =>
      profileService.deleteTool(orgId, toolId),
    getProfile: (orgId: string, profileId: string) =>
      profileService.getProfile(orgId, profileId),
    getProfileSoulStack: async (orgId: string, profileId: string) => {
      await profileService.getProfile(orgId, profileId);
      return {
        directory: "",
        files: { soul: soulContents.get(profileId) ?? "# Before" },
        loaded: ["soul"],
        profileId,
      };
    },
    listProfiles: (orgId: string) => profileService.listProfiles(orgId),
    updateProfile: (
      orgId: string,
      profileId: string,
      request: { systemPrompt?: string },
      changeMeta?: ProfileChangeMeta
    ) => profileService.updateProfile(orgId, profileId, request, changeMeta),
    writeProfileSoulFile: async (
      orgId: string,
      profileId: string,
      key: string,
      request: { content: string },
      changeMeta?: ProfileChangeMeta
    ) => {
      await profileService.getProfile(orgId, profileId);
      if (key !== "soul") {
        throw new Error("Unexpected soul key in test.");
      }
      const beforeValue = soulContents.get(profileId) ?? "# Before";
      soulContents.set(profileId, request.content);
      if (changeMeta) {
        await new ProfileChangeHistoryService(databaseAdapter).recordBestEffort(
          {
            actorUserId: changeMeta.actorUserId,
            afterValue: request.content,
            beforeValue,
            field: "soul.soul",
            orgId,
            profileId,
            source: changeMeta.source,
          }
        );
      }
    },
  };
  return {
    ...createMinimalHonoApp({ agent, databaseAdapter }),
    databaseAdapter,
    profileService,
  };
}

describe("profile change history routes", () => {
  test("records dashboard mutations and restricts history to workspace admins", async () => {
    const { app, authService, databaseAdapter } = createApp();
    const platform = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "history-admin@example.com"
    );
    const orgId = platform.orgId!;
    const profile = (await databaseAdapter.listProfilesForOrg(orgId))[0]!;
    const adminUser = await databaseAdapter.getUserByEmail(
      "history-admin@example.com"
    );
    expect(adminUser).toBeDefined();

    const update = await app.fetch(
      new Request(`${BASE_URL}/v1/profiles/${profile.id}`, {
        body: JSON.stringify({ systemPrompt: "Changed in dashboard" }),
        headers: platform.headers(
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": platform.csrfToken,
          },
          orgId
        ),
        method: "PUT",
      })
    );
    expect(update.status).toBe(200);

    const writeSoul = await app.fetch(
      new Request(`${BASE_URL}/v1/profiles/${profile.id}/soul/files/soul`, {
        body: JSON.stringify({ content: "# After" }),
        headers: platform.headers(
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": platform.csrfToken,
          },
          orgId
        ),
        method: "PUT",
      })
    );
    expect(writeSoul.status).toBe(204);

    await ensureBuiltinToolDefinitions(databaseAdapter);
    const tool = (await databaseAdapter.listToolsForOrg(orgId))[0]!;
    const assignTool = await app.fetch(
      new Request(`${BASE_URL}/v1/profiles/${profile.id}/tools`, {
        body: JSON.stringify({ toolId: tool.id }),
        headers: platform.headers(
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": platform.csrfToken,
          },
          orgId
        ),
        method: "POST",
      })
    );
    expect(assignTool.status).toBe(200);

    const allowed = await app.fetch(
      new Request(`${BASE_URL}/v1/profiles/${profile.id}/history?limit=100`, {
        headers: platform.headers({}, orgId),
      })
    );
    expect(allowed.status).toBe(200);
    const history = (await allowed.json()) as {
      events: Array<{
        actorUserId: string | null;
        field: string;
        source: string;
      }>;
    };
    expect(history.events.map((event) => event.field).sort()).toEqual([
      "soul.soul",
      "system_prompt",
      "tools",
    ]);
    expect(
      history.events.every(
        (event) =>
          event.actorUserId === adminUser!.id && event.source === "dashboard"
      )
    ).toBe(true);

    const now = new Date().toISOString();
    await databaseAdapter.createUser({
      createdAt: now,
      email: "history-viewer@example.com",
      id: "user_history_viewer",
      passwordHash: await authService.hashPassword("password123"),
      updatedAt: now,
    });
    await databaseAdapter.upsertOrgMember({
      createdAt: now,
      orgId,
      role: "viewer",
      userId: "user_history_viewer",
    });
    const viewer = await loginUserSession(
      app,
      "history-viewer@example.com",
      "password123",
      orgId
    );
    const denied = await app.fetch(
      new Request(`${BASE_URL}/v1/profiles/${profile.id}/history`, {
        headers: viewer.headers({}, orgId),
      })
    );
    expect(denied.status).toBe(403);
  }, 20_000);

  test("rejects invalid pagination and profiles outside the active workspace", async () => {
    const { app, databaseAdapter } = createApp();
    const platform = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "history-tenant@example.com"
    );
    const orgId = platform.orgId!;
    const profile = (await databaseAdapter.listProfilesForOrg(orgId))[0]!;

    const invalid = await app.fetch(
      new Request(`${BASE_URL}/v1/profiles/${profile.id}/history?limit=1.5`, {
        headers: platform.headers({}, orgId),
      })
    );
    expect(invalid.status).toBe(400);

    const now = new Date().toISOString();
    await databaseAdapter.upsertOrganization({
      createdAt: now,
      id: "org_history_other",
      name: "Other workspace",
      slug: "history-other",
      updatedAt: now,
    });
    await databaseAdapter.upsertProfile({
      createdAt: now,
      id: "profile_history_other",
      isDefault: false,
      isSuper: false,
      model: null,
      name: "Other profile",
      orgId: "org_history_other",
      systemPrompt: "",
      updatedAt: now,
    });

    const hidden = await app.fetch(
      new Request(`${BASE_URL}/v1/profiles/profile_history_other/history`, {
        headers: platform.headers({}, orgId),
      })
    );
    expect(hidden.status).toBe(404);
  }, 20_000);

  test("records a dashboard tool deletion cascade for the affected profile", async () => {
    const { app, databaseAdapter } = createApp();
    const platform = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "history-delete@example.com"
    );
    const orgId = platform.orgId!;
    const profile = (await databaseAdapter.listProfilesForOrg(orgId))[0]!;
    const admin = await databaseAdapter.getUserByEmail(
      "history-delete@example.com"
    );
    const now = new Date().toISOString();
    await databaseAdapter.upsertTool({
      createdAt: now,
      description: "Disposable tool",
      handlerConfig: { modulePath: "disposable.js" },
      handlerType: "javascript",
      id: "tool_history_disposable",
      name: "history_disposable",
      orgId,
      updatedAt: now,
    });
    await databaseAdapter.assignToolToProfile(
      profile.id,
      "tool_history_disposable"
    );

    const deleted = await app.fetch(
      new Request(`${BASE_URL}/v1/tools/tool_history_disposable`, {
        headers: platform.headers(
          { "X-CSRF-Token": platform.csrfToken },
          orgId
        ),
        method: "DELETE",
      })
    );
    expect(deleted.status).toBe(204);

    expect(
      await databaseAdapter.listProfileChangeEvents(orgId, profile.id)
    ).toEqual([
      expect.objectContaining({
        actorUserId: admin!.id,
        field: "tools",
        source: "dashboard",
      }),
    ]);
  }, 20_000);
});
