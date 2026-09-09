import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createClient } from "@atlas/client";
import {
  CHANNEL_GUEST_USER_ID_PREFIX,
  createWorkspaceWorkerAuthToken,
  isChannelGuestUserId,
  resolveLocalAuthToken,
  rotateLocalAuthToken,
} from "@atlas/core";
import { getDiscordConfigPath } from "@atlas/core/discord-config";
import { writePrivateTextFile } from "@atlas/core/fs";
import { getTelegramConfigPath } from "@atlas/core/telegram-config";
import {
  getWhatsAppConfigPath,
  rememberWhatsAppLidPhone,
} from "@atlas/core/whatsapp-config";
import { createSqliteDatabase } from "@atlas/db";
import { IdentityService } from "../../services/identity-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";

setupTestConfigDir("atlas-channel-authority-");
const CHANNELS = ["telegram", "whatsapp", "discord"] as const;
const MODES = ["pairing", "open", "allowlist", "denylist"] as const;
const STATES = [
  "paired",
  "allowed",
  "blocked",
  "both",
  "unlisted",
  "unlinked",
] as const;
const ROLES = [
  "admin",
  "member",
  "viewer",
  "guest",
  "removed",
  "foreign",
] as const;
const INTENTS = ["files", "invoke", "read"] as const;
type Channel = (typeof CHANNELS)[number];
type Mode = (typeof MODES)[number];
type State = (typeof STATES)[number];
type Role = (typeof ROLES)[number];
const ORG = "org_authority";
const FOREIGN_ORG = "org_other";
const PROFILE = "profile_authority";
const SESSION = "session_authority";
const NOW = "2026-09-06T00:00:00.000Z";
const SENDERS = {
  discord: "123456789012345678",
  telegram: "123456789",
  whatsapp: "6281111111111@s.whatsapp.net",
};
const OWNER = "6289999999999@s.whatsapp.net";
const databases: Awaited<ReturnType<typeof createSqliteDatabase>>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function policyAllows(channel: Channel, mode: Mode, state: State): boolean {
  if (mode === "open") {
    return true;
  }
  if (mode === "denylist") {
    return state !== "blocked" && state !== "both";
  }
  if (mode === "pairing" && channel === "whatsapp") {
    return state === "paired" || state === "both";
  }
  return state === "paired" || state === "allowed" || state === "both";
}

function configPath(channel: Channel, orgId = ORG): string {
  if (channel === "telegram") {
    return getTelegramConfigPath(orgId);
  }
  return channel === "discord"
    ? getDiscordConfigPath(orgId)
    : getWhatsAppConfigPath(orgId);
}

async function writePolicy(
  channel: Channel,
  mode: Mode,
  state: State,
  orgId = ORG
) {
  const sender = SENDERS[channel];
  const paired = state === "paired" || state === "both";
  const allowed = state === "allowed" || state === "both";
  const blocked = state === "blocked" || state === "both";
  const lines = [`profile_id=${PROFILE}`, `access_mode=${mode}`];
  if (channel === "whatsapp") {
    lines.push(
      "phone_number=6289999999999",
      `paired_jid=${paired ? sender : OWNER}`,
      `allowed_numbers=${allowed ? "6281111111111" : ""}`,
      `blocked_numbers=${blocked ? "6281111111111" : ""}`
    );
  } else {
    lines.push(
      "bot_token=local-fixture-no-network",
      `paired_user_ids=${paired ? sender : ""}`,
      `allowed_user_ids=${allowed ? sender : ""}`,
      `blocked_user_ids=${blocked ? sender : ""}`
    );
  }
  const file = configPath(channel, orgId);
  await writePrivateTextFile(file, `${lines.join("\n")}\n`, {
    ensureDir: dirname(file),
  });
}

