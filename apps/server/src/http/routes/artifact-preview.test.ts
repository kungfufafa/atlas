import { describe, expect, test } from "bun:test";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import {
  loginPlatformAdminSession,
  loginUserSession,
  seedOrgAdmin,
  setupFreshInstallSession,
} from "../test-session-helpers";

setupTestConfigDir("atlas-artifact-preview-routes-test-");

function createApp() {
  const agent = {
    getPreviewJob: (jobId: string) => {
      if (jobId === "job_existing") {
        return {
          artifactId: "deck.pdf",
          createdAt: new Date().toISOString(),
          id: "job_existing",
          previewerVersion: "v1.1",
          revision: 1,
          status: "completed" as const,
        };
      }
    },
    getProfileArtifactDerivedPdf: async (
      _orgId: string,
      _profileId: string,
      filename: string
    ) => {
      if (filename === "notfound.pdf") {
        throw new Error("Artifact not found: notfound.pdf");
      }
      return {
        bytes: Buffer.from(
          "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n",
          "utf8"
        ),
        pageCount: 2,
      };
    },
    getProfileArtifactManifest: async (
      _orgId: string,
      profileId: string,
      filename: string
    ) => {
      if (filename === "notfound.pdf") {
        throw new Error("Artifact not found: notfound.pdf");
      }
      return {
        artifactId: filename,
        assets: [
          {
            id: "asset_1",
            kind: "original" as const,
            mimeType: "application/pdf",
            url: `/v1/profiles/${profileId}/artifacts/content?path=${filename}`,
          },
        ],
        contentHash: "hash123",
        metadata: { pageCount: 3 },
        previewerVersion: "v1.1",
        renderer: "pdf" as const,
        revision: 1,
        sourceMimeType: "application/pdf",
        status: "available" as const,
        strategy: "native" as const,
        type: "pdf" as const,
      };
    },
    getProfileArtifactPreview: async (
      _orgId: string,
      profileId: string,
      filename: string,
      options: { sheet?: string; range?: string } = {}
    ) => {
      if (filename === "notfound.pdf") {
        throw new Error("Artifact not found: notfound.pdf");
      }
      if (filename.endsWith(".xlsx")) {
        return {
          activeSheet: {
            columnCount: 2,
            data: [
              ["Item", "Amount"],
              ["Revenue", 1000],
            ],
            name: options.sheet || "Summary",
            rowCount: 2,
          },
          activeSheetIndex: 0,
          downloadUrl: `/v1/profiles/${profileId}/artifacts/content?path=${filename}`,
          filename,
          generatedAt: new Date().toISOString(),
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          previewVersion: 1,
          sheetNames: ["Summary", "Details"],
          sizeBytes: 1024,
          status: "available",
          totalSheets: 2,
          type: "spreadsheet",
        };
      }
      if (filename.endsWith(".pdf")) {
        return {
          downloadUrl: `/v1/profiles/${profileId}/artifacts/content?path=${filename}`,
          filename,
          generatedAt: new Date().toISOString(),
          mimeType: "application/pdf",
          pageCount: 3,
          previewUrl: `/v1/profiles/${profileId}/artifacts/content?path=${filename}&inline=1`,
          previewVersion: 1,
          sizeBytes: 2048,
          status: "available",
          type: "pdf",
        };
      }
      return {
        downloadUrl: `/v1/profiles/${profileId}/artifacts/content?path=${filename}`,
        filename,
        generatedAt: new Date().toISOString(),
        mimeType: "text/plain",
        previewVersion: 1,
        sizeBytes: 100,
        status: "available",
        type: "text",
      };
    },
    inspectProfileArtifactPreview: async (
      _orgId: string,
      _profileId: string,
      filename: string
    ) => {
      if (filename.endsWith(".xlsx")) {
        return {
          metadata: { rowCount: 2, sheetCount: 2 },
          status: "available",
          summary: "Excel Workbook · 2 sheets · 2 rows",
          type: "spreadsheet",
        };
      }
      return {
        metadata: { pageCount: 3 },
        status: "available",
        summary: "3 pages",
        type: "pdf",
      };
    },
    readProfileArtifact: async (
      _orgId: string,
      _profileId: string,
      filename: string
    ) => {
      if (filename === "notfound.pdf") {
        throw new Error("Artifact not found: notfound.pdf");
      }
      return {
        bytes: Buffer.from("test artifact content", "utf8"),
        contentType: "text/plain",
        filePath: `/tmp/${filename}`,
      };
    },
  };

  return createMinimalHonoApp({ agent });
}

