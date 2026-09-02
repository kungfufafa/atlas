import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getCustomToolsDir,
  getProfileSoulDir,
  initSoulDirectory,
  type ProfilePackManifest,
} from "@atlas/core";
import { unzipSync, zipSync } from "fflate";
import { PROFILE_PACK_MANIFEST_FILENAME } from "../../services/profile-portability";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import { loginUserSession, seedOrgAdmin } from "../test-session-helpers";
import {
  PROFILE_PACK_BODY_RETRY_AFTER_SECONDS,
  PROFILE_PACK_MAX_ACTIVE_BODY_READS,
  PROFILE_PACK_MAX_HTTP_BODY_BYTES,
} from "./profile-portability-body";

setupTestConfigDir("atlas-profile-pack-routes-test-");

function createApp(
  getModels: () => Promise<{ models: never[] }> = async () => ({ models: [] })
) {
  return createMinimalHonoApp({
    agent: {
      getModels,
      listProfiles: async () => ({ profiles: [{ id: "portable" }] }),
    },
  });
}

async function setupProfileRouteTest(
  getModels?: () => Promise<{ models: never[] }>
) {
  const result = createApp(getModels);
  const seeded = await seedOrgAdmin(result.databaseAdapter, {
    authService: result.authService,
    profileId: "portable",
  });
  const soulDir = getProfileSoulDir(seeded.orgId, "portable");
  await initSoulDirectory(soulDir);
  await writeFile(join(soulDir, "SOUL.md"), "# Portable\n");
  const session = await loginUserSession(
    result.app,
    seeded.email,
    seeded.password,
    seeded.orgId
  );
  return { ...result, seeded, session };
}

function createHeldBody(payload: string): {
  release: () => void;
  started: Promise<void>;
  stream: ReadableStream<Uint8Array>;
} {
  const bytes = new TextEncoder().encode(payload);
  let release = () => {};
  let resolveStarted = () => {};
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        resolveStarted();
        return new Promise<void>((resolve) => {
          release = () => {
            controller.enqueue(bytes);
            controller.close();
            resolve();
          };
        });
      },
    },
    { highWaterMark: 0 }
  );

  return {
    release: () => release(),
    started,
    stream,
  };
}

function profilePackPostRequest(
  path: "/v1/profiles/pack/import" | "/v1/profiles/pack/import/preview",
  body: BodyInit,
  session: Awaited<ReturnType<typeof loginUserSession>>,
  headers: Record<string, string> = {}
): Request {
  return new Request(`http://localhost:4310${path}`, {
    body,
    headers: session.headers({
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrfToken,
      ...headers,
    }),
    method: "POST",
  });
}

