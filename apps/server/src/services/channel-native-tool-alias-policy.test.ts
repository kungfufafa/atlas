import { expect, test } from "bun:test";
import { dirname } from "node:path";
import {
  getWhatsAppConfigPath,
  rememberWhatsAppLidPhone,
  writePrivateTextFile,
} from "@atlas/core";
import { saveChannelIntegrationPolicy } from "@atlas/core/channel-integration-policy";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { ChannelNativeActionService } from "./channel-native-action-service";
import { IdentityService } from "./identity-service";

setupTestConfigDir("atlas-native-tool-alias-");

const ORG_ID = "org_native_tool_alias";
const PROFILE_ID = "profile_native_tool_alias";
const SESSION_ID = "session_native_tool_alias";
const USER_ID = "user_channel_guest_native_tool_alias";
const PHONE = "628111111111@s.whatsapp.net";
const LID = "154352568283178@lid";

async function createBoundService(): Promise<ChannelNativeActionService> {
  const db = createInMemoryDatabaseAdapter();
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Native tool alias",
    slug: ORG_ID,
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "native-tool-alias@channel-guest.atlas.invalid",
    id: USER_ID,
    isPlatformAdmin: false,
    passwordHash: "!disabled!",
    updatedAt: now,
  });
  await db.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role: "member",
    userId: USER_ID,
  });
  await db.upsertProfile({
    createdAt: now,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Native tool alias",
    orgId: ORG_ID,
    systemPrompt: "",
    updatedAt: now,
  });
  await db.upsertChannelOrgMapping({
    channel: "whatsapp",
    channelUserId: LID,
    createdAt: now,
    orgId: ORG_ID,
    userId: USER_ID,
  });
  await db.upsertSession({
    agentQuestionnaire: null,
    agentTodos: [],
    channel: "whatsapp",
    createdAt: now,
    id: SESSION_ID,
    modelOverride: null,
    orgId: ORG_ID,
    profileId: PROFILE_ID,
    title: null,
    userId: USER_ID,
  });
  await db.upsertTool({
    createdAt: now,
    description: "Knowledge base search",
    handlerConfig: {},
    handlerType: "builtin",
    id: "tool_native_alias_kb",
    name: "knowledge_base_search",
    orgId: ORG_ID,
    updatedAt: now,
  });
  await db.assignToolToProfile(PROFILE_ID, "tool_native_alias_kb");
  const configPath = getWhatsAppConfigPath(ORG_ID);
  await writePrivateTextFile(
    configPath,
    `access_mode=allowlist\nallowed_numbers=628111111111\nprofile_id=${PROFILE_ID}\nphone_number=628999999999\n`,
    { ensureDir: dirname(configPath) }
  );
  await rememberWhatsAppLidPhone(LID, PHONE, ORG_ID);
  const service = new ChannelNativeActionService(db, new IdentityService(db));
  await service.bind(ORG_ID, "whatsapp", {
    channelAddressed: true,
    channelChatId: LID,
    channelIsGroup: false,
    channelUserId: LID,
    sessionId: SESSION_ID,
  });
  return service;
}

test("a phone sender tool policy applies to an existing LID-only binding", async () => {
  const service = await createBoundService();
  expect(
    await service.canGuestSearchKnowledgeBase(
      ORG_ID,
      SESSION_ID,
      PROFILE_ID,
      USER_ID
    )
  ).toBe(true);

  await saveChannelIntegrationPolicy(ORG_ID, "whatsapp", {
    senders: { "628111111111": { allowedTools: ["read_file"] } },
    version: 1,
  });
  await expect(
    service.authorizeTool(
      ORG_ID,
      SESSION_ID,
      "whatsapp",
      "knowledge_base_search"
    )
  ).rejects.toMatchObject({ status: 403 });
  expect(
    await service.canGuestSearchKnowledgeBase(
      ORG_ID,
      SESSION_ID,
      PROFILE_ID,
      USER_ID
    )
  ).toBe(false);
  await expect(
    service.authorizeTool(ORG_ID, SESSION_ID, "whatsapp", "read_file")
  ).resolves.toBeUndefined();

  await saveChannelIntegrationPolicy(ORG_ID, "whatsapp", {
    senders: { [PHONE]: { allowedTools: ["knowledge_base_search"] } },
    version: 1,
  });
  expect(
    await service.canGuestSearchKnowledgeBase(
      ORG_ID,
      SESSION_ID,
      PROFILE_ID,
      USER_ID
    )
  ).toBe(true);
});
