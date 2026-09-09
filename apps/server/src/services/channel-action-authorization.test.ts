import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { dirname } from "node:path";
import {
  AtlasApiError,
  LOCAL_CLIENT_USER_ID,
  PrincipalRequiredError,
} from "@atlas/core";
import { writePrivateTextFile } from "@atlas/core/fs";
import { getTelegramConfigPath } from "@atlas/core/telegram-config";
import {
  getWhatsAppConfigPath,
  loadWhatsAppLidMap,
  lookupWhatsAppLidPhone,
  rememberWhatsAppLidPhone,
} from "@atlas/core/whatsapp-config";
import { createSqliteDatabase } from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { authorizeChannelAction } from "./channel-action-authorization";
import * as channelIdentities from "./channel-guest-principal-service";
import { IdentityService } from "./identity-service";

setupTestConfigDir("atlas-channel-authority-races-");

const ORG_ID = "org_authorization_race";
const PROFILE_ID = "profile_authorization_race";
const TELEGRAM_ID = "123456789";
const LID = "154352568283178@lid";
const PHONE_A = "6281111111111@s.whatsapp.net";
const PHONE_B = "6282222222222@s.whatsapp.net";
const NOW = "2026-09-06T00:00:00.000Z";
const databases: Awaited<ReturnType<typeof createSqliteDatabase>>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

async function createHarness() {
  const database = await createSqliteDatabase(":memory:");
  databases.push(database);
  const db = database.adapter;
  await db.upsertOrganization({
    createdAt: NOW,
    id: ORG_ID,
    name: "Authorization race",
    slug: ORG_ID,
    updatedAt: NOW,
  });
  await db.upsertProfile({
    createdAt: NOW,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Assistant",
    orgId: ORG_ID,
    systemPrompt: "",
    updatedAt: NOW,
  });
  const identities = new IdentityService(db);
  const addUser = async (userId: string, role: "member" | "viewer") => {
    await db.createUser({
      createdAt: NOW,
      email: `${userId}@example.test`,
      id: userId,
      isPlatformAdmin: false,
      name: userId,
      passwordHash: "!disabled!",
      updatedAt: NOW,
    });
    await db.upsertOrgMember({
      createdAt: NOW,
      orgId: ORG_ID,
      role,
      userId,
    });
  };
  return { addUser, db, identities };
}

describe("channel authorization async identity boundaries", () => {
  for (const role of ["member", "viewer"] as const) {
    test(`cold admission rechecks the ${role} paired after its first mapping lookup`, async () => {
      const { addUser, db, identities } = await createHarness();
      await addUser("paired_user", role);
      const configPath = getTelegramConfigPath(ORG_ID);
      await writePrivateTextFile(
        configPath,
        `bot_token=local-fixture\nprofile_id=${PROFILE_ID}\naccess_mode=open\n`,
        { ensureDir: dirname(configPath) }
      );
      const assertion = await identities.issuePairingAssertion({
        channel: "telegram",
        orgId: ORG_ID,
        userId: "paired_user",
      });
      const resolve = identities.resolveForChannelSession.bind(identities);
      let pairedDuringLookup = false;
      const resolveSpy = spyOn(
        identities,
        "resolveForChannelSession"
      ).mockImplementation(async (input) => {
        if (!pairedDuringLookup) {
          pairedDuringLookup = true;
          // The authorizer has observed its real empty mapping snapshot. A
          // real pairing completes before admission resolves the actor.
          await identities.bindExternalPrincipal({
            actor: { mode: "workspace-worker", userId: LOCAL_CLIENT_USER_ID },
            channel: "telegram",
            channelUserId: TELEGRAM_ID,
            expectedUserId: "paired_user",
            orgId: ORG_ID,
            pairingAssertion: assertion,
          });
        }
        return resolve(input);
      });
      try {
        const admission = authorizeChannelAction(db, identities, {
          channel: "telegram",
          channelUserId: TELEGRAM_ID,
          intent: "invoke",
          orgId: ORG_ID,
          profileId: PROFILE_ID,
        });
        if (role === "viewer") {
          await expect(admission).rejects.toMatchObject({ status: 403 });
        } else {
          await expect(admission).resolves.toMatchObject({
            orgId: ORG_ID,
            orgRole: "member",
            userId: "paired_user",
          });
        }
        expect(pairedDuringLookup).toBe(true);
        expect(
          await db.getChannelOrgMapping(ORG_ID, "telegram", TELEGRAM_ID)
        ).toMatchObject({
          userId: "paired_user",
        });
        expect(await db.countUsers()).toBe(1);
        expect(await db.listSessions()).toEqual([]);
      } finally {
        resolveSpy.mockRestore();
      }
    });
  }

  for (const changeMap of [false, true]) {
    test(`${changeMap ? "rejects a changed" : "accepts a stable"} LID phone across normalization and policy evaluation`, async () => {
      const { addUser, db, identities } = await createHarness();
      await addUser("user_phone_a", "member");
      await addUser("user_phone_b", "member");
      for (const [channelUserId, userId] of [
        [LID, "user_phone_a"],
        [PHONE_A, "user_phone_a"],
        [PHONE_B, "user_phone_b"],
      ] as const) {
        await db.upsertChannelOrgMapping({
          channel: "whatsapp",
          channelUserId,
          createdAt: NOW,
          orgId: ORG_ID,
          userId,
        });
      }
      const configPath = getWhatsAppConfigPath(ORG_ID);
      await writePrivateTextFile(
        configPath,
        [
          `profile_id=${PROFILE_ID}`,
          "phone_number=6289999999999",
          "paired_jid=6289999999999@s.whatsapp.net",
          "access_mode=allowlist",
          `allowed_numbers=${changeMap ? "6282222222222" : "6281111111111"}`,
          "",
        ].join("\n"),
        { ensureDir: dirname(configPath) }
      );
      await rememberWhatsAppLidPhone(LID, PHONE_A, ORG_ID);
      const normalize = channelIdentities.normalizeExternalActor;
      let observedSnapshot = false;
      const normalizeSpy = spyOn(
        channelIdentities,
        "normalizeExternalActor"
      ).mockImplementation(async (input) => {
        const snapshot = await normalize(input);
        if (!observedSnapshot) {
          observedSnapshot = true;
          if (changeMap) {
            // Keep the real first snapshot; change the real tenant map at
            // the await boundary before the subsequent policy read.
            await rememberWhatsAppLidPhone(LID, PHONE_B, ORG_ID);
          }
        }
        return snapshot;
      });
      try {
        const authorization = authorizeChannelAction(db, identities, {
          channel: "whatsapp",
          channelUserId: LID,
          intent: "files",
          orgId: ORG_ID,
          profileId: PROFILE_ID,
        });
        if (changeMap) {
          let failure: unknown;
          try {
            await authorization;
          } catch (error) {
            failure = error;
          }
          expect(
            failure instanceof PrincipalRequiredError ||
              failure instanceof AtlasApiError
          ).toBe(true);
        } else {
          await expect(authorization).resolves.toMatchObject({
            orgId: ORG_ID,
            userId: "user_phone_a",
          });
        }
        expect(observedSnapshot).toBe(true);
        expect(
          lookupWhatsAppLidPhone(await loadWhatsAppLidMap(ORG_ID), LID)
        ).toBe(changeMap ? PHONE_B : PHONE_A);
        expect(
          await db.getChannelOrgMapping(ORG_ID, "whatsapp", LID)
        ).toMatchObject({
          userId: "user_phone_a",
        });
        expect(await db.countUsers()).toBe(2);
      } finally {
        normalizeSpy.mockRestore();
      }
    });
  }
});
