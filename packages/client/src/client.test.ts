import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtlasApiError, getUserConfigDir, saveUserConfig } from "@atlas/core";
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

test("session attachment URLs encode identifiers and opt into safe image preview", () => {
  const client = createClient({ baseUrl: "http://localhost:4310" });

  expect(client.getSessionAttachmentUrl("session/one", "attachment two")).toBe(
    "http://localhost:4310/v1/sessions/session%2Fone/attachments/attachment%20two"
  );
  expect(
    client.getSessionAttachmentUrl("session/one", "attachment two", true)
  ).toBe(
    "http://localhost:4310/v1/sessions/session%2Fone/attachments/attachment%20two?inline=1"
  );
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

  await client.runAutomationInternal("auto_1", "tick-1", "org_1");

  expect(String(fetchCalls[0]!.input)).toBe(
    "http://localhost:4310/v1/internal/automations/auto_1/run?orgId=org_1"
  );
  expect(
    (fetchCalls[0]!.init as RequestInit & { idleTimeout?: number }).idleTimeout
  ).toBe(0);
  expect(fetchCalls[0]!.init?.body).toBe(JSON.stringify({ fireId: "tick-1" }));
});

test("clients reject redirects for regular and streaming requests", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    baseUrl: "https://atlas.example.com",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      const url = String(input);

      if (url.endsWith("/stream")) {
        return new Response(null, { status: 204 });
      }

      if (url.includes("messages?stream=true")) {
        return new Response('data: {"type":"done","reply":"ok"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      if (url.endsWith("/agent-browser/install")) {
        return new Response(
          'data: {"type":"done","status":{"installCommand":"","installed":true,"nextStep":null,"ready":true,"statusMessage":null,"version":"1"}}\n\n',
          { headers: { "Content-Type": "text/event-stream" } }
        );
      }

      return Response.json({ ok: true });
    },
    redirect: "error",
  });

  await client.health();
  await client.subscribeSessionStream("session-1", () => {});
  await client
    .createChatSession("session-1", "web")
    .sendStream("hello", () => {});
  await client.installAgentBrowser();

  expect(fetchCalls.map((call) => call.init?.redirect)).toEqual([
    "error",
    "error",
    "error",
    "error",
  ]);
});

test("automation worker curator requests use internal org-scoped routes", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return String(input).endsWith("/v1/internal/curator/orgs")
        ? Response.json({ orgs: [] })
        : Response.json({ result: null });
    },
  });

  await client.listSkillCuratorOrgs();
  await client.runSkillCuratorDueInternal("org one");

  expect(String(fetchCalls[0]?.input)).toBe(
    "http://localhost:4310/v1/internal/curator/orgs"
  );
  expect(String(fetchCalls[1]?.input)).toBe(
    "http://localhost:4310/v1/internal/curator/orgs/org%20one/run-due"
  );
  expect(fetchCalls[1]?.init?.method).toBe("POST");
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

test("listProfiles scopes an individual request without mutating the client", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return Response.json({ profiles: [] });
    },
    orgId: "org_default",
  });

  await client.listProfiles("org_other");
  await client.listProfiles();

  expect(new Headers(fetchCalls[0]?.init?.headers).get("X-Org-Id")).toBe(
    "org_other"
  );
  expect(new Headers(fetchCalls[1]?.init?.headers).get("X-Org-Id")).toBe(
    "org_default"
  );
});

test("profile history encodes the profile id and pagination", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return Response.json({ events: [] });
    },
  });

  const response = await client.listProfileChangeHistory("profile / one", {
    limit: 25,
    offset: 50,
  });

  expect(response.events).toEqual([]);
  expect(String(fetchCalls[0]?.input)).toBe(
    "http://localhost:4310/v1/profiles/profile%20%2F%20one/history?limit=25&offset=50"
  );
  expect(fetchCalls[0]?.init?.method).toBeUndefined();
});

test("knowledge base uploads send an explicit duplicate action", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return Response.json({
        document: { id: "document_1" },
        outcome: "replaced",
        profileId: "profile_1",
      });
    },
  });
  const document = {
    data: "SGVsbG8=",
    filename: "guide.md",
    mediaType: "text/markdown",
  };

  await client.uploadKnowledgeBaseDocument(
    "profile / one",
    document,
    "replace"
  );

  expect(String(fetchCalls[0]?.input)).toBe(
    "http://localhost:4310/v1/profiles/profile%20%2F%20one/knowledge-base"
  );
  expect(fetchCalls[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
    document,
    onDuplicate: "replace",
  });
});

