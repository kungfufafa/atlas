import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUserConfigDir, saveUserConfig } from "@atlas/core";
import { createClient } from "./index";

test("chat stream request includes cookie CSRF protection", async () => {
  const originalDocument = (
    globalThis as typeof globalThis & { document?: { cookie: string } }
  ).document;
  (
    globalThis as typeof globalThis & { document?: { cookie: string } }
  ).document = {
    cookie: "atlas_csrf=csrf-token-123; other=value",
  };

  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return new Response('data: {"type":"done","reply":"ok"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  try {
    const session = client.createChatSession("session-1", "web");
    const reply = await session.sendStream("hello", () => {});

    expect(reply).toBe("ok");
    expect(fetchCalls).toHaveLength(1);

    const headers = new Headers(fetchCalls[0]!.init?.headers);
    expect(headers.get("X-CSRF-Token")).toBe("csrf-token-123");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(fetchCalls[0]!.init?.credentials).toBe("include");
  } finally {
    (
      globalThis as typeof globalThis & { document?: { cookie: string } }
    ).document = originalDocument;
  }
});

test("automation run requests disable Bun fetch idle timeout", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return new Response(null, { status: 204 });
    },
  });

  await client.runAutomationInternal("auto_1");

  expect(String(fetchCalls[0]!.input)).toBe(
    "http://localhost:4310/v1/internal/automations/auto_1/run"
  );
  expect(
    (fetchCalls[0]!.init as RequestInit & { idleTimeout?: number }).idleTimeout
  ).toBe(0);
});

test("clients send org context on authenticated requests", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return Response.json({ profiles: [] });
    },
    orgId: "org_test",
  });

  await client.listProfiles();

  const headers = new Headers(fetchCalls[0]!.init?.headers);
  expect(headers.get("Authorization")).toBe("Bearer local-auth-token");
  expect(headers.get("X-Org-Id")).toBe("org_test");
});

test("preview and accept invite hit public auth routes", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      if (String(input).includes("/v1/auth/invite?")) {
        return Response.json({
          email: "member@acme.com",
          expiresAt: "2026-09-01T00:00:00.000Z",
          orgName: "Acme",
          role: "member",
        });
      }
      return Response.json({
        email: "member@acme.com",
        orgId: "org_acme",
        role: "member",
      });
    },
  });

  await client.previewOrgInvite("invite-token");
  const accepted = await client.acceptOrgInvite({
    password: "secret123",
    token: "invite-token",
  });

  expect(String(fetchCalls[0]!.input)).toBe(
    "http://localhost:4310/v1/auth/invite?token=invite-token"
  );
  expect(fetchCalls[0]!.init?.method ?? "GET").toBe("GET");
  expect(String(fetchCalls[1]!.input)).toBe(
    "http://localhost:4310/v1/auth/accept-invite"
  );
  expect(fetchCalls[1]!.init?.method).toBe("POST");
  expect(accepted.orgId).toBe("org_acme");
});

test("non-browser clients send local auth as a bearer token", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return Response.json({ ok: true });
    },
  });

  await client.health();

  const headers = new Headers(fetchCalls[0]!.init?.headers);
  expect(headers.get("Authorization")).toBe("Bearer local-auth-token");
});

test("data export downloads zip bytes with filename metadata", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Disposition": 'attachment; filename="atlas-export-test.zip"',
          "Content-Type": "application/zip",
        },
      });
    },
  });

  const result = await client.exportData();

  expect(fetchCalls[0]!.input.toString()).toBe(
    "http://localhost:4310/v1/platform/data/export"
  );
  const headers = new Headers(fetchCalls[0]!.init?.headers);
  expect(headers.get("Authorization")).toBe("Bearer local-auth-token");
  expect(headers.get("Content-Type")).toBeNull();
  expect(result.filename).toBe("atlas-export-test.zip");
  expect(Array.from(new Uint8Array(result.data))).toEqual([1, 2, 3]);
});

test("readProfileArtifactContent fetches artifact bytes with inline query", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return new Response("# Report", {
        headers: {
          "Content-Disposition": 'inline; filename="report.md"',
          "Content-Type": "text/markdown",
        },
      });
    },
    orgId: "org_test",
  });

  const result = await client.readProfileArtifactContent(
    "profile_1",
    "weekly/report.md",
    {
      inline: true,
    }
  );

  expect(fetchCalls[0]!.input.toString()).toBe(
    "http://localhost:4310/v1/profiles/profile_1/artifacts/content?path=weekly%2Freport.md&inline=1"
  );
  const headers = new Headers(fetchCalls[0]!.init?.headers);
  expect(headers.get("Authorization")).toBe("Bearer local-auth-token");
  expect(headers.get("X-Org-Id")).toBe("org_test");
  expect(result.contentType).toBe("text/markdown");
  expect(new TextDecoder().decode(result.data)).toBe("# Report");
});

test("getProfileArtifactPreview and inspectProfileArtifact query preview endpoints", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return new Response(
        JSON.stringify({ status: "available", type: "pdf" }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    },
    orgId: "org_test",
  });

  const preview = await client.getProfileArtifactPreview(
    "profile_1",
    "doc.pdf",
    {
      sheet: "Sheet1",
    }
  );

  expect(preview.type).toBe("pdf");
  expect(fetchCalls[0]!.input.toString()).toBe(
    "http://localhost:4310/v1/profiles/profile_1/artifacts/preview?path=doc.pdf&sheet=Sheet1"
  );

  const downloadUrl = client.getProfileArtifactDownloadUrl(
    "profile_1",
    "doc.pdf"
  );
  expect(downloadUrl).toBe(
    "http://localhost:4310/v1/profiles/profile_1/artifacts/content?path=doc.pdf"
  );
});

