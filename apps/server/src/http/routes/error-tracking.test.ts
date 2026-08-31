import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AgentService } from "../../services/agent-service";
import { createMinimalHonoApp } from "../test-app-helpers";
import {
  loginUserSession,
  seedOrgAdmin,
  setupFreshInstallSession,
} from "../test-session-helpers";

const DSN = "https://publickey@errors.example.com/42";

let configDir = "";
let previousConfigDir: string | undefined;
let previousDsn: string | undefined;
let previousDoNotTrack: string | undefined;

beforeEach(async () => {
  previousConfigDir = process.env.ATLAS_CONFIG_DIR;
  previousDsn = process.env.ATLAS_ERROR_TRACKING_DSN;
  previousDoNotTrack = process.env.DO_NOT_TRACK;
  configDir = await mkdtemp(join(tmpdir(), "atlas-error-tracking-route-"));
  process.env.ATLAS_CONFIG_DIR = configDir;
  delete process.env.ATLAS_ERROR_TRACKING_DSN;
  delete process.env.DO_NOT_TRACK;
});

afterEach(async () => {
  restoreEnv("ATLAS_CONFIG_DIR", previousConfigDir);
  restoreEnv("ATLAS_ERROR_TRACKING_DSN", previousDsn);
  restoreEnv("DO_NOT_TRACK", previousDoNotTrack);
  await rm(configDir, { force: true, recursive: true });
});

function createApp() {
  const databaseAdapter = createInMemoryDatabaseAdapter();
  return createMinimalHonoApp({
    agent: new AgentService(null, null, databaseAdapter),
    databaseAdapter,
  });
}

describe("error tracking routes", () => {
  test("platform admin saves a DSN and reads it back masked", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);

    const saved = await app.fetch(
      new Request("http://localhost:4310/v1/settings/error-tracking", {
        body: JSON.stringify({ dsn: DSN }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "PUT",
      })
    );

    expect(saved.status).toBe(200);
    const body = (await saved.json()) as {
      configurationSource: string | null;
      configured: boolean;
      disabledByDoNotTrack: boolean;
      dsnMasked: string | null;
    };
    expect(body).toMatchObject({
      configurationSource: "settings",
      configured: true,
      disabledByDoNotTrack: false,
    });
    expect(body.dsnMasked).not.toContain("publickey");
    expect(JSON.stringify(body)).not.toContain(DSN);

    const loaded = await app.fetch(
      new Request("http://localhost:4310/v1/settings/error-tracking", {
        headers: session.headers(),
      })
    );
    expect(loaded.status).toBe(200);
    expect(await loaded.json()).toEqual(body);
  });

  test("an empty DSN clears a saved one", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);
    const put = (dsn: string) =>
      app.fetch(
        new Request("http://localhost:4310/v1/settings/error-tracking", {
          body: JSON.stringify({ dsn }),
          headers: session.headers({
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrfToken,
          }),
          method: "PUT",
        })
      );

    expect((await put(DSN)).status).toBe(200);
    const cleared = await put("");

    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      configurationSource: null,
      configured: false,
      disabledByDoNotTrack: false,
      dsnMasked: null,
    });
  });

  test("malformed DSNs are rejected", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);
    const response = await app.fetch(
      new Request("http://localhost:4310/v1/settings/error-tracking", {
        body: JSON.stringify({ dsn: "not-a-dsn" }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "PUT",
      })
    );

    expect(response.status).toBe(400);
  });

  test("test events require a saved DSN", async () => {
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);
    const response = await app.fetch(
      new Request("http://localhost:4310/v1/settings/error-tracking/test", {
        headers: session.headers({ "X-CSRF-Token": session.csrfToken }),
        method: "POST",
      })
    );

    expect(response.status).toBe(400);
  });

  test("reports environment-only and opt-out settings accurately", async () => {
    process.env.ATLAS_ERROR_TRACKING_DSN = DSN;
    const { app, databaseAdapter } = createApp();
    const session = await setupFreshInstallSession(app, databaseAdapter);
    const load = () =>
      app.fetch(
        new Request("http://localhost:4310/v1/settings/error-tracking", {
          headers: session.headers(),
        })
      );

    const environmentSettings = await load();
    expect(environmentSettings.status).toBe(200);
    expect(await environmentSettings.json()).toMatchObject({
      configurationSource: "environment",
      configured: true,
      disabledByDoNotTrack: false,
    });

    process.env.DO_NOT_TRACK = "1";
    const optedOutSettings = await load();
    expect(await optedOutSettings.json()).toEqual({
      configurationSource: "environment",
      configured: false,
      disabledByDoNotTrack: true,
      dsnMasked: null,
    });

    const testResponse = await app.fetch(
      new Request("http://localhost:4310/v1/settings/error-tracking/test", {
        headers: session.headers({ "X-CSRF-Token": session.csrfToken }),
        method: "POST",
      })
    );
    expect(testResponse.status).toBe(400);
  });

  test("org admins cannot read or mutate host-global settings", async () => {
    const { app, databaseAdapter } = createApp();
    const { email, orgId, password } = await seedOrgAdmin(databaseAdapter, {
      email: "workspace-admin@example.com",
      orgId: "org_workspace_admin",
      userId: "user_workspace_admin",
    });
    const session = await loginUserSession(app, email, password, orgId);

    const read = await app.fetch(
      new Request("http://localhost:4310/v1/settings/error-tracking", {
        headers: session.headers(),
      })
    );
    const write = await app.fetch(
      new Request("http://localhost:4310/v1/settings/error-tracking", {
        body: JSON.stringify({ dsn: DSN }),
        headers: session.headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        }),
        method: "PUT",
      })
    );

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
