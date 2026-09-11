import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import {
  DEFAULT_WHATSAPP_PROFILE_ID,
  getWhatsAppConfigPath,
  rememberWhatsAppLidPhone,
  saveWhatsAppConfig,
  writePrivateTextFile,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { canGuestSearchKnowledgeBase } from "./channel-guest-knowledge-base-policy";

setupTestConfigDir("atlas-channel-guest-kb-");

const ORG_ID = "org_guest_kb";
const PROFILE_ID = "profile_guest_kb";
const USER_ID = "user_channel_guest_knowledge_base";
const TOOL_ID = "tool_guest_kb";
const PHONE = "628111111111@s.whatsapp.net";
const OTHER_PHONE = "628222222222@s.whatsapp.net";
const LID = "154352568283178@lid";
const NOW = "2026-09-11T00:00:00.000Z";

const input = {
  channel: "whatsapp",
  orgId: ORG_ID,
  profileId: PROFILE_ID,
  userId: USER_ID,
};

async function writeConfig(
  options: {
    allowed?: string;
    blocked?: string;
    mode?: string;
    owner?: string;
    profileId?: string;
  } = {}
): Promise<void> {
  const file = getWhatsAppConfigPath(ORG_ID);
  await writePrivateTextFile(
    file,
    [
      "phone_number=628999999999",
      `profile_id=${options.profileId ?? PROFILE_ID}`,
      `access_mode=${options.mode ?? "allowlist"}`,
      `allowed_numbers=${options.allowed ?? "628111111111"}`,
      `blocked_numbers=${options.blocked ?? ""}`,
      `paired_jid=${options.owner ?? ""}`,
      "",
    ].join("\n"),
    { ensureDir: dirname(file) }
  );
}

async function seedInternalFinanceProfile(
  db: Awaited<ReturnType<typeof seed>>
): Promise<void> {
  await db.upsertProfile({
    createdAt: NOW,
    id: "internal_finance",
    isDefault: false,
    isSuper: false,
    model: null,
    name: "Internal Finance",
    orgId: ORG_ID,
    systemPrompt: "",
    updatedAt: NOW,
  });
  await db.upsertTool({
    createdAt: NOW,
    description: "Finance knowledge",
    handlerConfig: {},
    handlerType: "builtin",
    id: "tool_internal_finance_kb",
    name: "knowledge_base_search",
    orgId: ORG_ID,
    updatedAt: NOW,
  });
  await db.assignToolToProfile("internal_finance", "tool_internal_finance_kb");
}

async function seed(channelUserId = PHONE) {
  const db = createInMemoryDatabaseAdapter();
  await db.upsertOrganization({
    createdAt: NOW,
    id: ORG_ID,
    name: "Guest KB",
    slug: ORG_ID,
    updatedAt: NOW,
  });
  await db.createUser({
    createdAt: NOW,
    email: "guest@channel-guest.atlas.invalid",
    id: USER_ID,
    isPlatformAdmin: false,
    name: "Guest",
    passwordHash: "!disabled!",
    updatedAt: NOW,
  });
  await db.upsertOrgMember({
    createdAt: NOW,
    orgId: ORG_ID,
    role: "member",
    userId: USER_ID,
  });
  await db.upsertProfile({
    createdAt: NOW,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Knowledge assistant",
    orgId: ORG_ID,
    systemPrompt: "",
    updatedAt: NOW,
  });
  await db.upsertTool({
    createdAt: NOW,
    description: "Knowledge base search",
    handlerConfig: {},
    handlerType: "builtin",
    id: TOOL_ID,
    name: "knowledge_base_search",
    orgId: ORG_ID,
    updatedAt: NOW,
  });
  await db.assignToolToProfile(PROFILE_ID, TOOL_ID);
  await db.upsertChannelOrgMapping({
    channel: "whatsapp",
    channelUserId,
    createdAt: NOW,
    orgId: ORG_ID,
    userId: USER_ID,
  });
  await writeConfig();
  return db;
}

describe("WhatsApp guest knowledge base grants", () => {
  test("permits a listed guest and removes access when the whitelist changes", async () => {
    const db = await seed();
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(true);
    expect((await db.getUserById(USER_ID))?.isPlatformAdmin).toBe(false);
    expect(await db.getOrgMember(ORG_ID, USER_ID)).toMatchObject({
      role: "member",
      userId: USER_ID,
    });
    await writeConfig({ allowed: "628222222222" });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
  });

  test("listing still requires current admission and is independent of open admission", async () => {
    const db = await seed();
    await writeConfig({ mode: "open" });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(true);
    await writeConfig({ allowed: "", mode: "open" });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
    await writeConfig({ allowed: "", owner: PHONE });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
    await writeConfig({ blocked: "628111111111", mode: "denylist" });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
    await writeConfig({ mode: "pairing", owner: OTHER_PHONE });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
  });

  test("normalizes device phone identities and formatted whitelist numbers", async () => {
    const db = await seed("628111111111:12@s.whatsapp.net");
    await saveWhatsAppConfig({ allowedNumbers: ["+62 811-1111-111"] }, ORG_ID);
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(true);
  });

  test("requires a trusted phone for LID identities and rejects changed phone aliases", async () => {
    const db = await seed(LID);
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
    await rememberWhatsAppLidPhone(LID, PHONE, ORG_ID);
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(true);
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: PHONE,
      createdAt: NOW,
      orgId: ORG_ID,
      userId: USER_ID,
    });
    await rememberWhatsAppLidPhone(LID, OTHER_PHONE, ORG_ID);
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
  });

  test("rejects normalized aliases mapped to another user", async () => {
    const db = await seed(LID);
    await rememberWhatsAppLidPhone(LID, PHONE, ORG_ID);
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: PHONE,
      createdAt: NOW,
      orgId: ORG_ID,
      userId: "user_someone_else",
    });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
  });

  test("restricts execution eligibility to the supplied bound actor", async () => {
    const db = await seed();
    expect(
      await canGuestSearchKnowledgeBase(db, {
        ...input,
        actor: { channelUserId: OTHER_PHONE },
      })
    ).toBe(false);
    expect(
      await canGuestSearchKnowledgeBase(db, {
        ...input,
        actor: { channelUserAliases: [PHONE], channelUserId: LID },
      })
    ).toBe(true);
    expect(
      await canGuestSearchKnowledgeBase(db, {
        ...input,
        actor: { channelUserAliases: [PHONE], channelUserId: OTHER_PHONE },
      })
    ).toBe(false);
    expect(
      await canGuestSearchKnowledgeBase(db, {
        ...input,
        actor: { channelUserId: "not-a-trusted-identity" },
      })
    ).toBe(false);
  });

  test("does not follow /profile onto another agent with its own knowledge base", async () => {
    const db = await seed();
    await seedInternalFinanceProfile(db);
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(true);
    expect(
      await canGuestSearchKnowledgeBase(db, {
        ...input,
        profileId: "internal_finance",
      })
    ).toBe(false);
  });

  test("resolves an unset Reply-as id to the default profile only", async () => {
    const db = await seed();
    await seedInternalFinanceProfile(db);
    await writeConfig({ profileId: DEFAULT_WHATSAPP_PROFILE_ID });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(true);
    expect(
      await canGuestSearchKnowledgeBase(db, {
        ...input,
        profileId: "internal_finance",
      })
    ).toBe(false);
  });

  test("does not grant another channel, tenant, profile, or unbound identity", async () => {
    const db = await seed();
    for (const change of [
      { channel: "telegram" },
      { channel: "discord" },
      { channel: "web" },
      { orgId: "org_other" },
      { profileId: "profile_other" },
      { userId: "user_paired" },
      { userId: "user_channel_guest_other" },
      { userId: null },
    ]) {
      expect(
        await canGuestSearchKnowledgeBase(db, { ...input, ...change })
      ).toBe(false);
    }
    await db.deleteChannelOrgMapping(ORG_ID, "whatsapp", PHONE);
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
  });

  test("rechecks the built-in assignment and excludes custom namesakes or foreign tools", async () => {
    const db = await seed();
    await db.unassignToolFromProfile(PROFILE_ID, TOOL_ID);
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
    await db.assignToolToProfile(PROFILE_ID, TOOL_ID);
    const tool = (await db.listToolsForProfile(PROFILE_ID))[0]!;
    await db.upsertTool({ ...tool, handlerType: "javascript" });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
    await db.upsertTool({ ...tool, orgId: "org_other" });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
    await db.upsertTool({ ...tool, orgId: null });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(true);
  });

  test("rejects removed membership, viewers, and Super Agent profiles", async () => {
    const db = await seed();
    const member = (await db.getOrgMember(ORG_ID, USER_ID))!;
    await db.upsertOrgMember({ ...member, role: "viewer" });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
    await db.deleteOrgMember(ORG_ID, USER_ID);
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
    await db.upsertOrgMember(member);
    const profile = (await db.getProfileForOrg(PROFILE_ID, ORG_ID))!;
    await db.upsertProfile({ ...profile, isSuper: true });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
    await db.upsertProfile(profile);
    const organization = (await db.getOrganizationById(ORG_ID))!;
    await db.upsertOrganization({ ...organization, archivedAt: NOW });
    expect(await canGuestSearchKnowledgeBase(db, input)).toBe(false);
  });
});
