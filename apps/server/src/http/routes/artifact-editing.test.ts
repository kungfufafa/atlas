import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProfileArtifactsDir } from "@atlas/core";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import {
  loginUserSession,
  seedOrgAdmin,
  type TestBrowserSession,
} from "../test-session-helpers";

setupTestConfigDir("atlas-artifact-editing-routes-");

function createApp() {
  const profileReads: Array<{ orgId: string; profileId: string }> = [];
  const agent = {
    getProfile: async (orgId: string, profileId: string) => {
      profileReads.push({ orgId, profileId });
      return { profile: { id: profileId, orgId } };
    },
    listProfiles: async () => ({ profiles: [{ id: "default" }] }),
  };
  return {
    ...createMinimalHonoApp({ agent }),
    profileReads,
  };
}

async function seedArtifact(
  orgId: string,
  profileId: string,
  filename: string,
  content: string
): Promise<string> {
  const filePath = path.join(
    getProfileArtifactsDir(orgId, profileId),
    filename
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return filePath;
}

async function createRoleSession(
  testApp: ReturnType<typeof createApp>,
  role: "admin" | "member" | "viewer",
  suffix: string
): Promise<TestBrowserSession> {
  const orgId = `org_artifact_edit_${suffix}`;
  const email = `${role}-${suffix}@example.com`;
  const seeded = await seedOrgAdmin(testApp.databaseAdapter, {
    authService: testApp.authService,
    email,
    orgId,
    userId: `user_artifact_edit_${suffix}`,
  });
  if (role !== "admin") {
    await testApp.databaseAdapter.upsertOrgMember({
      createdAt: new Date().toISOString(),
      orgId,
      role,
      userId: seeded.userId,
    });
  }
  return loginUserSession(testApp.app, email, seeded.password, orgId);
}

describe("editable artifact routes", () => {
  test("lets a workspace admin read and hash-guard a nested Markdown save", async () => {
    const testApp = createApp();
    const { app, profileReads } = testApp;
    const session = await createRoleSession(testApp, "admin", "save");
    const orgId = session.orgId!;
    await seedArtifact(orgId, "profile_1", "reports/weekly.md", "# Draft\n");
    const url =
      "http://localhost:4310/v1/profiles/profile_1/artifacts/editable?path=reports%2Fweekly.md";

    const readResponse = await app.fetch(
      new Request(url, { headers: session.headers({}, orgId) })
    );
    expect(readResponse.status).toBe(200);
    const editable = (await readResponse.json()) as {
      content: string;
      expectedHash: string;
    };
    expect(editable.content).toBe("# Draft\n");

    const saveResponse = await app.fetch(
      new Request(url, {
        body: JSON.stringify({
          content: "# Published\n",
          expectedHash: editable.expectedHash,
        }),
        headers: session.headers(
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrfToken,
          },
          orgId
        ),
        method: "PUT",
      })
    );

    expect(saveResponse.status).toBe(200);
    expect(await saveResponse.json()).toMatchObject({
      content: "# Published\n",
      editable: true,
      path: "reports/weekly.md",
    });
    expect(profileReads).toEqual([
      { orgId, profileId: "profile_1" },
      { orgId, profileId: "profile_1" },
    ]);
  });

  for (const role of ["member", "viewer"] as const) {
    test(`does not let an org ${role} read or mutate editable source`, async () => {
      const testApp = createApp();
      const { app, profileReads } = testApp;
      const session = await createRoleSession(testApp, role, role);
      const orgId = session.orgId!;
      await seedArtifact(orgId, "profile_1", "report.md", "# Private\n");
      const url =
        "http://localhost:4310/v1/profiles/profile_1/artifacts/editable?path=report.md";

      const readResponse = await app.fetch(
        new Request(url, { headers: session.headers({}, orgId) })
      );
      const saveResponse = await app.fetch(
        new Request(url, {
          body: JSON.stringify({
            content: "# Overwritten\n",
            expectedHash: "a".repeat(64),
          }),
          headers: session.headers(
            {
              "Content-Type": "application/json",
              "X-CSRF-Token": session.csrfToken,
            },
            orgId
          ),
          method: "PUT",
        })
      );

      expect(readResponse.status).toBe(403);
      expect(saveResponse.status).toBe(403);
      expect(profileReads).toEqual([]);
    });
  }

  test("rejects another tenant before resolving its artifact path", async () => {
    const testApp = createApp();
    const { app, databaseAdapter, profileReads } = testApp;
    const session = await createRoleSession(testApp, "admin", "tenant");
    const ownOrgId = session.orgId!;
    const foreignOrgId = "org_foreign_artifacts";
    const now = new Date().toISOString();
    await databaseAdapter.upsertOrganization({
      createdAt: now,
      id: foreignOrgId,
      name: "Foreign",
      slug: "foreign-artifacts",
      updatedAt: now,
    });
    await seedArtifact(
      foreignOrgId,
      "profile_1",
      "report.md",
      "# Foreign secret\n"
    );

    const response = await app.fetch(
      new Request(
        "http://localhost:4310/v1/profiles/profile_1/artifacts/editable?path=report.md",
        { headers: session.headers({}, foreignOrgId) }
      )
    );

    expect([403, 404]).toContain(response.status);
    expect(profileReads).toEqual([]);
    expect(ownOrgId).not.toBe(foreignOrgId);
  });

  test("returns 409 for a stale save without overwriting the newer file", async () => {
    const testApp = createApp();
    const { app } = testApp;
    const session = await createRoleSession(testApp, "admin", "conflict");
    const orgId = session.orgId!;
    const filePath = await seedArtifact(
      orgId,
      "profile_1",
      "report.md",
      "# First\n"
    );
    const url =
      "http://localhost:4310/v1/profiles/profile_1/artifacts/editable?path=report.md";
    const readResponse = await app.fetch(
      new Request(url, { headers: session.headers({}, orgId) })
    );
    const editable = (await readResponse.json()) as { expectedHash: string };
    await writeFile(filePath, "# Newer\n", "utf8");

    const response = await app.fetch(
      new Request(url, {
        body: JSON.stringify({
          content: "# Stale\n",
          expectedHash: editable.expectedHash,
        }),
        headers: session.headers(
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrfToken,
          },
          orgId
        ),
        method: "PUT",
      })
    );

    expect(response.status).toBe(409);
    expect(await Bun.file(filePath).text()).toBe("# Newer\n");
  });

  test("rejects traversal and symbolic-link targets", async () => {
    const testApp = createApp();
    const { app } = testApp;
    const session = await createRoleSession(testApp, "admin", "paths");
    const orgId = session.orgId!;
    const outside = path.join(process.env.ATLAS_CONFIG_DIR!, "outside.md");
    await writeFile(outside, "# Outside\n", "utf8");
    const artifactsDir = getProfileArtifactsDir(orgId, "profile_1");
    await mkdir(artifactsDir, { recursive: true });
    await symlink(outside, path.join(artifactsDir, "linked.md"));

    const traversal = await app.fetch(
      new Request(
        "http://localhost:4310/v1/profiles/profile_1/artifacts/editable?path=..%2Foutside.md",
        { headers: session.headers({}, orgId) }
      )
    );
    const linked = await app.fetch(
      new Request(
        "http://localhost:4310/v1/profiles/profile_1/artifacts/editable?path=linked.md",
        { headers: session.headers({}, orgId) }
      )
    );

    expect(traversal.status).toBe(400);
    expect(linked.status).toBe(400);
  });

  test("keeps an existing public share as an immutable snapshot", async () => {
    const testApp = createApp();
    const { app, databaseAdapter } = testApp;
    const session = await createRoleSession(testApp, "admin", "snapshot");
    const orgId = session.orgId!;
    const profileId = "profile_snapshot";
    const now = new Date().toISOString();
    await databaseAdapter.upsertProfile({
      createdAt: now,
      id: profileId,
      isSuper: false,
      model: "openrouter/auto",
      name: "Snapshot",
      orgId,
      systemPrompt: "test",
      updatedAt: now,
    });
    await seedArtifact(orgId, profileId, "report.md", "# Published\n");

    const publishResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/profiles/${profileId}/artifacts/shares`,
        {
          body: JSON.stringify({ path: "report.md" }),
          headers: session.headers(
            {
              "Content-Type": "application/json",
              "X-CSRF-Token": session.csrfToken,
            },
            orgId
          ),
          method: "POST",
        }
      )
    );
    expect(publishResponse.status).toBe(201);
    const { token } = (await publishResponse.json()) as { token: string };

    const editUrl = `http://localhost:4310/v1/profiles/${profileId}/artifacts/editable?path=report.md`;
    const editableResponse = await app.fetch(
      new Request(editUrl, { headers: session.headers({}, orgId) })
    );
    const editable = (await editableResponse.json()) as {
      expectedHash: string;
    };
    const saveResponse = await app.fetch(
      new Request(editUrl, {
        body: JSON.stringify({
          content: "# Edited\n",
          expectedHash: editable.expectedHash,
        }),
        headers: session.headers(
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrfToken,
          },
          orgId
        ),
        method: "PUT",
      })
    );
    expect(saveResponse.status).toBe(200);

    const publicResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/public/artifact-shares/${encodeURIComponent(token)}`
      )
    );
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).toBe("# Published\n");
  });
});
