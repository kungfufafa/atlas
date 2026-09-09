import { afterEach, describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import {
  createWorkspaceWorkerAuthToken,
  isChannelGuestUserId,
} from "@atlas/core";
import { getDiscordConfigPath } from "@atlas/core/discord-config";
import { writePrivateTextFile } from "@atlas/core/fs";
import { getTelegramConfigPath } from "@atlas/core/telegram-config";
import { getWhatsAppConfigPath } from "@atlas/core/whatsapp-config";
import { createSqliteDatabase } from "@atlas/db";
import { AgentService } from "../../services/agent-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";

setupTestConfigDir("atlas-session-channel-admission-");
const ORG = "org_admission";
const FOREIGN_ORG = "org_other";
const PROFILE = "profile_admission";
const NOW = "2026-09-06T00:00:00.000Z";
const CHANNELS = ["telegram", "whatsapp", "discord"] as const;
type Channel = (typeof CHANNELS)[number];
const CASES = [
  "member",
  "admin",
  "viewer",
  "removed",
  "blocked",
  "guest",
  "foreign-profile",
  "super-profile",
  "missing-principal",
] as const;
type AdmissionCase = (typeof CASES)[number];
const databases: Awaited<ReturnType<typeof createSqliteDatabase>>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function senderFor(channel: Channel) {
  if (channel === "telegram") {
    return "123456789";
  }
  return channel === "discord"
    ? "123456789012345678"
    : "6281111111111@s.whatsapp.net";
}

async function createHarness(channel: Channel, admissionCase: AdmissionCase) {
  const database = await createSqliteDatabase(":memory:");
  databases.push(database);
  const db = database.adapter;
  for (const orgId of [ORG, FOREIGN_ORG]) {
    await db.upsertOrganization({
      createdAt: NOW,
      id: orgId,
      name: orgId,
      slug: orgId,
      updatedAt: NOW,
    });
  }
  for (const [profileId, orgId, isSuper] of [
    [PROFILE, ORG, false],
    ["profile_other", FOREIGN_ORG, false],
    ["profile_super", ORG, true],
  ] as const) {
    await db.upsertProfile({
      createdAt: NOW,
      id: profileId,
      isDefault: !isSuper,
      isSuper,
      model: null,
      name: profileId,
      orgId,
      systemPrompt: "",
      updatedAt: NOW,
    });
  }
  const sender = senderFor(channel);
  if (admissionCase !== "guest") {
    await db.createUser({
      createdAt: NOW,
      email: "admission@example.test",
      id: "user_admission",
      isPlatformAdmin: false,
      name: "Member",
      passwordHash: "!disabled!",
      updatedAt: NOW,
    });
    if (admissionCase !== "removed") {
      await db.upsertOrgMember({
        createdAt: NOW,
        orgId: ORG,
        userId: "user_admission",
        role:
          admissionCase === "viewer" || admissionCase === "admin"
            ? admissionCase
            : "member",
      });
    }
    await db.upsertChannelOrgMapping({
      channel,
      channelUserId: sender,
      createdAt: NOW,
      orgId: ORG,
      userId: "user_admission",
    });
  }
  const configPath =
    channel === "telegram"
      ? getTelegramConfigPath(ORG)
      : channel === "discord"
        ? getDiscordConfigPath(ORG)
        : getWhatsAppConfigPath(ORG);
  const policy = [`profile_id=${PROFILE}`, "access_mode=denylist"];
  if (channel === "whatsapp") {
    policy.push(
      "phone_number=6281111111111",
      `paired_jid=${sender}`,
      `blocked_numbers=${admissionCase === "blocked" ? "6281111111111" : ""}`
    );
  } else {
    policy.push(
      "bot_token=local-fixture",
      `paired_user_ids=${sender}`,
      `blocked_user_ids=${admissionCase === "blocked" ? sender : ""}`
    );
  }
  await writePrivateTextFile(configPath, `${policy.join("\n")}\n`, {
    ensureDir: dirname(configPath),
  });
  const agent = new AgentService(null, null, db);
  const { app } = createMinimalHonoApp({ agent, databaseAdapter: db });
  const token = await createWorkspaceWorkerAuthToken({ channel, orgId: ORG });
  const profileId =
    admissionCase === "foreign-profile"
      ? "profile_other"
      : admissionCase === "super-profile"
        ? "profile_super"
        : PROFILE;
  const externalPrincipal =
    admissionCase === "missing-principal"
      ? undefined
      : { channelUserId: sender };
  return {
    db,
    request: () =>
      app.fetch(
        new Request("http://localhost:4310/v1/sessions", {
          body: JSON.stringify({ channel, externalPrincipal, profileId }),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Org-Id": ORG,
          },
          method: "POST",
        })
      ),
  };
}

describe("direct worker session creation enforces sender authorization", () => {
  for (const channel of CHANNELS) {
    for (const admissionCase of CASES) {
      test(`${channel}/${admissionCase} uses current ACL, role and profile scope`, async () => {
        const h = await createHarness(channel, admissionCase);
        const response = await h.request();
        const allowed =
          admissionCase === "member" ||
          admissionCase === "admin" ||
          admissionCase === "guest";
        const status =
          admissionCase === "foreign-profile" ||
          admissionCase === "super-profile"
            ? 404
            : 403;
        expect(response.status).toBe(allowed ? 201 : status);
        const sessions = await h.db.listSessions();
        expect(sessions).toHaveLength(allowed ? 1 : 0);
        if (allowed) {
          const result = await response.json();
          const session = await h.db.getSession(result.sessionId);
          expect(session).toMatchObject({
            orgId: ORG,
            profileId: PROFILE,
            channel,
          });
          expect(isChannelGuestUserId(session?.userId)).toBe(
            admissionCase === "guest"
          );
        }
        expect(
          sessions.some((session) => session.profileId === "profile_other")
        ).toBe(false);
        expect(
          sessions.some((session) => session.profileId === "profile_super")
        ).toBe(false);
      });
    }
  }
});
