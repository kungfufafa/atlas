import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { ProfileService } from "../../services/profile-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import { setupFreshInstallSession } from "../test-session-helpers";

setupTestConfigDir("atlas-profiles-knowledge-base-routes-");

const BASE_URL = "http://localhost:4310";

function createApp() {
  const databaseAdapter = createInMemoryDatabaseAdapter();
  const profileService = new ProfileService(databaseAdapter);
  return {
    ...createMinimalHonoApp({
      agent: {
        listProfiles: (orgId: string) => profileService.listProfiles(orgId),
        uploadKnowledgeBaseDocument: (
          orgId: string,
          profileId: string,
          document: Parameters<
            ProfileService["uploadKnowledgeBaseDocument"]
          >[2],
          onDuplicate: Parameters<
            ProfileService["uploadKnowledgeBaseDocument"]
          >[3]
        ) =>
          profileService.uploadKnowledgeBaseDocument(
            orgId,
            profileId,
            document,
            onDuplicate
          ),
      },
      databaseAdapter,
    }),
    databaseAdapter,
  };
}

describe("profile knowledge base routes", () => {
  test("returns structured duplicate details", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "knowledge-duplicate@example.com"
    );
    const orgId = session.orgId!;
    const profile = (await databaseAdapter.listProfilesForOrg(orgId))[0]!;
    const document = {
      data: Buffer.from("same content", "utf8").toString("base64"),
      filename: "existing-guide.md",
      mediaType: "text/markdown",
    };
    const request = (onDuplicate?: "replace" | "skip") =>
      new Request(`${BASE_URL}/v1/profiles/${profile.id}/knowledge-base`, {
        body: JSON.stringify({
          document,
          ...(onDuplicate ? { onDuplicate } : {}),
        }),
        headers: session.headers(
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrfToken,
          },
          orgId
        ),
        method: "POST",
      });

    expect((await app.fetch(request())).status).toBe(201);
    const duplicate = await app.fetch(request());

    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      duplicate: {
        existingDocumentId: expect.stringContaining("kb_"),
        existingFilename: "existing-guide.md",
        match: "content_hash",
      },
      error: expect.any(String),
    });

    const skipped = await app.fetch(request("skip"));
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toMatchObject({ outcome: "skipped" });

    const replaced = await app.fetch(request("replace"));
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ outcome: "replaced" });
  });

  test("documents upload OpenAPI includes success and conflict outcomes", async () => {
    const { app } = createApp();
    const response = await app.fetch(new Request(`${BASE_URL}/openapi.json`));
    expect(response.status).toBe(200);
    const spec = (await response.json()) as {
      paths?: Record<
        string,
        { post?: { responses?: Record<string, unknown> } }
      >;
    };
    const responses =
      spec.paths?.["/v1/profiles/{profileId}/knowledge-base"]?.post?.responses;

    expect(responses).toHaveProperty("200");
    expect(responses).toHaveProperty("201");
    expect(responses).toHaveProperty("409");
  });
});