test("knowledge base duplicate errors retain the existing document", async () => {
  const client = createClient({
    baseUrl: "http://localhost:4310",
    fetch: async () =>
      Response.json(
        {
          duplicate: {
            existingDocumentId: "kb_existing",
            existingFilename: "Existing guide.md",
            match: "content_hash",
          },
          error: "Duplicate knowledge base document.",
        },
        { status: 409 }
      ),
  });

  try {
    await client.uploadKnowledgeBaseDocument("profile_1", {
      data: "SGVsbG8=",
      filename: "new-guide.md",
      mediaType: "text/markdown",
    });
    throw new Error("Expected duplicate upload to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(AtlasApiError);
    expect(error).toMatchObject({
      knowledgeBaseDuplicate: {
        existingDocumentId: "kb_existing",
        existingFilename: "Existing guide.md",
        match: "content_hash",
      },
      status: 409,
    });
  }
});

test("channel principal binding sends the asserted expected user", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "worker-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return Response.json({ orgId: "org_test", userId: "user_1" });
    },
    orgId: "org_test",
  });

  await client.bindChannelPrincipal({
    channel: "whatsapp",
    channelUserId: "628111111111@s.whatsapp.net",
    expectedUserId: "user_1",
    pairingAssertion: "assertion_1",
  });

  expect(String(fetchCalls[0]?.input)).toBe(
    "http://localhost:4310/v1/channel-principals"
  );
  expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
    channel: "whatsapp",
    channelUserId: "628111111111@s.whatsapp.net",
    expectedUserId: "user_1",
    pairingAssertion: "assertion_1",
  });
});

test("capability mapping helpers use the generic workspace endpoints", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return Response.json({
        capabilityId: "image.generation",
        config: { bindings: {}, schemaVersion: 1 },
      });
    },
    orgId: "org_test",
  });
  const request = {
    binding: {
      contractVersion: 1,
      enabled: true,
      fallbacks: [],
      mode: "manual" as const,
      primary: { modelId: "image-model", providerId: "provider one" },
    },
  };

  await client.getCapabilityCatalog();
  await client.getCapabilityMappings();
  await client.getCapabilityOptions();
  await client.setCapabilityMapping("image.generation", request);

  expect(fetchCalls.slice(0, 3).map((call) => String(call.input))).toEqual([
    "http://localhost:4310/v1/capabilities/catalog",
    "http://localhost:4310/v1/capabilities/mappings",
    "http://localhost:4310/v1/capabilities/options",
  ]);
  expect(String(fetchCalls[3]?.input)).toBe(
    "http://localhost:4310/v1/capabilities/mappings/image.generation"
  );
  expect(fetchCalls[3]?.init?.method).toBe("PUT");
  expect(fetchCalls[3]?.init?.body).toBe(JSON.stringify(request));
  expect(new Headers(fetchCalls[3]?.init?.headers).get("X-Org-Id")).toBe(
    "org_test"
  );
});

test("coding harness mode requests stay scoped to the active organization", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return Response.json({
        loginCommands: [],
        providerPassthroughEnabled: false,
      });
    },
    orgId: "org_native",
  });

  await client.setCodingHarnessSettings(false);

  expect(String(fetchCalls[0]?.input)).toBe(
    "http://localhost:4310/v1/settings/coding-harnesses"
  );
  expect(fetchCalls[0]?.init?.method).toBe("PUT");
  expect(fetchCalls[0]?.init?.body).toBe(
    JSON.stringify({ providerPassthroughEnabled: false })
  );
  expect(new Headers(fetchCalls[0]?.init?.headers).get("X-Org-Id")).toBe(
    "org_native"
  );
});