async function createHarness(
  channel: Channel,
  mode: Mode = "open",
  state: State = "paired",
  role: Role = "member",
  databaseUrl = ":memory:",
  isPlatformAdmin = false
) {
  const database = await createSqliteDatabase(databaseUrl);
  databases.push(database);
  const db = database.adapter;
  for (const orgId of [ORG, FOREIGN_ORG]) {
    await db.upsertOrganization({
      id: orgId,
      name: orgId,
      slug: orgId,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  const userId =
    role === "guest"
      ? `${CHANNEL_GUEST_USER_ID_PREFIX}matrix`
      : "user_authority";
  await db.createUser({
    id: userId,
    email: `${userId}@example.test`,
    passwordHash: "!disabled!",
    isPlatformAdmin,
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (role !== "removed") {
    await db.upsertOrgMember({
      orgId: role === "foreign" ? FOREIGN_ORG : ORG,
      userId,
      role: role === "guest" || role === "foreign" ? "member" : role,
      createdAt: NOW,
    });
  }
  for (const [profileId, orgId, isSuper] of [
    [PROFILE, ORG, false],
    ["profile_other", FOREIGN_ORG, false],
    ["profile_super", ORG, true],
  ] as const) {
    await db.upsertProfile({
      id: profileId,
      orgId,
      isSuper,
      isDefault: !isSuper,
      name: profileId,
      model: null,
      systemPrompt: "",
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  if (state !== "unlinked") {
    await db.upsertChannelOrgMapping({
      channel,
      channelUserId: SENDERS[channel],
      orgId: ORG,
      userId,
      createdAt: NOW,
    });
  }
  await db.upsertSession({
    id: SESSION,
    orgId: ORG,
    channel,
    userId,
    profileId: PROFILE,
    createdAt: NOW,
    agentQuestionnaire: null,
    agentTodos: [],
    modelOverride: null,
    title: null,
  });
  await writePolicy(channel, mode, state);
  const { app, authService } = createMinimalHonoApp({
    databaseAdapter: db,
    agent: { identityService: new IdentityService(db) },
  });
  const token = await createWorkspaceWorkerAuthToken({ channel, orgId: ORG });
  const body = {
    channel,
    channelUserId: SENDERS[channel],
    profileId: PROFILE,
    sessionId: SESSION,
  };
  const request = (
    payload: unknown = body,
    options: { token?: string; orgId?: string | null; path?: string } = {}
  ) => {
    const headers = new Headers({ "Content-Type": "application/json" });
    const authToken = options.token ?? token;
    if (authToken) {
      headers.set("Authorization", `Bearer ${authToken}`);
    }
    if (options.orgId !== null) {
      headers.set("X-Org-Id", options.orgId ?? ORG);
    }
    return app.fetch(
      new Request(
        `http://localhost:4310${options.path ?? "/v1/channel-principals/authorize"}`,
        { method: "POST", headers, body: JSON.stringify(payload) }
      )
    );
  };
  return { app, authService, db, body, request, token, userId };
}

describe("actual HTTP, SQLite and identity role × policy × sender matrix", () => {
  for (const channel of CHANNELS) {
    for (const mode of MODES) {
      for (const state of STATES) {
        for (const role of ROLES) {
          test(`${channel}/${mode}/${state}/${role}: files, invoke, read`, async () => {
            const h = await createHarness(channel, mode, state, role);
            for (const intent of INTENTS) {
              const allowed =
                policyAllows(channel, mode, state) &&
                state !== "unlinked" &&
                role !== "removed" &&
                role !== "foreign" &&
                (role !== "viewer" || intent === "read");
              const response = await h.request({ ...h.body, intent });
              expect({ intent, status: response.status }).toEqual({
                intent,
                status: allowed ? 200 : 403,
              });
              if (allowed) {
                expect(await response.json()).toMatchObject({
                  orgId: ORG,
                  userId: h.userId,
                  orgRole: role === "guest" ? "member" : role,
                  isPlatformAdmin: false,
                });
              }
            }
            const mappings = await h.db.listChannelOrgMappingsForOrg(ORG);
            expect(mappings).toHaveLength(state === "unlinked" ? 0 : 1);
          });
        }
      }
    }
  }
});

for (const channel of CHANNELS) {
  for (const mode of MODES) {
    test(`${channel}/${mode}: only permitted new invoke provisions a guest`, async () => {
      const h = await createHarness(channel, mode, "unlinked");
      const { sessionId: _sessionId, ...body } = h.body;
      for (const intent of ["files", "read"] as const) {
        expect((await h.request({ ...body, intent })).status).toBe(403);
        expect(await h.db.listChannelOrgMappingsForOrg(ORG)).toHaveLength(0);
      }
      const response = await h.request({ ...body, intent: "invoke" });
      const allowed = policyAllows(channel, mode, "unlinked");
      expect(response.status).toBe(allowed ? 200 : 403);
      const mappings = await h.db.listChannelOrgMappingsForOrg(ORG);
      expect(mappings).toHaveLength(allowed ? 1 : 0);
      if (allowed) {
        const principal = await response.json();
        expect(isChannelGuestUserId(principal.userId)).toBe(true);
        expect(principal).toMatchObject({
          orgId: ORG,
          orgRole: "member",
          isPlatformAdmin: false,
        });
        expect(mappings[0]?.userId).toBe(principal.userId);
        expect((await h.request({ ...body, intent: "files" })).status).toBe(
          200
        );
      }
    });
  }

  test(`${channel}: same hot request rechecks downgrade, removal, policy and pairing`, async () => {
    const h = await createHarness(channel);
    expect((await h.request()).status).toBe(200);
    await h.db.upsertOrgMember({
      orgId: ORG,
      userId: h.userId,
      role: "viewer",
      createdAt: NOW,
    });
    expect((await h.request()).status).toBe(403);
    expect((await h.request({ ...h.body, intent: "read" })).status).toBe(200);
    await h.db.deleteOrgMember(ORG, h.userId);
    expect((await h.request({ ...h.body, intent: "read" })).status).toBe(403);
    await h.db.upsertOrgMember({
      orgId: ORG,
      userId: h.userId,
      role: "member",
      createdAt: NOW,
    });
    await writePolicy(channel, "denylist", "both");
    expect((await h.request()).status).toBe(403);
    await writePolicy(channel, "pairing", "unlisted");
    expect((await h.request()).status).toBe(403);
    await writePolicy(channel, "pairing", "paired");
    expect((await h.request()).status).toBe(200);
  });

  test(`${channel}: session org, channel, user, profile and Super Agent are enforced`, async () => {
    const h = await createHarness(channel);
    expect((await h.request({ ...h.body, profileId: "default" })).status).toBe(
      200
    );
    const session = (await h.db.getSession(SESSION))!;
    const variants = [
      { orgId: FOREIGN_ORG, profileId: "profile_other" },
      { channel: "web" as const },
      { userId: null },
      { profileId: "profile_other" },
      { profileId: "profile_super" },
    ];
    for (const variant of variants) {
      await h.db.deleteSession(SESSION);
      await h.db.upsertSession({ ...session, ...variant });
      expect(
        (await h.request({ ...h.body, profileId: undefined, intent: "read" }))
          .status
      ).toBe(404);
    }
    await h.db.upsertSession(session);
    for (const profileId of ["missing", "profile_other", "profile_super"]) {
      expect((await h.request({ ...h.body, profileId })).status).toBe(404);
      expect(
        (
          await h.request({
            channelUserId: SENDERS[channel],
            profileId,
            intent: "invoke",
          })
        ).status
      ).toBe(404);
    }
    expect((await h.request({ ...h.body, sessionId: "missing" })).status).toBe(
      404
    );
    expect(
      (await h.request({ ...h.body, sessionId: undefined, intent: "read" }))
        .status
    ).toBe(400);
    expect((await h.request()).status).toBe(200);
  });

  test(`${channel}: credential scope, malformed input, missing and archived org, rotation`, async () => {
    const h = await createHarness(channel);
    expect((await h.request(h.body, { token: "" })).status).toBe(401);
    expect((await h.request(h.body, { token: "invalid-token" })).status).toBe(
      401
    );
    expect(
      (await h.request(h.body, { token: await resolveLocalAuthToken() })).status
    ).toBe(403);
    expect((await h.request(h.body, { orgId: FOREIGN_ORG })).status).toBe(403);
    expect((await h.request(h.body, { orgId: null })).status).toBe(200);
    for (const other of CHANNELS.filter((candidate) => candidate !== channel)) {
      expect((await h.request({ ...h.body, channel: other })).status).toBe(403);
      expect(
        (
          await h.request(h.body, {
            token: await createWorkspaceWorkerAuthToken({
              channel: other,
              orgId: ORG,
            }),
          })
        ).status
      ).toBe(403);
    }
    for (const payload of [
      { ...h.body, userId: h.userId },
      { ...h.body, orgId: FOREIGN_ORG },
      { ...h.body, intent: "admin" },
      { ...h.body, channelUserId: "" },
    ]) {
      expect((await h.request(payload)).status).toBe(400);
    }
    expect(
      (await h.request({ ...h.body, channelUserId: "../invalid" })).status
    ).toBe(403);
    const missingToken = await createWorkspaceWorkerAuthToken({
      channel,
      orgId: "org_deleted",
    });
    expect(
      (await h.request(h.body, { token: missingToken, orgId: "org_deleted" }))
        .status
    ).toBe(404);
    await rotateLocalAuthToken();
    expect((await h.request()).status).toBe(401);
    expect(
      (
        await h.request(h.body, {
          token: await createWorkspaceWorkerAuthToken({ channel, orgId: ORG }),
        })
      ).status
    ).toBe(200);
    const org = (await h.db.getOrganizationById(ORG))!;
    await h.db.upsertOrganization({ ...org, archivedAt: NOW });
    expect(
      (
        await h.request(h.body, {
          token: await createWorkspaceWorkerAuthToken({ channel, orgId: ORG }),
        })
      ).status
    ).toBe(404);
  });
}

test("WhatsApp LID policy and canonical identity use only the current org map, reject conflicts", async () => {
  const h = await createHarness("whatsapp", "allowlist", "allowed");
  const lid = "999999999999999@lid";
  const body = { ...h.body, channelUserId: lid };
  await rememberWhatsAppLidPhone(lid, SENDERS.whatsapp, FOREIGN_ORG);
  expect((await h.request(body)).status).toBe(403);
  await rememberWhatsAppLidPhone(lid, SENDERS.whatsapp, ORG);
  expect((await h.request(body)).status).toBe(200);
  expect(
    (await h.request({ ...body, channelUserAliases: [OWNER] })).status
  ).toBe(403);
  await writePolicy("whatsapp", "denylist", "blocked");
  expect((await h.request(body)).status).toBe(403);
  await writePolicy("whatsapp", "open", "unlisted");
  await h.db.createUser({
    id: "conflicting_user",
    email: "conflict@example.test",
    passwordHash: "!disabled!",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await h.db.upsertChannelOrgMapping({
    channel: "whatsapp",
    channelUserId: lid,
    orgId: ORG,
    userId: "conflicting_user",
    createdAt: NOW,
  });
  expect((await h.request(body)).status).toBe(403);
});

for (const mode of MODES) {
  for (const state of STATES) {
    for (const role of ROLES) {
      test(`Discord allow ${mode}/${state}/${role}: canonical admin and exact tenant bytes`, async () => {
        const h = await createHarness("discord", mode, state, role);
        await writePolicy("discord", "open", "unlisted", FOREIGN_ORG);
        const before = await readFile(configPath("discord"));
        const foreignBefore = await readFile(
          configPath("discord", FOREIGN_ORG)
        );
        const target = "987654321012345678";
        const response = await h.request(
          {
            requesterChannelUserId: SENDERS.discord,
            targetChannelUserId: target,
          },
          { path: "/v1/channels/discord/allowed-users" }
        );
        const allowed =
          role === "admin" &&
          state !== "unlinked" &&
          policyAllows("discord", mode, state);
        expect(response.status).toBe(allowed ? 200 : 403);
        const after = await readFile(configPath("discord"));
        if (allowed) {
          expect(await response.json()).toMatchObject({
            ok: true,
            userId: target,
          });
          expect(after.toString()).toContain(target);
        } else {
          expect(after.equals(before)).toBe(true);
        }
        expect(
          (await readFile(configPath("discord", FOREIGN_ORG))).equals(
            foreignBefore
          )
        ).toBe(true);
      });
    }
  }
}

test("AtlasClient preserves credential and tenant while requesting canonical authorization", async () => {
  const h = await createHarness("discord", "pairing", "paired", "admin");
  const requests: Request[] = [];
  const client = createClient({
    baseUrl: "http://localhost:4310",
    authToken: h.token,
    tokenAuth: true,
    orgId: ORG,
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return h.app.fetch(request);
    }) as typeof fetch,
  });
  expect(
    await client.authorizeChannelPrincipal({ ...h.body, intent: "read" })
  ).toMatchObject({ userId: h.userId, orgRole: "admin", orgId: ORG });
  expect(
    await client.addDiscordAllowedUser({
      requesterChannelUserId: SENDERS.discord,
      targetChannelUserId: "987654321012345678",
    })
  ).toMatchObject({ ok: true });
  for (const request of requests) {
    expect(request.headers.get("X-Org-Id")).toBe(ORG);
    expect(request.headers.get("Authorization")).toBe(`Bearer ${h.token}`);
  }
});

for (const channel of CHANNELS) {
  test(`${channel}: platform administrator follows the current account flag across channel intents`, async () => {
    const databasePath = join(
      process.env.ATLAS_CONFIG_DIR!,
      "platform-role.sqlite"
    );
    const h = await createHarness(
      channel,
      "open",
      "paired",
      "viewer",
      databasePath,
      true
    );
    for (const intent of INTENTS) {
      expect((await h.request({ ...h.body, intent })).status).toBe(200);
    }
    const connection = new Database(databasePath);
    try {
      connection
        .query("UPDATE users SET is_platform_admin = 0 WHERE id = ?")
        .run(h.userId);
    } finally {
      connection.close();
    }
    for (const intent of INTENTS) {
      expect((await h.request({ ...h.body, intent })).status).toBe(
        intent === "read" ? 200 : 403
      );
    }
  });

  test(`${channel}: the same external sender resolves independently in two tenants`, async () => {
    const h = await createHarness(channel);
    await writePolicy(channel, "open", "unlisted", FOREIGN_ORG);
    await h.db.createUser({
      id: "user_other_tenant",
      email: "other-tenant@example.test",
      passwordHash: "!disabled!",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await h.db.upsertOrgMember({
      orgId: FOREIGN_ORG,
      userId: "user_other_tenant",
      role: "viewer",
      createdAt: NOW,
    });
    await h.db.upsertChannelOrgMapping({
      channel,
      channelUserId: SENDERS[channel],
      orgId: FOREIGN_ORG,
      userId: "user_other_tenant",
      createdAt: NOW,
    });
    const ownSession = (await h.db.getSession(SESSION))!;
    await h.db.upsertSession({
      ...ownSession,
      id: "session_other_tenant",
      orgId: FOREIGN_ORG,
      profileId: "profile_other",
      userId: "user_other_tenant",
    });
    const token = await createWorkspaceWorkerAuthToken({
      channel,
      orgId: FOREIGN_ORG,
    });
    const foreignBody = {
      ...h.body,
      sessionId: "session_other_tenant",
      profileId: "profile_other",
      intent: "read",
    };
    expect((await h.request(foreignBody)).status).toBe(404);
    const response = await h.request(foreignBody, {
      token,
      orgId: FOREIGN_ORG,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      userId: "user_other_tenant",
      orgRole: "viewer",
      orgId: FOREIGN_ORG,
    });
    expect(
      (
        await h.request(
          { ...foreignBody, intent: "files" },
          { token, orgId: FOREIGN_ORG }
        )
      ).status
    ).toBe(403);
    const ownResponse = await h.request();
    expect(ownResponse.status).toBe(200);
    expect(await ownResponse.json()).toMatchObject({
      userId: h.userId,
      orgRole: "member",
      orgId: ORG,
    });
  });

  test(`${channel}: browser and bearer users cannot impersonate channel senders`, async () => {
    const h = await createHarness(channel, "open", "paired", "admin");
    const tokens = h.authService.createBrowserSessionTokens();
    await h.db.createBrowserSession({
      id: "browser_authority",
      userId: h.userId,
      activeOrgId: ORG,
      createdAt: NOW,
      csrfTokenHash: h.authService.hashToken(tokens.csrfToken),
      expiresAt: tokens.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      sessionTokenHash: h.authService.hashToken(tokens.sessionToken),
    });
    expect(
      (await h.request(h.body, { token: tokens.sessionToken })).status
    ).toBe(403);
    const response = await h.app.fetch(
      new Request("http://localhost:4310/v1/channel-principals/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Org-Id": ORG,
          Cookie: `atlas_session=${tokens.sessionToken}; atlas_csrf=${tokens.csrfToken}`,
          "X-CSRF-Token": tokens.csrfToken,
          Origin: "http://localhost:4310",
        },
        body: JSON.stringify(h.body),
      })
    );
    expect(response.status).toBe(403);
    expect((await h.request()).status).toBe(200);
  });

  test(`${channel}: a re-paired sender cannot reuse the former user's cached session`, async () => {
    const h = await createHarness(channel);
    expect((await h.request({ ...h.body, intent: "read" })).status).toBe(200);
    await h.db.createUser({
      id: "user_repaired",
      email: "repaired@example.test",
      passwordHash: "!disabled!",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await h.db.upsertOrgMember({
      orgId: ORG,
      userId: "user_repaired",
      role: "member",
      createdAt: NOW,
    });
    await h.db.upsertChannelOrgMapping({
      channel,
      channelUserId: SENDERS[channel],
      orgId: ORG,
      userId: "user_repaired",
      createdAt: NOW,
    });
    for (const intent of INTENTS) {
      expect((await h.request({ ...h.body, intent })).status).toBe(404);
    }
    const response = await h.request({
      ...h.body,
      sessionId: undefined,
      intent: "invoke",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      userId: "user_repaired",
      orgId: ORG,
      orgRole: "member",
    });
  });

  test(`${channel}: deleted canonical users cannot reuse file/session authority`, async () => {
    const databasePath = join(process.env.ATLAS_CONFIG_DIR!, "deletion.sqlite");
    const h = await createHarness(
      channel,
      "open",
      "paired",
      "member",
      databasePath
    );
    expect((await h.request()).status).toBe(200);
    const connection = new Database(databasePath);
    try {
      connection.exec("PRAGMA foreign_keys = ON");
      connection.query("DELETE FROM users WHERE id = ?").run(h.userId);
    } finally {
      connection.close();
    }
    for (const intent of INTENTS) {
      expect((await h.request({ ...h.body, intent })).status).toBe(403);
    }
    expect(await h.db.getUserById(h.userId)).toBeNull();
    expect(await h.db.listChannelOrgMappingsForOrg(ORG)).toHaveLength(0);
  });
}