describe("profile portability routes", () => {
  test("org admin can export, preview, and import in the active organization", async () => {
    const { app, databaseAdapter, seeded, session } =
      await setupProfileRouteTest();
    const exported = await app.fetch(
      new Request("http://localhost:4310/v1/profiles/portable/pack/export", {
        headers: session.headers(),
      })
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("cache-control")).toBe("no-store");
    expect(exported.headers.get("content-disposition")).toMatch(
      /^attachment; filename="atlas-profile-export-.+\.zip"$/
    );
    expect(exported.headers.get("content-type")).toBe("application/zip");
    const archive = Buffer.from(await exported.arrayBuffer());

    const previewed = await app.fetch(
      new Request("http://localhost:4310/v1/profiles/pack/import/preview", {
        body: JSON.stringify({ data: archive.toString("base64") }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );
    expect(previewed.status).toBe(200);
    await expect(previewed.json()).resolves.toMatchObject({
      archiveFileCount: expect.any(Number),
      plannedName: "Default",
    });

    const imported = await app.fetch(
      new Request("http://localhost:4310/v1/profiles/pack/import", {
        body: JSON.stringify({
          confirm: true,
          data: archive.toString("base64"),
          name: "Imported Route Profile",
        }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );
    expect(imported.status).toBe(200);
    const payload = (await imported.json()) as { profileId: string };
    expect(await databaseAdapter.getProfile(payload.profileId)).toMatchObject({
      isDefault: false,
      isSuper: false,
      orgId: seeded.orgId,
    });
  });

  test("org admin cannot export or restore custom JavaScript source", async () => {
    const { app, databaseAdapter, seeded, session } =
      await setupProfileRouteTest();
    const toolsDir = getCustomToolsDir();
    await mkdir(toolsDir, { recursive: true });
    await writeFile(
      join(toolsDir, "source-only.js"),
      'export async function run() { return "source"; }\n'
    );
    const now = new Date().toISOString();
    await databaseAdapter.upsertTool({
      createdAt: now,
      description: "Source only",
      handlerConfig: { modulePath: "source-only.js" },
      handlerType: "javascript",
      id: "tool_source_only",
      name: "source-only",
      orgId: seeded.orgId,
      updatedAt: now,
    });
    await databaseAdapter.assignToolToProfile("portable", "tool_source_only");

    const exported = await app.fetch(
      new Request("http://localhost:4310/v1/profiles/portable/pack/export", {
        headers: session.headers(),
      })
    );
    expect(exported.status).toBe(200);
    const exportedEntries = unzipSync(
      new Uint8Array(await exported.arrayBuffer())
    );
    expect(Object.keys(exportedEntries)).not.toContain(
      "custom-tools/source-only.js"
    );
    const exportedManifest = JSON.parse(
      Buffer.from(exportedEntries[PROFILE_PACK_MANIFEST_FILENAME]!).toString(
        "utf8"
      )
    ) as ProfilePackManifest;
    expect(exportedManifest.meta.toolNames).toContain("source-only");
    expect(exportedManifest.meta.customTools).toBeUndefined();

    const uploadedToolName = "uploaded-host-code";
    const hostileManifest: ProfilePackManifest = {
      ...exportedManifest,
      meta: {
        ...exportedManifest.meta,
        customTools: [
          {
            description: "Uploaded host code",
            handlerConfig: { modulePath: "uploaded-host-code.js" },
            handlerType: "javascript",
            name: uploadedToolName,
          },
        ],
        name: "Imported without host code",
        toolNames: [uploadedToolName],
      },
    };
    const hostileArchive = Buffer.from(
      zipSync({
        "custom-tools/uploaded-host-code.js": Buffer.from(
          'export async function run() { return "host"; }\n'
        ),
        [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(
          JSON.stringify(hostileManifest)
        ),
      })
    );

    const previewed = await app.fetch(
      new Request("http://localhost:4310/v1/profiles/pack/import/preview", {
        body: JSON.stringify({ data: hostileArchive.toString("base64") }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );
    expect(previewed.status).toBe(200);
    const previewPayload = (await previewed.json()) as {
      skippedAssignments: Array<{ path: string }>;
    };
    expect(previewPayload.skippedAssignments).toContainEqual(
      expect.objectContaining({ path: `custom tool:${uploadedToolName}` })
    );

    const imported = await app.fetch(
      new Request("http://localhost:4310/v1/profiles/pack/import", {
        body: JSON.stringify({
          confirm: true,
          data: hostileArchive.toString("base64"),
        }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "POST",
      })
    );
    expect(imported.status).toBe(200);
    const result = (await imported.json()) as { profileId: string };
    expect(
      await databaseAdapter.getToolByName(uploadedToolName, seeded.orgId)
    ).toBeNull();
    expect(
      (await databaseAdapter.listToolsForProfile(result.profileId)).map(
        (tool) => tool.name
      )
    ).not.toContain(uploadedToolName);
  });

  test("viewer is forbidden from profile pack export", async () => {
    const { app, databaseAdapter, seeded, session } =
      await setupProfileRouteTest();
    await databaseAdapter.upsertOrgMember({
      createdAt: new Date().toISOString(),
      orgId: seeded.orgId,
      role: "viewer",
      userId: seeded.userId,
    });

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/profiles/portable/pack/export", {
        headers: session.headers(),
      })
    );
    expect(response.status).toBe(403);
  });

  test("active organization context cannot export another tenant profile", async () => {
    const { app, databaseAdapter, seeded, session } =
      await setupProfileRouteTest();
    const now = new Date().toISOString();
    await databaseAdapter.upsertOrganization({
      createdAt: now,
      id: "org_other",
      name: "Other",
      slug: "other",
      updatedAt: now,
    });
    await databaseAdapter.upsertOrgMember({
      createdAt: now,
      orgId: "org_other",
      role: "admin",
      userId: seeded.userId,
    });

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/profiles/portable/pack/export", {
        headers: session.headers({}, "org_other"),
      })
    );
    expect(response.status).toBe(404);
  });

  test("does not disclose unexpected server errors to profile-pack clients", async () => {
    const { app, databaseAdapter, session } = await setupProfileRouteTest();
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    databaseAdapter.getProfileForOrg = async () => {
      throw new Error(
        "SQL failure at /private/atlas/data with bearer secret-token"
      );
    };

    try {
      const response = await app.fetch(
        new Request("http://localhost:4310/v1/profiles/portable/pack/export", {
          headers: session.headers(),
        })
      );
      expect(response.status).toBe(500);
      const payload = (await response.json()) as { error: string };
      expect(payload.error).toBe("Profile pack operation failed.");
      expect(payload.error).not.toContain("/private/atlas/data");
      expect(payload.error).not.toContain("secret-token");
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("rejects a fifth concurrent body read without consuming it", async () => {
    const { app, session } = await setupProfileRouteTest();
    const heldBodies = Array.from(
      { length: PROFILE_PACK_MAX_ACTIVE_BODY_READS },
      () => createHeldBody("{}")
    );
    const pendingResponses = heldBodies.map((held, index) =>
      app.fetch(
        profilePackPostRequest(
          index % 2 === 0
            ? "/v1/profiles/pack/import/preview"
            : "/v1/profiles/pack/import",
          held.stream,
          session
        )
      )
    );

    await Promise.all(heldBodies.map((held) => held.started));

    const rejectedBody = createHeldBody("{}");
    const rejectedRequest = profilePackPostRequest(
      "/v1/profiles/pack/import/preview",
      rejectedBody.stream,
      session
    );
    try {
      const rejected = await app.fetch(rejectedRequest);
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get("retry-after")).toBe(
        String(PROFILE_PACK_BODY_RETRY_AFTER_SECONDS)
      );
      expect(rejectedRequest.bodyUsed).toBe(false);
    } finally {
      for (const held of heldBodies) {
        held.release();
      }
    }

    const released = await Promise.all(pendingResponses);
    expect(released.map((response) => response.status)).toEqual(
      Array.from({ length: PROFILE_PACK_MAX_ACTIVE_BODY_READS }, () => 400)
    );

    const next = await app.fetch(
      profilePackPostRequest(
        "/v1/profiles/pack/import",
        JSON.stringify({}),
        session
      )
    );
    expect(next.status).toBe(400);
  });

  test("keeps lifecycle admission while model lookup is pending", async () => {
    let modelLookupsStarted = 0;
    let releaseModelLookups = () => {};
    let resolveAllStarted = () => {};
    const allStarted = new Promise<void>((resolve) => {
      resolveAllStarted = resolve;
    });
    const modelLookupGate = new Promise<void>((resolve) => {
      releaseModelLookups = resolve;
    });
    const { app, session } = await setupProfileRouteTest(async () => {
      modelLookupsStarted += 1;
      if (modelLookupsStarted === PROFILE_PACK_MAX_ACTIVE_BODY_READS) {
        resolveAllStarted();
      }
      await modelLookupGate;
      return { models: [] };
    });
    const pendingResponses = Array.from(
      { length: PROFILE_PACK_MAX_ACTIVE_BODY_READS },
      (_, index) =>
        app.fetch(
          profilePackPostRequest(
            index % 2 === 0
              ? "/v1/profiles/pack/import/preview"
              : "/v1/profiles/pack/import",
            JSON.stringify({
              ...(index % 2 === 0 ? {} : { confirm: true }),
              data: "AA==",
            }),
            session
          )
        )
    );

    await allStarted;

    const rejectedBody = createHeldBody("{}");
    const rejectedRequest = profilePackPostRequest(
      "/v1/profiles/pack/import",
      rejectedBody.stream,
      session
    );
    try {
      const rejected = await app.fetch(rejectedRequest);
      expect(rejected.status).toBe(429);
      expect(rejectedRequest.bodyUsed).toBe(false);
      expect(modelLookupsStarted).toBe(PROFILE_PACK_MAX_ACTIVE_BODY_READS);
    } finally {
      releaseModelLookups();
    }

    const completed = await Promise.all(pendingResponses);
    expect(
      completed.every(
        (response) => response.status === 400 || response.status === 429
      )
    ).toBe(true);
    const next = await app.fetch(
      profilePackPostRequest(
        "/v1/profiles/pack/import/preview",
        JSON.stringify({}),
        session
      )
    );
    expect(next.status).toBe(400);
  });

  test("rejects Content-Length over the cap before reading the body", async () => {
    const { app, session } = await setupProfileRouteTest();
    const heldBody = createHeldBody("{}");
    const request = profilePackPostRequest(
      "/v1/profiles/pack/import",
      heldBody.stream,
      session,
      {
        "Content-Length": String(PROFILE_PACK_MAX_HTTP_BODY_BYTES + 1),
      }
    );

    const response = await app.fetch(request);

    expect(response.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
  });

  test("cancels a chunked body as soon as it crosses the cap", async () => {
    const { app, session } = await setupProfileRouteTest();
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let bytesSent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled = true;
        },
        pull(controller) {
          bytesSent += chunk.byteLength;
          controller.enqueue(chunk);
          if (bytesSent > PROFILE_PACK_MAX_HTTP_BODY_BYTES + chunk.byteLength) {
            controller.close();
          }
        },
      },
      { highWaterMark: 0 }
    );
    const request = profilePackPostRequest(
      "/v1/profiles/pack/import/preview",
      body,
      session
    );

    const response = await app.fetch(request);

    expect(request.headers.get("content-length")).toBeNull();
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(bytesSent).toBeGreaterThan(PROFILE_PACK_MAX_HTTP_BODY_BYTES);

    const next = await app.fetch(
      profilePackPostRequest(
        "/v1/profiles/pack/import/preview",
        JSON.stringify({}),
        session
      )
    );
    expect(next.status).toBe(400);
  });

  test("returns 400 for malformed JSON and invalid request shapes", async () => {
    const { app, session } = await setupProfileRouteTest();

    const malformed = await app.fetch(
      profilePackPostRequest("/v1/profiles/pack/import/preview", "{", session)
    );
    const invalidShape = await app.fetch(
      profilePackPostRequest(
        "/v1/profiles/pack/import",
        JSON.stringify({ data: "AA==" }),
        session
      )
    );

    expect(malformed.status).toBe(400);
    expect(invalidShape.status).toBe(400);
  });
});
