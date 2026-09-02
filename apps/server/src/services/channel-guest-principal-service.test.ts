import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANNEL_GUEST_USER_ID_PREFIX,
  PrincipalRequiredError,
  saveDiscordConfig,
  saveTelegramConfig,
  saveWhatsAppConfig,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import {
  type ChannelGuestPrincipalInput,
  ChannelGuestPrincipalService,
} from "./channel-guest-principal-service";

const ORG_ID = "org_channel_guests";
const DISCORD_ALLOWED_ID = "123456789012345678";
const DISCORD_BLOCKED_ID = "223456789012345678";
const WHATSAPP_LID = "154352568283178@lid";
const WHATSAPP_PHONE = "628111111111@s.whatsapp.net";

let configRoot = "";
let previousConfigRoot: string | undefined;

beforeAll(async () => {
  previousConfigRoot = process.env.ATLAS_CONFIG_DIR;
  configRoot = await mkdtemp(join(tmpdir(), "atlas-channel-guests-"));
  process.env.ATLAS_CONFIG_DIR = configRoot;
});

afterAll(async () => {
  if (previousConfigRoot === undefined) {
    delete process.env.ATLAS_CONFIG_DIR;
  } else {
    process.env.ATLAS_CONFIG_DIR = previousConfigRoot;
  }
  await rm(configRoot, { force: true, recursive: true });
});

async function seed() {
  const db = createInMemoryDatabaseAdapter();
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Channel guests",
    slug: ORG_ID,
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "admin@example.com",
    id: "user_admin",
    isPlatformAdmin: true,
    name: "Admin",
    passwordHash: "x",
    updatedAt: now,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role: "admin",
    userId: "user_admin",
  });
  return db;
}

