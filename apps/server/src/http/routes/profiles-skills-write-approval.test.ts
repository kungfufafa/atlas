import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { ProfileService } from "../../services/profile-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import {
  loginUserSession,
  setupFreshInstallSession,
} from "../test-session-helpers";

setupTestConfigDir("atlas-profiles-skills-write-approval-test-");

function createApp() {
  const databaseAdapter = createInMemoryDatabaseAdapter();
  const profileService = new ProfileService(databaseAdapter);
  return {
    ...createMinimalHonoApp({
      agent: {
        getProfile: (orgId: string, profileId: string) =>
          profileService.getProfile(orgId, profileId),
        updateProfile: (orgId: string, profileId: string, body: unknown) =>
          profileService.updateProfile(
            orgId,
            profileId,
            body as Parameters<ProfileService["updateProfile"]>[2]
          ),
      },
      databaseAdapter,
    }),
    profileService,
  };
}

const BASE = "http://localhost:4310";

describe("org admin profile settings auth", () => {
  test("org admin can read profile details and update operational settings", async () => {
    const { app, databaseAdapter } = createApp();
    const platformSession = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "platform@org.com"
    );
    const orgId = platformSession.orgId!;

    const inviteResp = await app.fetch(
      new Request(`${BASE}/v1/orgs/${orgId}/members`, {
        body: JSON.stringify({
          email: "orgadmin@org.com",
          name: "Org Admin",
          role: "admin",
        }),
        headers: platformSession.headers(
          { "X-CSRF-Token": platformSession.csrfToken },
          orgId
        ),
        method: "POST",
      })
    );
    const invited = (await inviteResp.json()) as { temporaryPassword: string };
    const orgAdminSession = await loginUserSession(
      app,
      "orgadmin@org.com",
      invited.temporaryPassword,
      orgId
    );

    const profileId = (await databaseAdapter.listProfilesForOrg(orgId))[0]!.id;

    const detailResp = await app.fetch(
      new Request(`${BASE}/v1/profiles/${profileId}`, {
        headers: orgAdminSession.headers({}, orgId),
      })
    );
    expect(detailResp.status).toBe(200);

    const modelResp = await app.fetch(
      new Request(`${BASE}/v1/profiles/${profileId}`, {
        body: JSON.stringify({ model: "provider_test:model_test" }),
        headers: orgAdminSession.headers(
          { "X-CSRF-Token": orgAdminSession.csrfToken },
          orgId
        ),
        method: "PUT",
      })
    );
    expect(modelResp.status).toBe(200);
    const modelBody = (await modelResp.json()) as {
      profile: { model: string | null };
    };
    expect(modelBody.profile.model).toBe("provider_test:model_test");

    const okResp = await app.fetch(
      new Request(`${BASE}/v1/profiles/${profileId}`, {
        body: JSON.stringify({ skillsWriteApproval: true }),
        headers: orgAdminSession.headers(
          { "X-CSRF-Token": orgAdminSession.csrfToken },
          orgId
        ),
        method: "PUT",
      })
    );
    expect(okResp.status).toBe(200);
    const okBody = (await okResp.json()) as {
      profile: { skillsWriteApproval: boolean | null };
    };
    expect(okBody.profile.skillsWriteApproval).toBe(true);

    const reviewResp = await app.fetch(
      new Request(`${BASE}/v1/profiles/${profileId}`, {
        body: JSON.stringify({ skillsPostTurnReview: true }),
        headers: orgAdminSession.headers(
          { "X-CSRF-Token": orgAdminSession.csrfToken },
          orgId
        ),
        method: "PUT",
      })
    );
    expect(reviewResp.status).toBe(200);
    const reviewBody = (await reviewResp.json()) as {
      profile: { skillsPostTurnReview: boolean | null };
    };
    expect(reviewBody.profile.skillsPostTurnReview).toBe(true);

    const fullUpdateResp = await app.fetch(
      new Request(`${BASE}/v1/profiles/${profileId}`, {
        body: JSON.stringify({ name: "Renamed", skillsWriteApproval: false }),
        headers: orgAdminSession.headers(
          { "X-CSRF-Token": orgAdminSession.csrfToken },
          orgId
        ),
        method: "PUT",
      })
    );
    expect(fullUpdateResp.status).toBe(200);
    const fullUpdateBody = (await fullUpdateResp.json()) as {
      profile: { name: string; skillsWriteApproval: boolean | null };
    };
    expect(fullUpdateBody.profile).toMatchObject({
      name: "Renamed",
      skillsWriteApproval: false,
    });
  });
});
