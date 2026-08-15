import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { ProfileService } from "../../services/profile-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import {
  loginUserSession,
  setupFreshInstallSession,
} from "../test-session-helpers";

setupTestConfigDir("atlas-profiles-clone-routes-");

const BASE = "http://localhost:4310";

function createApp() {
  const databaseAdapter = createInMemoryDatabaseAdapter();
  const profileService = new ProfileService(databaseAdapter);
  return {
    ...createMinimalHonoApp({
      agent: {
        cloneProfile: (orgId: string, sourceId: string, request: unknown) =>
          profileService.cloneProfile(
            orgId,
            sourceId,
            request as { id?: string; name?: string }
          ),
        listProfiles: async () => ({ profiles: [] }),
      },
      databaseAdapter,
    }),
    databaseAdapter,
  };
}

describe("POST /v1/profiles/:profileId/clone", () => {
  test("a member (non-admin) gets 403", async () => {
    const { app, authService, databaseAdapter } = createApp();
    const platformSession = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "platform@example.com"
    );
    const orgId = platformSession.orgId!;
    const [source] = await databaseAdapter.listProfilesForOrg(orgId);
    const now = new Date().toISOString();

    await databaseAdapter.createUser({
      createdAt: now,
      email: "org-member-clone@example.com",
      id: "user_org_member_clone",
      passwordHash: await authService.hashPassword("password123"),
      updatedAt: now,
    });
    await databaseAdapter.upsertOrgMember({
      createdAt: now,
      orgId,
      role: "member",
      userId: "user_org_member_clone",
    });

    const countBefore = (await databaseAdapter.listProfilesForOrg(orgId))
      .length;

    const orgMember = await loginUserSession(
      app,
      "org-member-clone@example.com",
      "password123",
      orgId
    );

    const denied = await app.fetch(
      new Request(`${BASE}/v1/profiles/${source!.id}/clone`, {
        body: "{}",
        headers: orgMember.headers(
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": orgMember.csrfToken,
          },
          orgId
        ),
        method: "POST",
      })
    );

    expect(denied.status).toBe(403);
    expect(await databaseAdapter.listProfilesForOrg(orgId)).toHaveLength(
      countBefore
    );
  }, 20_000);

  test("an org admin or platform admin gets 201 and a new profile", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "platform2@example.com"
    );
    const orgId = session.orgId!;
    const before = await databaseAdapter.listProfilesForOrg(orgId);
    const source = before.find((profile) => !profile.isSuper);

    const response = await app.fetch(
      new Request(`${BASE}/v1/profiles/${source!.id}/clone`, {
        body: "{}",
        headers: session.headers(
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrfToken,
          },
          orgId
        ),
        method: "POST",
      })
    );

    expect(response.status).toBe(201);
    expect(await databaseAdapter.listProfilesForOrg(orgId)).toHaveLength(
      before.length + 1
    );
  }, 20_000);
});