describe("ChannelGuestPrincipalService", () => {
  test("creates a deterministic non-admin member instead of borrowing the admin", async () => {
    const db = await seed();
    const service = new ChannelGuestPrincipalService(db, {
      authorize: () => true,
    });

    const first = await service.resolveOrProvision({
      channel: "telegram",
      channelUserId: "12345",
      orgId: ORG_ID,
    });
    const repeated = await service.resolveOrProvision({
      channel: "telegram",
      channelUserId: "12345",
      orgId: ORG_ID,
    });

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      isPlatformAdmin: false,
      orgRole: "member",
    });
    expect(first.userId.startsWith(CHANNEL_GUEST_USER_ID_PREFIX)).toBe(true);
    expect(first.userId).not.toBe("user_admin");
    expect(
      await db.getChannelOrgMapping(ORG_ID, "telegram", "12345")
    ).toMatchObject({ userId: first.userId });
    expect(await db.getOrgMember(ORG_ID, first.userId)).toMatchObject({
      role: "member",
    });
    expect((await db.getUserById(first.userId))?.isPlatformAdmin).toBe(false);
    expect(await db.countHumanUsers()).toBe(1);
  });

  test("does not write a guest when the workspace policy denies the actor", async () => {
    const db = await seed();
    const service = new ChannelGuestPrincipalService(db, {
      authorize: () => false,
    });

    await expect(
      service.resolveOrProvision({
        channel: "telegram",
        channelUserId: "12345",
        orgId: ORG_ID,
      })
    ).rejects.toBeInstanceOf(PrincipalRequiredError);
    expect(
      await db.getChannelOrgMapping(ORG_ID, "telegram", "12345")
    ).toBeNull();
    expect(await db.countUsers()).toBe(1);
  });

  test("reauthorizes an existing canonical mapping", async () => {
    const db = await seed();
    const now = new Date().toISOString();
    await db.upsertChannelOrgMapping({
      channel: "telegram",
      channelUserId: "12345",
      createdAt: now,
      orgId: ORG_ID,
      userId: "user_admin",
    });
    let authorizationChecks = 0;
    const service = new ChannelGuestPrincipalService(db, {
      authorize: () => {
        authorizationChecks += 1;
        return true;
      },
    });

    await expect(
      service.resolveOrProvision({
        channel: "telegram",
        channelUserId: "12345",
        orgId: ORG_ID,
      })
    ).resolves.toMatchObject({ userId: "user_admin" });
    expect(authorizationChecks).toBe(1);
    expect(await db.countUsers()).toBe(1);
  });

  test("uses a trusted WhatsApp phone alias as the stable actor identity", async () => {
    const db = await seed();
    const seen: ChannelGuestPrincipalInput[] = [];
    const service = new ChannelGuestPrincipalService(db, {
      authorize: (input) => {
        seen.push(input);
        return true;
      },
    });

    const fromLid = await service.resolveOrProvision({
      channel: "whatsapp",
      channelUserAliases: [WHATSAPP_PHONE],
      channelUserId: WHATSAPP_LID,
      orgId: ORG_ID,
    });
    const fromPhone = await service.resolveOrProvision({
      channel: "whatsapp",
      channelUserAliases: [WHATSAPP_LID],
      channelUserId: WHATSAPP_PHONE,
      orgId: ORG_ID,
    });

    expect(fromPhone.userId).toBe(fromLid.userId);
    expect(seen).toHaveLength(2);
    expect(
      await db.getChannelOrgMapping(ORG_ID, "whatsapp", WHATSAPP_LID)
    ).toMatchObject({ userId: fromLid.userId });
    expect(
      await db.getChannelOrgMapping(ORG_ID, "whatsapp", WHATSAPP_PHONE)
    ).toMatchObject({ userId: fromLid.userId });
  });

  test("fails closed when trusted WhatsApp aliases claim different phones", async () => {
    const db = await seed();
    const service = new ChannelGuestPrincipalService(db, {
      authorize: () => true,
    });

    await expect(
      service.resolveOrProvision({
        channel: "whatsapp",
        channelUserAliases: [WHATSAPP_PHONE, "628122222222@s.whatsapp.net"],
        channelUserId: WHATSAPP_LID,
        orgId: ORG_ID,
      })
    ).rejects.toThrow(/conflicting phone identities/i);
    expect(await db.countUsers()).toBe(1);
  });

  test("fails closed when trusted WhatsApp aliases map to different users", async () => {
    const db = await seed();
    const service = new ChannelGuestPrincipalService(db, {
      authorize: () => true,
    });
    const guest = await service.resolveOrProvision({
      channel: "whatsapp",
      channelUserId: WHATSAPP_PHONE,
      orgId: ORG_ID,
    });
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: WHATSAPP_LID,
      createdAt: new Date().toISOString(),
      orgId: ORG_ID,
      userId: "user_admin",
    });

    await expect(
      service.resolveOrProvision({
        channel: "whatsapp",
        channelUserAliases: [WHATSAPP_PHONE],
        channelUserId: WHATSAPP_LID,
        orgId: ORG_ID,
      })
    ).rejects.toThrow(/conflicting canonical user mappings/i);
    expect(
      await db.getChannelOrgMapping(ORG_ID, "whatsapp", WHATSAPP_PHONE)
    ).toMatchObject({ userId: guest.userId });
    expect(
      await db.getChannelOrgMapping(ORG_ID, "whatsapp", WHATSAPP_LID)
    ).toMatchObject({ userId: "user_admin" });
  });

  test("enforces both the mapping cap and per-window provision rate", async () => {
    const capDb = await seed();
    const capped = new ChannelGuestPrincipalService(capDb, {
      authorize: () => true,
      mappingCap: 1,
    });
    await capped.resolveOrProvision({
      channel: "telegram",
      channelUserId: "1",
      orgId: ORG_ID,
    });
    await expect(
      capped.resolveOrProvision({
        channel: "telegram",
        channelUserId: "2",
        orgId: ORG_ID,
      })
    ).rejects.toThrow(/mapping limit/i);

    let now = 1000;
    const rateDb = await seed();
    const limited = new ChannelGuestPrincipalService(rateDb, {
      authorize: () => true,
      now: () => now,
      provisionRate: 1,
      rateWindowMs: 100,
    });
    await limited.resolveOrProvision({
      channel: "telegram",
      channelUserId: "1",
      orgId: ORG_ID,
    });
    await expect(
      limited.resolveOrProvision({
        channel: "telegram",
        channelUserId: "2",
        orgId: ORG_ID,
      })
    ).rejects.toThrow(/rate limited/i);
    now += 100;
    await expect(
      limited.resolveOrProvision({
        channel: "telegram",
        channelUserId: "2",
        orgId: ORG_ID,
      })
    ).resolves.toMatchObject({ orgRole: "member" });
  });

  test("revalidates Telegram, Discord, and WhatsApp workspace config", async () => {
    const db = await seed();
    await saveTelegramConfig(
      {
        accessMode: "allowlist",
        allowedUserIds: "12345",
        botToken: "telegram-token",
      },
      ORG_ID
    );
    await saveDiscordConfig(
      {
        accessMode: "allowlist",
        allowedUserIds: DISCORD_ALLOWED_ID,
        botToken: "discord-token",
      },
      ORG_ID
    );
    await saveWhatsAppConfig(
      {
        accessMode: "allowlist",
        allowedNumbers: ["628111111111"],
        phoneNumber: "628999999999",
      },
      ORG_ID
    );
    const service = new ChannelGuestPrincipalService(db);

    await expect(
      service.resolveOrProvision({
        channel: "telegram",
        channelUserId: "12345",
        orgId: ORG_ID,
      })
    ).resolves.toMatchObject({ orgRole: "member" });
    await expect(
      service.resolveOrProvision({
        channel: "telegram",
        channelUserId: "54321",
        orgId: ORG_ID,
      })
    ).rejects.toThrow(/not authorized/i);

    await expect(
      service.resolveOrProvision({
        channel: "discord",
        channelUserId: DISCORD_ALLOWED_ID,
        orgId: ORG_ID,
      })
    ).resolves.toMatchObject({ orgRole: "member" });
    await expect(
      service.resolveOrProvision({
        channel: "discord",
        channelUserId: DISCORD_BLOCKED_ID,
        orgId: ORG_ID,
      })
    ).rejects.toThrow(/not authorized/i);

    await expect(
      service.resolveOrProvision({
        channel: "whatsapp",
        channelUserAliases: [WHATSAPP_PHONE],
        channelUserId: WHATSAPP_LID,
        orgId: ORG_ID,
      })
    ).resolves.toMatchObject({ orgRole: "member" });
    await expect(
      service.resolveOrProvision({
        channel: "whatsapp",
        channelUserAliases: ["628122222222@s.whatsapp.net"],
        channelUserId: "254352568283178@lid",
        orgId: ORG_ID,
      })
    ).rejects.toThrow(/not authorized/i);
  });

  test("revokes an existing guest after open mode changes to an allowlist", async () => {
    const db = await seed();
    await saveTelegramConfig(
      {
        accessMode: "open",
        botToken: "telegram-token",
      },
      ORG_ID
    );
    const service = new ChannelGuestPrincipalService(db);

    const guest = await service.resolveOrProvision({
      channel: "telegram",
      channelUserId: "12345",
      orgId: ORG_ID,
    });
    await saveTelegramConfig(
      {
        accessMode: "allowlist",
        allowedUserIds: "54321",
        botToken: "telegram-token",
      },
      ORG_ID
    );

    await expect(
      service.resolveOrProvision({
        channel: "telegram",
        channelUserId: "12345",
        orgId: ORG_ID,
      })
    ).rejects.toThrow(/not authorized/i);
    expect(
      await db.getChannelOrgMapping(ORG_ID, "telegram", "12345")
    ).toMatchObject({ userId: guest.userId });
  });

  test("revokes existing WhatsApp aliases after a denylist addition", async () => {
    const db = await seed();
    await saveWhatsAppConfig(
      {
        accessMode: "open",
        phoneNumber: "628999999999",
      },
      ORG_ID
    );
    const service = new ChannelGuestPrincipalService(db);

    const guest = await service.resolveOrProvision({
      channel: "whatsapp",
      channelUserAliases: [WHATSAPP_PHONE],
      channelUserId: WHATSAPP_LID,
      orgId: ORG_ID,
    });
    await saveWhatsAppConfig(
      {
        accessMode: "denylist",
        blockedNumbers: ["628111111111"],
      },
      ORG_ID
    );

    await expect(
      service.resolveOrProvision({
        channel: "whatsapp",
        channelUserAliases: [WHATSAPP_PHONE],
        channelUserId: WHATSAPP_LID,
        orgId: ORG_ID,
      })
    ).rejects.toThrow(/not authorized/i);
    expect(
      await db.getChannelOrgMapping(ORG_ID, "whatsapp", WHATSAPP_LID)
    ).toMatchObject({ userId: guest.userId });
    expect(
      await db.getChannelOrgMapping(ORG_ID, "whatsapp", WHATSAPP_PHONE)
    ).toMatchObject({ userId: guest.userId });
  });
});