test("data import helpers upload base64 archive data", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      if (input.toString().endsWith("/preview")) {
        return Response.json({
          archiveFileCount: 1,
          archiveTotalBytes: 3,
          manifest: { kind: "atlas-export" },
          topLevelPaths: ["config.ini"],
          willReplaceRoot: true,
        });
      }

      return Response.json({
        manifest: { kind: "atlas-export" },
        restoredFileCount: 1,
        restoredRoot: "/tmp/atlas",
      });
    },
  });

  await expect(
    client.previewDataImport(new Uint8Array([1, 2, 3]))
  ).resolves.toMatchObject({
    archiveFileCount: 1,
  });
  await expect(
    client.restoreDataImport(new Uint8Array([4, 5, 6]), { confirm: true })
  ).resolves.toMatchObject({ restoredFileCount: 1 });

  expect(JSON.parse(fetchCalls[0]!.init?.body as string)).toEqual({
    data: "AQID",
  });
  expect(JSON.parse(fetchCalls[1]!.init?.body as string)).toEqual({
    confirm: true,
    data: "BAUG",
  });
  expect(new Headers(fetchCalls[1]!.init?.headers).get("Authorization")).toBe(
    "Bearer local-auth-token"
  );
});

test("non-browser clients reload the local auth token once after a 401", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "atlas-client-auth-reload-"));
  process.env.ATLAS_CONFIG_DIR = configDir;

  try {
    await writeFile(
      join(getUserConfigDir(), "local-auth-token"),
      "tc_local_stale\n",
      "utf8"
    );
    await saveUserConfig({
      defaultProviderId: null,
      localAuthTokenHash: createHash("sha256")
        .update("tc_local_fresh")
        .digest("hex"),
      providers: [],
    });
    await writeFile(
      join(getUserConfigDir(), "local-auth-token"),
      "tc_local_fresh\n",
      "utf8"
    );

    let attempts = 0;
    const client = createClient({
      authToken: "tc_local_stale",
      baseUrl: "http://localhost:4310",
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(
            JSON.stringify({ error: "Authentication required" }),
            {
              headers: { "Content-Type": "application/json" },
              status: 401,
            }
          );
        }

        return Response.json({ ok: true });
      },
    });

    await expect(client.health()).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
  } finally {
    delete process.env.ATLAS_CONFIG_DIR;
    await rm(configDir, { force: true, recursive: true });
  }
});

test("notification destination client methods hit the expected routes", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });

      if (init?.method === "POST" && input.toString().endsWith("/rotate-key")) {
        return Response.json({
          apiKey: "rotated",
          destination: { id: "dest_1" },
        });
      }

      if (init?.method === "POST") {
        return Response.json({
          apiKey: "created",
          destination: { id: "dest_1" },
        });
      }

      if (init?.method === "PUT") {
        return Response.json({ id: "dest_1", name: "Ops" });
      }

      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }

      return Response.json({ destinations: [] });
    },
    orgId: "org_test",
  });

  await client.listNotificationDestinations();
  await client.createNotificationDestination({
    channel: "telegram",
    name: "Ops",
    telegram: { chatId: 1001 },
  });
  await client.updateNotificationDestination("dest_1", {
    name: "Ops",
    telegram: { chatId: 1001, topicId: 22 },
  });
  await client.regenerateNotificationDestinationKey("dest_1");
  await client.deleteNotificationDestination("dest_1");

  expect(fetchCalls[0]?.input.toString()).toBe(
    "http://localhost:4310/v1/notification-destinations"
  );
  expect(fetchCalls[1]?.input.toString()).toBe(
    "http://localhost:4310/v1/notification-destinations"
  );
  expect(fetchCalls[2]?.input.toString()).toBe(
    "http://localhost:4310/v1/notification-destinations/dest_1"
  );
  expect(fetchCalls[3]?.input.toString()).toBe(
    "http://localhost:4310/v1/notification-destinations/dest_1/rotate-key"
  );
  expect(fetchCalls[4]?.input.toString()).toBe(
    "http://localhost:4310/v1/notification-destinations/dest_1"
  );
});

function createPublishShareClient(options: {
  clientOrigin?: string;
  response: Record<string, unknown>;
}) {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://127.0.0.1:4310",
    ...(options.clientOrigin === undefined
      ? {}
      : { clientOrigin: options.clientOrigin }),
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return Response.json(options.response);
    },
    orgId: "org_test",
  });
  return { client, fetchCalls };
}

test("publishProfileArtifactShare includes clientOrigin when configured", async () => {
  const { client, fetchCalls } = createPublishShareClient({
    clientOrigin: "https://atlas.example.com/",
    response: {
      id: "share_1",
      refreshed: false,
      sharePath: "/s/tok",
      shareUrl: "https://atlas.example.com/s/tok",
      token: "tok",
      webPublicUrlConfigured: true,
    },
  });

  await client.publishProfileArtifactShare("profile_1", "report.md");

  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0]!.input.toString()).toBe(
    "http://127.0.0.1:4310/v1/profiles/profile_1/artifacts/shares"
  );
  expect(JSON.parse(fetchCalls[0]!.init?.body as string)).toEqual({
    clientOrigin: "https://atlas.example.com",
    path: "report.md",
  });
});

test("publishProfileArtifactShare omits clientOrigin when unset", async () => {
  const { client, fetchCalls } = createPublishShareClient({
    response: {
      id: "share_1",
      refreshed: false,
      sharePath: "/s/tok",
      shareUrl: null,
      token: "tok",
      webPublicUrlConfigured: false,
    },
  });

  await client.publishProfileArtifactShare("profile_1", "report.md");

  expect(JSON.parse(fetchCalls[0]!.init?.body as string)).toEqual({
    path: "report.md",
  });
});
