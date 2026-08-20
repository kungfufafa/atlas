import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getArtifactSharesDir,
  getProfileArtifactsDir,
  previewService,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter, type DatabaseAdapter } from "@atlas/db";
import { setupTestConfigDir } from "../../test-config-dir";
import { isPublicRouteRequest } from "../public-routes";
import { createMinimalHonoApp } from "../test-app-helpers";
import {
  setupFreshInstallSession,
  type TestBrowserSession,
} from "../test-session-helpers";

setupTestConfigDir("atlas-artifact-shares-test-");

function createApp(databaseAdapter = createInMemoryDatabaseAdapter()) {
  return createMinimalHonoApp({
    agent: {},
    databaseAdapter,
  });
}

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> {
  const previous = new Map(
    Object.keys(vars).map((key) => [key, process.env[key]] as const)
  );
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function seedProfileArtifact(params: {
  content: string | Uint8Array;
  databaseAdapter: DatabaseAdapter;
  filename: string;
  meta?: string;
  name: string;
  orgId: string;
  profileId: string;
}): Promise<string> {
  const now = new Date().toISOString();
  await params.databaseAdapter.upsertProfile({
    createdAt: now,
    id: params.profileId,
    isSuper: false,
    model: "openrouter/auto",
    name: params.name,
    orgId: params.orgId,
    systemPrompt: "test",
    updatedAt: now,
  });

  const artifactsDir = getProfileArtifactsDir(params.orgId, params.profileId);
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(join(artifactsDir, params.filename), params.content);
  if (params.meta !== undefined) {
    await writeFile(
      join(artifactsDir, `${params.filename}.atlas-meta.json`),
      params.meta
    );
  }
  return now;
}

function publishArtifactShareRequest(params: {
  body: Record<string, unknown>;
  host?: string;
  orgId: string;
  profileId: string;
  session: TestBrowserSession;
}): Request {
  return new Request(
    `http://${params.host ?? "localhost"}:4310/v1/profiles/${params.profileId}/artifacts/shares`,
    {
      body: JSON.stringify(params.body),
      headers: params.session.headers(
        {
          "Content-Type": "application/json",
          "X-CSRF-Token": params.session.csrfToken,
        },
        params.orgId
      ),
      method: "POST",
    }
  );
}

describe("artifact share routes", () => {
  test("public artifact share GET is allowlisted", () => {
    expect(
      isPublicRouteRequest("GET", "/v1/public/artifact-shares/abc123")
    ).toBe(true);
    expect(
      isPublicRouteRequest("GET", "/v1/public/artifact-shares/abc123/preview")
    ).toBe(true);
    expect(
      isPublicRouteRequest("POST", "/v1/public/artifact-shares/abc123")
    ).toBe(false);
    expect(
      isPublicRouteRequest("POST", "/v1/public/artifact-shares/abc123/preview")
    ).toBe(false);
  });

  test("member can publish and anonymous visitor can read snapshot", async () => {
    const { app, databaseAdapter, authService } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);
    const orgId = session.orgId!;
    const profileId = "profile_share_test";

    await seedProfileArtifact({
      content: "# Shared report",
      databaseAdapter,
      filename: "report.md",
      name: "Share Test",
      orgId,
      profileId,
    });

    const publishResponse = await app.fetch(
      publishArtifactShareRequest({
        body: { path: "report.md" },
        orgId,
        profileId,
        session,
      })
    );

    expect(publishResponse.status).toBe(201);
    const published = (await publishResponse.json()) as {
      id: string;
      token: string;
    };
    expect(published.token.length).toBeGreaterThan(20);

    const publicResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/public/artifact-shares/${encodeURIComponent(published.token)}`
      )
    );

    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).toBe("# Shared report");

    const revokeResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/profiles/${profileId}/artifacts/shares/${published.id}`,
        {
          headers: session.headers(
            {
              "X-CSRF-Token": session.csrfToken,
            },
            orgId
          ),
          method: "DELETE",
        }
      )
    );

    expect(revokeResponse.status).toBe(200);

    const afterRevoke = await app.fetch(
      new Request(
        `http://localhost:4310/v1/public/artifact-shares/${encodeURIComponent(published.token)}`
      )
    );
    expect(afterRevoke.status).toBe(404);
    void authService;
  });

  test("public video share resolves octet-stream to video/mp4 for inline playback", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);
    const orgId = session.orgId!;
    const profileId = "profile_share_video";
    const now = new Date().toISOString();

    // Minimal bytes; MIME comes from filename when sidecar is missing/generic.
    await seedProfileArtifact({
      content: "fake-mp4-bytes",
      databaseAdapter,
      filename: "clip.mp4",
      meta: JSON.stringify({
        mimeType: "application/octet-stream",
        savedAt: now,
        sizeBytes: 13,
      }),
      name: "Share Video",
      orgId,
      profileId,
    });

    const publishResponse = await app.fetch(
      publishArtifactShareRequest({
        body: { path: "clip.mp4" },
        orgId,
        profileId,
        session,
      })
    );

    expect(publishResponse.status).toBe(201);
    const published = (await publishResponse.json()) as { token: string };

    const metaResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/public/artifact-shares/${encodeURIComponent(published.token)}?meta=1`
      )
    );
    expect(metaResponse.status).toBe(200);
    const meta = (await metaResponse.json()) as {
      mimeType: string;
      inlineAllowed: boolean;
      filename: string;
    };
    expect(meta.filename).toBe("clip.mp4");
    expect(meta.mimeType).toBe("video/mp4");
    expect(meta.inlineAllowed).toBe(true);

    const publicResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/public/artifact-shares/${encodeURIComponent(published.token)}`
      )
    );
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("Content-Type")).toBe("video/mp4");
    expect(publicResponse.headers.get("Content-Disposition")).toContain(
      "inline"
    );
  });

  test("publish prefers clientOrigin over loopback request URL", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);
    const orgId = session.orgId!;
    const profileId = "profile_share_origin";

    await seedProfileArtifact({
      content: "hello",
      databaseAdapter,
      filename: "note.md",
      name: "Share Origin",
      orgId,
      profileId,
    });

    const publishResponse = await app.fetch(
      publishArtifactShareRequest({
        body: {
          clientOrigin: "https://atlas.example.com/",
          path: "note.md",
        },
        host: "127.0.0.1",
        orgId,
        profileId,
        session,
      })
    );

    expect(publishResponse.status).toBe(201);
    const published = (await publishResponse.json()) as {
      shareUrl: string | null;
      webPublicUrlConfigured: boolean;
    };
    expect(published.shareUrl).toMatch(/^https:\/\/atlas\.example\.com\/s\//);
    expect(published.webPublicUrlConfigured).toBe(true);
  });

  test("publish prefers configured web public URL over loopback request URL", async () => {
    await withEnv(
      { ATLAS_WEB_PUBLIC_URL: "https://deployed.example.com/" },
      async () => {
        const { app, databaseAdapter } = createApp();
        const session = await setupFreshInstallSession(app, databaseAdapter);
        const orgId = session.orgId!;
        const profileId = "profile_share_env";

        await seedProfileArtifact({
          content: "hello",
          databaseAdapter,
          filename: "note.md",
          name: "Share Env",
          orgId,
          profileId,
        });

        const publishResponse = await app.fetch(
          publishArtifactShareRequest({
            body: { path: "note.md" },
            host: "127.0.0.1",
            orgId,
            profileId,
            session,
          })
        );

        expect(publishResponse.status).toBe(201);
        const published = (await publishResponse.json()) as {
          shareUrl: string | null;
          webPublicUrlConfigured: boolean;
        };
        expect(published.shareUrl).toMatch(
          /^https:\/\/deployed\.example\.com\/s\//
        );
        expect(published.webPublicUrlConfigured).toBe(true);
      }
    );
  });

  test("download=1 forces attachment even for inline-allowed types", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);
    const orgId = session.orgId!;
    const profileId = "profile_share_download";

    await seedProfileArtifact({
      content: "# Shared report",
      databaseAdapter,
      filename: "report.md",
      name: "Share Download",
      orgId,
      profileId,
    });

    const publishResponse = await app.fetch(
      publishArtifactShareRequest({
        body: { path: "report.md" },
        orgId,
        profileId,
        session,
      })
    );
    expect(publishResponse.status).toBe(201);
    const published = (await publishResponse.json()) as { token: string };

    const inlineResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/public/artifact-shares/${encodeURIComponent(published.token)}`
      )
    );
    expect(inlineResponse.headers.get("Content-Disposition")).toContain(
      "inline"
    );

    const downloadResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/public/artifact-shares/${encodeURIComponent(published.token)}?download=1`
      )
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("Content-Disposition")).toContain(
      "attachment"
    );
    expect(await downloadResponse.text()).toBe("# Shared report");
  });

  test("does not put a live share token on a loopback URL", async () => {
    await withEnv(
      { ATLAS_PUBLIC_URL: undefined, ATLAS_WEB_PUBLIC_URL: undefined },
      async () => {
        const { app, databaseAdapter } = createApp();
        const session = await setupFreshInstallSession(app, databaseAdapter);
        const orgId = session.orgId!;
        const profileId = "profile_share_loopback";

        await seedProfileArtifact({
          content: "hello",
          databaseAdapter,
          filename: "note.md",
          name: "Share Loopback",
          orgId,
          profileId,
        });

        const publishResponse = await app.fetch(
          publishArtifactShareRequest({
            body: { path: "note.md" },
            host: "127.0.0.1",
            orgId,
            profileId,
            session,
          })
        );

        expect(publishResponse.status).toBe(201);
        const published = (await publishResponse.json()) as {
          shareUrl: string | null;
          token: string;
          webPublicUrlConfigured: boolean;
        };
        expect(published.token.length).toBeGreaterThan(20);
        expect(published.shareUrl).toBeNull();
        expect(published.webPublicUrlConfigured).toBe(false);
      }
    );
  });

  test("rejects non-http clientOrigin when building shareUrl", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);
    const orgId = session.orgId!;
    const profileId = "profile_share_js_origin";

    await seedProfileArtifact({
      content: "hello",
      databaseAdapter,
      filename: "note.md",
      name: "Share JS Origin",
      orgId,
      profileId,
    });

    const publishResponse = await app.fetch(
      publishArtifactShareRequest({
        body: {
          clientOrigin: "javascript:alert(1)",
          path: "note.md",
        },
        host: "127.0.0.1",
        orgId,
        profileId,
        session,
      })
    );

    expect(publishResponse.status).toBe(201);
    const published = (await publishResponse.json()) as {
      shareUrl: string | null;
    };
    expect(published.shareUrl).toBeNull();
  });

  test("serves javascript shares as attachment, not inline", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);
    const orgId = session.orgId!;
    const profileId = "profile_share_js";

    await seedProfileArtifact({
      content: "alert(1)",
      databaseAdapter,
      filename: "payload.js",
      name: "Share JS",
      orgId,
      profileId,
    });

    const publishResponse = await app.fetch(
      publishArtifactShareRequest({
        body: { path: "payload.js" },
        orgId,
        profileId,
        session,
      })
    );
    expect(publishResponse.status).toBe(201);
    const published = (await publishResponse.json()) as { token: string };

    const publicResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/public/artifact-shares/${encodeURIComponent(published.token)}`
      )
    );
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("Content-Disposition")).toContain(
      "attachment"
    );
    expect(publicResponse.headers.get("Content-Type")).not.toContain(
      "javascript"
    );
  });

  test("missing snapshot returns 404 without leaking storage paths", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);
    const orgId = session.orgId!;
    const profileId = "profile_share_missing";

    await seedProfileArtifact({
      content: "hello",
      databaseAdapter,
      filename: "note.md",
      name: "Share Missing",
      orgId,
      profileId,
    });

    const publishResponse = await app.fetch(
      publishArtifactShareRequest({
        body: { path: "note.md" },
        orgId,
        profileId,
        session,
      })
    );
    expect(publishResponse.status).toBe(201);
    const published = (await publishResponse.json()) as {
      id: string;
      token: string;
    };

    await rm(join(getArtifactSharesDir(orgId), published.id), {
      force: true,
      recursive: true,
    });

    const publicResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/public/artifact-shares/${encodeURIComponent(published.token)}`
      )
    );
    expect(publicResponse.status).toBe(404);
    const body = await publicResponse.text();
    expect(body).toContain("Not found");
    expect(body).not.toContain("artifact-shares");
    expect(body).not.toContain(orgId);
  });

  test("CR/LF in artifact filename does not break public Content-Disposition", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);
    const orgId = session.orgId!;
    const profileId = "profile_share_crlf";
    const filename = "evil\r\nname.md";

    await seedProfileArtifact({
      content: "hello",
      databaseAdapter,
      filename,
      name: "Share CRLF",
      orgId,
      profileId,
    });

    const publishResponse = await app.fetch(
      publishArtifactShareRequest({
        body: { path: filename },
        orgId,
        profileId,
        session,
      })
    );
    expect(publishResponse.status).toBe(201);
    const published = (await publishResponse.json()) as { token: string };

    const publicResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/public/artifact-shares/${encodeURIComponent(published.token)}`
      )
    );
    expect(publicResponse.status).toBe(200);
    const disposition = publicResponse.headers.get("Content-Disposition") ?? "";
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
  });

  test("public spreadsheet share exposes a grid preview without leaking workspace paths", async () => {
    const requireFromCore = createRequire(
      fileURLToPath(
        new URL("../../../../../packages/core/package.json", import.meta.url)
      )
    );
    const ExcelJS = requireFromCore("exceljs");
    const workbook = new ExcelJS.Workbook();
    const clients = workbook.addWorksheet("Clients");
    clients.addRow(["Name", "City"]);
    clients.addRow(["OceanSpace", "Jakarta"]);
    const details = workbook.addWorksheet("Details");
    details.addRow(["ID", "Note"]);
    details.addRow([1, "Primary client"]);
    const xlsxBytes = Buffer.from(await workbook.xlsx.writeBuffer());

    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);
    const orgId = session.orgId!;
    const profileId = "profile_share_xlsx";

    await seedProfileArtifact({
      content: xlsxBytes,
      databaseAdapter,
      filename: "OceanSpace_Data_Klien.xlsx",
      name: "Share Xlsx",
      orgId,
      profileId,
    });

    const publishResponse = await app.fetch(
      publishArtifactShareRequest({
        body: { path: "OceanSpace_Data_Klien.xlsx" },
        orgId,
        profileId,
        session,
      })
    );
    expect(publishResponse.status).toBe(201);
    const published = (await publishResponse.json()) as { token: string };

    const previewResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/public/artifact-shares/${encodeURIComponent(published.token)}/preview`
      )
    );
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as {
      type: string;
      sheetNames: string[];
      activeSheet: { data: unknown[][] };
      downloadUrl: string;
      artifactId?: string;
    };
    expect(preview.type).toBe("spreadsheet");
    expect(preview.sheetNames).toEqual(["Clients", "Details"]);
    expect(preview.activeSheet.data[1]?.[0]).toBe("OceanSpace");
    expect(preview.downloadUrl).toBe(
      `/v1/public/artifact-shares/${published.token}`
    );
    expect(preview.artifactId).toBeUndefined();
    const body = JSON.stringify(preview);
    expect(body).not.toContain("/v1/profiles/");
    expect(body).not.toContain(orgId);
    expect(body).not.toContain(profileId);

    const sheetResponse = await app.fetch(
      new Request(
        `http://localhost:4310/v1/public/artifact-shares/${encodeURIComponent(published.token)}/preview?sheet=Details`
      )
    );
    expect(sheetResponse.status).toBe(200);
    const sheetPreview = (await sheetResponse.json()) as {
      activeSheet: { name: string; data: unknown[][] };
    };
    expect(sheetPreview.activeSheet.name).toBe("Details");
    expect(sheetPreview.activeSheet.data[1]?.[1]).toBe("Primary client");
  });

  test("public preview 500 does not leak internal error details", async () => {
    const generateSpy = spyOn(previewService, "generate").mockRejectedValue(
      new Error(
        "Office conversion worker timed out after 25000ms. /secret/path"
      )
    );
    const errorSpy = spyOn(console, "error").mockImplementation(
      () => undefined
    );

    try {
      const requireFromCore = createRequire(
        fileURLToPath(
          new URL("../../../../../packages/core/package.json", import.meta.url)
        )
      );
      const ExcelJS = requireFromCore("exceljs");
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet("Clients").addRow(["Name"]);
      const xlsxBytes = Buffer.from(await workbook.xlsx.writeBuffer());

      const { app, databaseAdapter } = createApp();
      const session = await setupFreshInstallSession(app, databaseAdapter);
      const orgId = session.orgId!;
      const profileId = "profile_share_preview_500";

      await seedProfileArtifact({
        content: xlsxBytes,
        databaseAdapter,
        filename: "clients.xlsx",
        name: "Share Preview 500",
        orgId,
        profileId,
      });

      const publishResponse = await app.fetch(
        publishArtifactShareRequest({
          body: { path: "clients.xlsx" },
          orgId,
          profileId,
          session,
        })
      );
      expect(publishResponse.status).toBe(201);
      const published = (await publishResponse.json()) as { token: string };

      const previewResponse = await app.fetch(
        new Request(
          `http://localhost:4310/v1/public/artifact-shares/${encodeURIComponent(published.token)}/preview`
        )
      );
      expect(previewResponse.status).toBe(500);
      const body = await previewResponse.text();
      expect(body).toContain("Failed to load preview");
      expect(body).not.toContain("25000");
      expect(body).not.toContain("/secret/path");
    } finally {
      generateSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