test("coding harness requests remain pinned across an active-org switch", async () => {
  const orgHeaders: string[] = [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (_input, init) => {
      orgHeaders.push(new Headers(init?.headers).get("X-Org-Id") ?? "none");
      return Response.json({
        loginCommands: [],
        providerPassthroughEnabled: true,
      });
    },
    orgId: "org_a",
  });

  const first = client.getCodingHarnessSettings("org_a");
  client.setOrgId("org_b");
  const second = client.setCodingHarnessSettings(false, "org_b");
  await Promise.all([first, second]);

  expect(orgHeaders).toEqual(["org_a", "org_b"]);
});

test("isolateOrgId keeps concurrent setOrgId from racing X-Org-Id", async () => {
  const orgHeaders: string[] = [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (_input, init) => {
      await Bun.sleep(40);
      orgHeaders.push(new Headers(init?.headers).get("X-Org-Id") ?? "none");
      return Response.json({ profiles: [] });
    },
  });

  await Promise.all([
    client.isolateOrgId(async () => {
      client.setOrgId("org_a");
      await client.listProfiles();
    }),
    client.isolateOrgId(async () => {
      client.setOrgId("org_b");
      await client.listProfiles();
    }),
  ]);

  expect(orgHeaders.sort()).toEqual(["org_a", "org_b"]);
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

test("token auth clients request a session token and omit cookies", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return Response.json({
        email: "admin@example.com",
        orgId: "org_acme",
        sessionToken: "session-token-1",
      });
    },
    tokenAuth: true,
  });

  const user = await client.login("admin@example.com", "password123");
  expect(user.sessionToken).toBe("session-token-1");

  const loginHeaders = new Headers(fetchCalls[0]!.init?.headers);
  expect(loginHeaders.get("X-Atlas-Auth-Mode")).toBe("token");
  expect(fetchCalls[0]!.init?.credentials).toBe("omit");

  await client.health();
  const authedHeaders = new Headers(fetchCalls[1]!.init?.headers);
  expect(authedHeaders.get("Authorization")).toBe("Bearer session-token-1");
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

test("JSON content type is sent only when a request has a body", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return Response.json(
        String(input).endsWith("/test")
          ? { delivered: true }
          : {
              configurationSource: "settings",
              configured: true,
              disabledByDoNotTrack: false,
              dsnMasked: "http.../42",
            }
      );
    },
  });

  await client.getErrorTrackingSettings();
  await client.sendErrorTrackingTest();
  await client.setErrorTrackingSettings({ dsn: "https://key@example.com/42" });

  const headers = fetchCalls.map((call) =>
    new Headers(call.init?.headers).get("Content-Type")
  );
  expect(headers).toEqual([null, null, "application/json"]);
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

test("profile pack helpers preserve ZIP bytes and encode import requests", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      const url = String(input);
      if (url.includes("/pack/export")) {
        return new Response(new Uint8Array([9, 8, 7]), {
          headers: {
            "Content-Disposition":
              'attachment; filename="atlas-profile-export-bot.zip"',
            "Content-Type": "application/zip",
          },
        });
      }
      if (url.endsWith("/pack/import/preview")) {
        return Response.json({
          archiveFileCount: 1,
          archiveTotalBytes: 3,
          manifest: { kind: "atlas-profile-export" },
          plannedName: "Bot",
          skippedAssignments: [],
          topLevelPaths: ["SOUL.md"],
        });
      }
      return Response.json({
        manifest: { kind: "atlas-profile-export" },
        profileId: "bot-copy",
        skippedAssignments: [],
      });
    },
    orgId: "org_test",
  });

  const exported = await client.exportProfilePack("bot/profile");
  expect(String(fetchCalls[0]!.input)).toBe(
    "http://localhost:4310/v1/profiles/bot%2Fprofile/pack/export"
  );
  expect(exported.filename).toBe("atlas-profile-export-bot.zip");
  expect(Array.from(new Uint8Array(exported.data))).toEqual([9, 8, 7]);

  await client.previewProfilePackImport(new Uint8Array([1, 2, 3]));
  await client.importProfilePack(new Uint8Array([4, 5, 6]), {
    confirm: true,
    name: "Bot Copy",
  });

  expect(JSON.parse(fetchCalls[1]!.init?.body as string)).toEqual({
    data: Buffer.from([1, 2, 3]).toString("base64"),
  });
  expect(JSON.parse(fetchCalls[2]!.init?.body as string)).toEqual({
    confirm: true,
    data: Buffer.from([4, 5, 6]).toString("base64"),
    name: "Bot Copy",
  });
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
      sessionId: "session_1",
    }
  );

  expect(fetchCalls[0]!.input.toString()).toBe(
    "http://localhost:4310/v1/profiles/profile_1/artifacts/content?path=weekly%2Freport.md&inline=1&sessionId=session_1"
  );
  const headers = new Headers(fetchCalls[0]!.init?.headers);
  expect(headers.get("Authorization")).toBe("Bearer local-auth-token");
  expect(headers.get("X-Org-Id")).toBe("org_test");
  expect(result.contentType).toBe("text/markdown");
  expect(new TextDecoder().decode(result.data)).toBe("# Report");
});

