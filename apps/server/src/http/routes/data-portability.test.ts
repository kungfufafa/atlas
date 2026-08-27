import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getUserConfigDir } from "@atlas/core";
import { previewAtlasDataImport } from "../../services/data-portability";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import {
  browserSessionFromResponse,
  loginPlatformAdminSession,
} from "../test-session-helpers";

setupTestConfigDir("atlas-data-portability-routes-test-");

function createApp() {
  return createMinimalHonoApp({
    agent: {
      listProfiles: async () => ({ profiles: [{ id: "default" }] }),
      providerConfigured: true,
    },
  });
}

describe("data portability routes", () => {
  test("platform admin can download a Atlas export ZIP", async () => {
    const { app, authService, databaseAdapter } = createApp();
    const session = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter
    );
    await writeFile(join(getUserConfigDir(), "config.ini"), "provider=openai");

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/platform/data/export", {
        headers: session.headers(),
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain(
      "atlas-export-"
    );

    const preview = await previewAtlasDataImport(
      Buffer.from(await response.arrayBuffer())
    );
    expect(preview.manifest.kind).toBe("atlas-export");
    expect(preview.topLevelPaths).toContain("config.ini");
  });

  test("platform admin can preview import without mutating local data", async () => {
    const { app, authService, databaseAdapter } = createApp();
    const session = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter
    );
    await writeFile(join(getUserConfigDir(), "config.ini"), "original");

    const exportResponse = await app.fetch(
      new Request("http://localhost:4310/v1/platform/data/export", {
        headers: session.headers(),
      })
    );
    const archive = Buffer.from(await exportResponse.arrayBuffer());
    await writeFile(join(getUserConfigDir(), "config.ini"), "changed");

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/platform/data/import/preview", {
        body: JSON.stringify({ data: archive.toString("base64") }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      archiveFileCount: 1,
      willReplaceRoot: true,
    });
    await expect(
      readFile(join(getUserConfigDir(), "config.ini"), "utf8")
    ).resolves.toBe("changed");
  });

  test("platform admin can restore import only with confirmation", async () => {
    const { app, authService, databaseAdapter } = createApp();
    const session = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter
    );
    await writeFile(join(getUserConfigDir(), "config.ini"), "original");
    const exportResponse = await app.fetch(
      new Request("http://localhost:4310/v1/platform/data/export", {
        headers: session.headers(),
      })
    );
    const archive = Buffer.from(await exportResponse.arrayBuffer());
    await writeFile(join(getUserConfigDir(), "config.ini"), "changed");

    const rejected = await app.fetch(
      new Request("http://localhost:4310/v1/platform/data/import/restore", {
        body: JSON.stringify({
          confirm: false,
          data: archive.toString("base64"),
        }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );
    expect(rejected.status).toBe(400);

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/platform/data/import/restore", {
        body: JSON.stringify({
          confirm: true,
          data: archive.toString("base64"),
        }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      restoredFileCount: 1,
    });
    await expect(
      readFile(join(getUserConfigDir(), "config.ini"), "utf8")
    ).resolves.toBe("original");
  });

  test("non-platform users cannot export or import data", async () => {
    const { app, authService, databaseAdapter } = createApp();
    const platformSession = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter
    );
    const createResponse = await app.fetch(
      new Request("http://localhost:4310/v1/platform/orgs", {
        body: JSON.stringify({
          admin: {
            email: "admin@acme.test",
            name: "Acme Admin",
            phone: "+628123456789",
          },
          name: "Acme",
          slug: "acme",
        }),
        headers: platformSession.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": platformSession.csrfToken,
        }),
        method: "POST",
      })
    );
    const created = (await createResponse.json()) as {
      organization: { id: string };
      adminMember: { temporaryPassword: string };
    };
    const loginResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/login", {
        body: JSON.stringify({
          email: "admin@acme.test",
          password: created.adminMember.temporaryPassword,
        }),
        method: "POST",
      })
    );
    const orgSession = browserSessionFromResponse(
      loginResponse,
      created.organization.id
    );

    const exportResponse = await app.fetch(
      new Request("http://localhost:4310/v1/platform/data/export", {
        headers: orgSession.headers(),
      })
    );
    const previewResponse = await app.fetch(
      new Request("http://localhost:4310/v1/platform/data/import/preview", {
        body: JSON.stringify({ data: Buffer.from("bad").toString("base64") }),
        headers: orgSession.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": orgSession.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(exportResponse.status).toBe(403);
    expect(previewResponse.status).toBe(403);
  });

  test("invalid import archive is rejected and preserves current files", async () => {
    const { app, authService, databaseAdapter } = createApp();
    const session = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter
    );
    await mkdir(getUserConfigDir(), { recursive: true });
    await writeFile(join(getUserConfigDir(), "config.ini"), "keep");

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/platform/data/import/preview", {
        body: JSON.stringify({
          data: Buffer.from("not a zip").toString("base64"),
        }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid ZIP archive.",
    });
    await expect(
      readFile(join(getUserConfigDir(), "config.ini"), "utf8")
    ).resolves.toBe("keep");
  });

  test("maps archive resource limits to 413", async () => {
    const { app, authService, databaseAdapter } = createApp();
    const session = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter
    );
    const archive = buildZipWithEntry(
      "oversized.bin",
      "small",
      128 * 1024 * 1024 + 1
    );

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/platform/data/import/preview", {
        body: JSON.stringify({ data: archive.toString("base64") }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Import archive entry exceeds the 128 MiB limit: oversized.bin",
    });
  });

  test("sanitizes unexpected import failures as 500", async () => {
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const { app, authService, databaseAdapter } = createApp();
    const session = await loginPlatformAdminSession(
      app,
      authService,
      databaseAdapter
    );
    const loopPath = join(getUserConfigDir(), "credential-loop");
    await writeFile(join(getUserConfigDir(), "config.ini"), "safe");
    const archive = await app.fetch(
      new Request("http://localhost:4310/v1/platform/data/export", {
        headers: session.headers(),
      })
    );
    const archiveData = Buffer.from(await archive.arrayBuffer());
    await symlink("credential-loop", loopPath);
    process.env.CLAUDE_CONFIG_DIR = loopPath;

    try {
      const response = await app.fetch(
        new Request("http://localhost:4310/v1/platform/data/import/preview", {
          body: JSON.stringify({ data: archiveData.toString("base64") }),
          headers: session.headers({
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrfToken,
          }),
          method: "POST",
        })
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "Data import failed.",
      });
    } finally {
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
      await rm(loopPath, { force: true });
    }
  });
});

function buildZipWithEntry(
  name: string,
  content: string,
  originalSize = Buffer.byteLength(content)
): Buffer {
  const safe = Buffer.from(content, "utf8");
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04_03_4b_50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x08_00, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt32LE(safe.length, 18);
  localHeader.writeUInt32LE(originalSize, 22);
  localHeader.writeUInt16LE(Buffer.byteLength(name), 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x08_00, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt32LE(safe.length, 20);
  centralHeader.writeUInt32LE(originalSize, 24);
  centralHeader.writeUInt16LE(Buffer.byteLength(name), 28);

  const centralOffset =
    localHeader.length + Buffer.byteLength(name) + safe.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralHeader.length + Buffer.byteLength(name), 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([
    localHeader,
    Buffer.from(name),
    safe,
    centralHeader,
    Buffer.from(name),
    end,
  ]);
}
