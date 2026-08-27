import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getUserConfigDir } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import {
  createAtlasDataExport,
  MAX_ATLAS_IMPORT_REQUEST_BYTES,
  previewAtlasDataImport,
} from "../../services/data-portability";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import { loginPlatformAdminSession } from "../test-session-helpers";

setupTestConfigDir("atlas-setup-import-routes-test-");

function createApp() {
  return createMinimalHonoApp({
    agent: {
      listProfiles: async () => ({ profiles: [{ id: "default" }] }),
      providerConfigured: true,
    },
  });
}

describe("setup import routes", () => {
  test("fresh install can preview and restore import without authentication", async () => {
    const { app } = createApp();
    await writeFile(join(getUserConfigDir(), "config.ini"), "original");
    const archive = (
      await createAtlasDataExport({ rootDir: getUserConfigDir() })
    ).data;
    await writeFile(join(getUserConfigDir(), "config.ini"), "changed");

    const previewResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup/import/preview", {
        body: JSON.stringify({ data: archive.toString("base64") }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );

    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toMatchObject({
      archiveFileCount: 1,
      willReplaceRoot: true,
    });
    await expect(
      readFile(join(getUserConfigDir(), "config.ini"), "utf8")
    ).resolves.toBe("changed");

    const restoreResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup/import/restore", {
        body: JSON.stringify({
          confirm: true,
          data: archive.toString("base64"),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );

    expect(restoreResponse.status).toBe(200);
    await expect(restoreResponse.json()).resolves.toMatchObject({
      // createApp() omits onDataRestored — client must restart.
      requiresRestart: true,
      restoredFileCount: 1,
    });
    await expect(
      readFile(join(getUserConfigDir(), "config.ini"), "utf8")
    ).resolves.toBe("original");
  });

  test("setup restore reports requiresRestart false after onDataRestored succeeds", async () => {
    let restoredCalls = 0;
    const { app } = createMinimalHonoApp({
      agent: {
        listProfiles: async () => ({ profiles: [{ id: "default" }] }),
        providerConfigured: true,
      },
      onDataRestored: async () => {
        restoredCalls += 1;
      },
    });

    await writeFile(join(getUserConfigDir(), "config.ini"), "original");
    const archive = (
      await createAtlasDataExport({ rootDir: getUserConfigDir() })
    ).data;
    await writeFile(join(getUserConfigDir(), "config.ini"), "changed");

    const restoreResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup/import/restore", {
        body: JSON.stringify({
          confirm: true,
          data: archive.toString("base64"),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );

    expect(restoreResponse.status).toBe(200);
    expect(restoredCalls).toBe(1);
    await expect(restoreResponse.json()).resolves.toMatchObject({
      requiresRestart: false,
      restoredFileCount: 1,
    });
  });

  test("setup restore keeps 200 with requiresRestart when onDataRestored throws", async () => {
    const { app } = createMinimalHonoApp({
      agent: {
        listProfiles: async () => ({ profiles: [{ id: "default" }] }),
        providerConfigured: true,
      },
      onDataRestored: async () => {
        throw new Error("reopen failed");
      },
    });

    await writeFile(join(getUserConfigDir(), "config.ini"), "original");
    const archive = (
      await createAtlasDataExport({ rootDir: getUserConfigDir() })
    ).data;

    const restoreResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup/import/restore", {
        body: JSON.stringify({
          confirm: true,
          data: archive.toString("base64"),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );

    expect(restoreResponse.status).toBe(200);
    await expect(restoreResponse.json()).resolves.toMatchObject({
      requiresRestart: true,
    });
    await expect(
      readFile(join(getUserConfigDir(), "config.ini"), "utf8")
    ).resolves.toBe("original");
  });

  test("setup restore re-checks empty install after decoding the archive", async () => {
    const inner = createInMemoryDatabaseAdapter();
    let countCalls = 0;
    const databaseAdapter = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "countHumanUsers") {
          return async () => {
            countCalls += 1;
            return countCalls >= 2 ? 1 : 0;
          };
        }

        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as typeof inner;

    const { app } = createMinimalHonoApp({
      agent: {
        listProfiles: async () => ({ profiles: [{ id: "default" }] }),
        providerConfigured: true,
      },
      databaseAdapter,
    });

    await writeFile(join(getUserConfigDir(), "config.ini"), "keep-me");
    const archive = (
      await createAtlasDataExport({ rootDir: getUserConfigDir() })
    ).data;
    await writeFile(join(getUserConfigDir(), "config.ini"), "changed");

    const restoreResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup/import/restore", {
        body: JSON.stringify({
          confirm: true,
          data: archive.toString("base64"),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );

    expect(restoreResponse.status).toBe(409);
    expect(countCalls).toBeGreaterThanOrEqual(2);
    await expect(
      readFile(join(getUserConfigDir(), "config.ini"), "utf8")
    ).resolves.toBe("changed");
  });

  test("setup import is blocked after the first admin account exists", async () => {
    const { app, authService, databaseAdapter } = createApp();
    await loginPlatformAdminSession(app, authService, databaseAdapter);
    const archive = (
      await createAtlasDataExport({ rootDir: getUserConfigDir() })
    ).data;

    const previewResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup/import/preview", {
        body: JSON.stringify({ data: archive.toString("base64") }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );

    expect(previewResponse.status).toBe(409);
    await expect(previewResponse.json()).resolves.toEqual({
      error:
        "Setup import is only available before the first admin account is created.",
    });
  });

  test("invalid setup import archive is rejected", async () => {
    const { app } = createApp();
    await writeFile(join(getUserConfigDir(), "config.ini"), "keep");

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup/import/preview", {
        body: JSON.stringify({
          data: Buffer.from("not a zip").toString("base64"),
        }),
        headers: { "Content-Type": "application/json" },
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

  test("rejects an oversized setup import before reading its body", async () => {
    const { app } = createApp();
    const response = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup/import/preview", {
        body: "{}",
        headers: {
          "Content-Length": String(MAX_ATLAS_IMPORT_REQUEST_BYTES + 1),
          "Content-Type": "application/json",
        },
        method: "POST",
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Request body is too large.",
    });
  });

  test("times out stalled bodies and releases the setup import slot", async () => {
    let cancelled = false;
    const { app } = createMinimalHonoApp({
      agent: {
        listProfiles: async () => ({ profiles: [{ id: "default" }] }),
        providerConfigured: true,
      },
      dataImportBodyReadTimeoutMs: 10,
    });
    const stalledBody = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('{"data":"'));
      },
    });

    const timedOutResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup/import/preview", {
        body: stalledBody,
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );
    expect(timedOutResponse.status).toBe(408);
    expect(cancelled).toBe(true);

    await writeFile(join(getUserConfigDir(), "config.ini"), "safe");
    const archive = (
      await createAtlasDataExport({ rootDir: getUserConfigDir() })
    ).data;
    const nextResponse = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup/import/preview", {
        body: JSON.stringify({ data: archive.toString("base64") }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );

    expect(nextResponse.status).toBe(200);
  });

  test("serializes first-admin setup behind restore and reload", async () => {
    let releaseReload = () => undefined;
    const reloadGate = new Promise<void>((resolveReload) => {
      releaseReload = resolveReload;
    });
    let markReloadStarted = () => undefined;
    const reloadStarted = new Promise<void>((resolveStarted) => {
      markReloadStarted = resolveStarted;
    });
    const { app, databaseAdapter } = createMinimalHonoApp({
      agent: {
        listProfiles: async () => ({ profiles: [{ id: "default" }] }),
        providerConfigured: true,
      },
      onDataRestored: async () => {
        markReloadStarted();
        await reloadGate;
      },
    });
    await writeFile(join(getUserConfigDir(), "config.ini"), "restored");
    const archive = (
      await createAtlasDataExport({ rootDir: getUserConfigDir() })
    ).data;

    const restorePromise = app.fetch(
      new Request("http://localhost:4310/v1/auth/setup/import/restore", {
        body: JSON.stringify({
          confirm: true,
          data: archive.toString("base64"),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );
    await reloadStarted;

    let setupSettled = false;
    const setupPromise = app
      .fetch(
        new Request("http://localhost:4310/v1/auth/setup", {
          body: JSON.stringify({
            admin: {
              email: "admin@example.com",
              name: "Admin",
              password: "password123",
            },
            organization: { name: "Atlas", slug: "atlas" },
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      )
      .finally(() => {
        setupSettled = true;
      });
    await Bun.sleep(50);

    expect(setupSettled).toBe(false);
    expect(await databaseAdapter.countHumanUsers()).toBe(0);
    releaseReload();

    const [restoreResponse, setupResponse] = await Promise.all([
      restorePromise,
      setupPromise,
    ]);
    expect(restoreResponse.status).toBe(200);
    expect(setupResponse.status).toBe(201);
    expect(await databaseAdapter.countHumanUsers()).toBe(1);
  });

  test("setup import preview accepts valid archives", async () => {
    const { app } = createApp();
    await writeFile(join(getUserConfigDir(), "config.ini"), "provider=openai");
    const archive = (
      await createAtlasDataExport({ rootDir: getUserConfigDir() })
    ).data;
    const preview = await previewAtlasDataImport(archive, {
      rootDir: getUserConfigDir(),
    });

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/auth/setup/import/preview", {
        body: JSON.stringify({ data: archive.toString("base64") }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      archiveFileCount: preview.archiveFileCount,
      topLevelPaths: preview.topLevelPaths,
    });
  });
});