test("getProfileAvatar fetches authenticated avatar bytes", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: {
          "Content-Type": "image/png",
        },
      });
    },
    orgId: "org_test",
  });

  const result = await client.getProfileAvatar(
    "profile / one",
    "2026-09-01T09:00:00.000Z"
  );

  expect(fetchCalls[0]!.input.toString()).toBe(
    "http://localhost:4310/v1/profiles/profile%20%2F%20one/avatar?v=2026-09-01T09%3A00%3A00.000Z"
  );
  expect(fetchCalls[0]!.init?.cache).toBe("no-store");
  const headers = new Headers(fetchCalls[0]!.init?.headers);
  expect(headers.get("Authorization")).toBe("Bearer local-auth-token");
  expect(headers.get("X-Org-Id")).toBe("org_test");
  expect(headers.get("Content-Type")).toBeNull();
  expect(result.contentType).toBe("image/png");
  expect(Array.from(new Uint8Array(result.data))).toEqual([137, 80, 78, 71]);
});

test("listProfileArtifacts scopes complete folder metadata separately from pagination", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return Response.json({
        artifacts: [],
        directory: "/tmp/artifacts",
        folders: [],
        profileId: "profile_1",
        total: 0,
      });
    },
    orgId: "org_test",
  });

  await client.listProfileArtifacts("profile_1", {
    folder: "reports/weekly",
    limit: 30,
    offset: 60,
    sessionId: "session_1",
  });

  expect(fetchCalls[0]?.input.toString()).toBe(
    "http://localhost:4310/v1/profiles/profile_1/artifacts?folder=reports%2Fweekly&limit=30&offset=60&sessionId=session_1"
  );
});

test("editable artifact helpers send a scoped hash-guarded update", async () => {
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
    [];
  const editable = {
    content: "# Report\n",
    editable: true,
    expectedHash: "a".repeat(64),
    filename: "report.md",
    kind: "markdown" as const,
    path: "weekly/report.md",
    sizeBytes: 9,
    truncated: false,
  };
  const client = createClient({
    authToken: "local-auth-token",
    baseUrl: "http://localhost:4310",
    fetch: async (input, init) => {
      fetchCalls.push({ init, input });
      return Response.json(editable);
    },
    orgId: "org_test",
  });

  await client.getEditableProfileArtifact("profile_1", "weekly/report.md");
  await client.updateEditableProfileArtifact("profile_1", "weekly/report.md", {
    content: "# Updated\n",
    expectedHash: editable.expectedHash,
  });

  const expectedUrl =
    "http://localhost:4310/v1/profiles/profile_1/artifacts/editable?path=weekly%2Freport.md";
  expect(fetchCalls[0]?.input.toString()).toBe(expectedUrl);
  expect(fetchCalls[1]?.input.toString()).toBe(expectedUrl);
  expect(fetchCalls[1]?.init?.method).toBe("PUT");
  expect(JSON.parse(fetchCalls[1]?.init?.body as string)).toEqual({
    content: "# Updated\n",
    expectedHash: editable.expectedHash,
  });
  const headers = new Headers(fetchCalls[1]?.init?.headers);
  expect(headers.get("Authorization")).toBe("Bearer local-auth-token");
  expect(headers.get("X-Org-Id")).toBe("org_test");
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

  await client.publishProfileArtifactShare("profile_1", "report.md", {
    sessionId: "session_1",
  });

  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0]!.input.toString()).toBe(
    "http://127.0.0.1:4310/v1/profiles/profile_1/artifacts/shares?sessionId=session_1"
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