async function createOrgAdminSession(
  app: ReturnType<typeof createApp>["app"],
  authService: any,
  databaseAdapter: any,
  slug: string,
  email: string
) {
  const platformSession = await loginPlatformAdminSession(
    app,
    authService,
    databaseAdapter
  );

  const createResponse = await app.fetch(
    new Request("http://localhost:4310/v1/platform/orgs", {
      body: JSON.stringify({
        admin: {
          email,
          name: "Acme Admin",
          phone: "+628123456789",
        },
        name: "Acme",
        slug,
      }),
      headers: platformSession.headers({
        "Content-Type": "application/json",
        "X-CSRF-Token": platformSession.csrfToken,
      }),
      method: "POST",
    })
  );

  expect(createResponse.status).toBe(201);
  const created = (await createResponse.json()) as {
    organization: { id: string };
    adminMember: { temporaryPassword: string };
  };

  return {
    adminSession: await loginUserSession(
      app,
      email,
      created.adminMember.temporaryPassword,
      created.organization.id
    ),
    orgId: created.organization.id,
  };
}

describe("artifact preview routes", () => {
  test("member can fetch preview descriptor for an artifact", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);

    const response = await app.fetch(
      new Request(
        "http://localhost:4310/v1/profiles/profile_1/artifacts/preview?path=sales.xlsx",
        {
          headers: session.headers({}, session.orgId),
        }
      )
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.type).toBe("spreadsheet");
    expect(data.sheetNames).toEqual(["Summary", "Details"]);
    expect(data.activeSheet.name).toBe("Summary");
  });

  test("viewer can also fetch preview and download artifact", async () => {
    const { app, databaseAdapter } = createApp();
    const viewerSession = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "viewer@example.com",
      "viewer"
    );

    const previewRes = await app.fetch(
      new Request(
        "http://localhost:4310/v1/profiles/profile_1/artifacts/preview?path=deck.pdf",
        {
          headers: viewerSession.headers({}, viewerSession.orgId),
        }
      )
    );

    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as any;
    expect(preview.type).toBe("pdf");
    expect(preview.pageCount).toBe(3);

    const downloadRes = await app.fetch(
      new Request(
        "http://localhost:4310/v1/profiles/profile_1/artifacts/download?path=deck.pdf",
        {
          headers: viewerSession.headers({}, viewerSession.orgId),
        }
      )
    );

    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("Content-Disposition")).toContain(
      "attachment"
    );
  });

  test("inspect endpoint returns cheap metadata", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);

    const response = await app.fetch(
      new Request(
        "http://localhost:4310/v1/profiles/profile_1/artifacts/inspect?path=sales.xlsx",
        {
          headers: session.headers({}, session.orgId),
        }
      )
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.type).toBe("spreadsheet");
    expect(data.summary).toContain("Excel Workbook");
  });

  test("returns 404 for missing artifact", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);

    const response = await app.fetch(
      new Request(
        "http://localhost:4310/v1/profiles/profile_1/artifacts/preview?path=notfound.pdf",
        {
          headers: session.headers({}, session.orgId),
        }
      )
    );

    expect(response.status).toBe(404);
  });

  test("canonical artifact preview endpoint works with artifactId", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);

    const artifactId = "profile_1:sales.xlsx";
    const response = await app.fetch(
      new Request(
        `http://localhost:4310/v1/artifacts/${encodeURIComponent(artifactId)}/preview`,
        {
          headers: session.headers({}, session.orgId),
        }
      )
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.type).toBe("spreadsheet");
    expect(data.artifactId).toBe(artifactId);
  });

  test("HTTP range streaming on artifact content endpoint returns 206 Partial Content", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);

    const artifactId = "profile_1:deck.pdf";
    const response = await app.fetch(
      new Request(
        `http://localhost:4310/v1/artifacts/${encodeURIComponent(artifactId)}/content`,
        {
          headers: {
            ...session.headers({}, session.orgId),
            Range: "bytes=0-3",
          },
        }
      )
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Range")).toBe("bytes 0-3/21");
    const body = await response.text();
    expect(body.length).toBe(4);
  });

  test("multi-tenant security: cross-org access is rejected", async () => {
    const { app, databaseAdapter } = createApp();

    // Setup Org A
    const sessionA = await setupFreshInstallSession(app, databaseAdapter);

    // Setup Org B
    await seedOrgAdmin(databaseAdapter, {
      email: "adminB@orgb.com",
      orgId: "org_b",
      password: "password123",
      userId: "user_b",
    });
    const sessionB = await loginUserSession(
      app,
      "adminB@orgb.com",
      "password123",
      "org_b"
    );

    // User B attempts to access Org A's artifact preview with Org A header
    const unauthorizedAccess = await app.fetch(
      new Request(
        "http://localhost:4310/v1/profiles/profile_1/artifacts/preview?path=confidential.xlsx",
        {
          headers: sessionB.headers({}, sessionA.orgId),
        }
      )
    );

    // Should be rejected by org guards (404 - no membership in Org A)
    expect(unauthorizedAccess.status).toBe(404);

    // User B attempts canonical route access
    const unauthorizedCanonical = await app.fetch(
      new Request(
        "http://localhost:4310/v1/artifacts/profile_1:confidential.xlsx/preview",
        {
          headers: sessionB.headers({}, sessionA.orgId),
        }
      )
    );
    expect(unauthorizedCanonical.status).toBe(404);
  });

  test("canonical manifest endpoint returns PreviewManifest descriptor", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);

    const artifactId = "profile_1:deck.pdf";
    const response = await app.fetch(
      new Request(
        `http://localhost:4310/v1/artifacts/${encodeURIComponent(artifactId)}/manifest`,
        {
          headers: session.headers({}, session.orgId),
        }
      )
    );

    expect(response.status).toBe(200);
    const manifest = (await response.json()) as any;
    expect(manifest.artifactId).toBe(artifactId);
    expect(manifest.type).toBe("pdf");
    expect(manifest.renderer).toBe("pdf");
    expect(manifest.assets.length).toBeGreaterThanOrEqual(1);
    expect(manifest.contentHash).toBe("hash123");
  });

  test("preview job endpoint returns status for existing job and 404 for unknown job", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);

    const okRes = await app.fetch(
      new Request("http://localhost:4310/v1/artifacts/jobs/job_existing", {
        headers: session.headers({}, session.orgId),
      })
    );
    expect(okRes.status).toBe(200);
    const job = (await okRes.json()) as any;
    expect(job.id).toBe("job_existing");
    expect(job.status).toBe("completed");

    const notFoundRes = await app.fetch(
      new Request("http://localhost:4310/v1/artifacts/jobs/job_unknown", {
        headers: session.headers({}, session.orgId),
      })
    );
    expect(notFoundRes.status).toBe(404);
  });

  test("derived-pdf endpoints return inline PDF stream with byte range support", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);

    // 1. Profile route
    const profileRes = await app.fetch(
      new Request(
        "http://localhost:4310/v1/profiles/profile_1/artifacts/derived-pdf?path=deck.pptx",
        {
          headers: session.headers({}, session.orgId),
        }
      )
    );

    expect(profileRes.status).toBe(200);
    expect(profileRes.headers.get("Content-Type")).toBe("application/pdf");
    expect(profileRes.headers.get("Content-Disposition")).toContain("inline");

    // 2. Canonical route
    const canonicalRes = await app.fetch(
      new Request(
        "http://localhost:4310/v1/artifacts/profile_1:deck.pptx/derived-pdf",
        {
          headers: session.headers({}, session.orgId),
        }
      )
    );

    expect(canonicalRes.status).toBe(200);
    expect(canonicalRes.headers.get("Content-Type")).toBe("application/pdf");
    const bytes = await canonicalRes.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
