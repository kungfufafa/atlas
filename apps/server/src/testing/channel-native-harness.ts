import { dirname } from "node:path";
import { createWorkspaceWorkerAuthToken, type ToolContext } from "@atlas/core";
import { saveChannelIntegrationPolicy } from "@atlas/core/channel-integration-policy";
import type { NativeChannel } from "@atlas/core/channel-native-actions";
import { getDiscordConfigPath } from "@atlas/core/discord-config";
import { writePrivateTextFile } from "@atlas/core/fs";
import { getTelegramConfigPath } from "@atlas/core/telegram-config";
import { getWhatsAppConfigPath } from "@atlas/core/whatsapp-config";
import { createSqliteDatabase } from "@atlas/db";
import { createMinimalHonoApp } from "../http/test-app-helpers";
import { AgentService } from "../services/agent-service";
import { ChannelNativeActionService } from "../services/channel-native-action-service";

export async function createNativeChannelHarness(
  channel: NativeChannel,
  timeoutMs = 1000
) {
  const database = await createSqliteDatabase(":memory:");
  const db = database.adapter;
  const orgId = `org_native_${crypto.randomUUID()}`;
  const profileId = `profile_${crypto.randomUUID()}`;
  const userId = `user_${crypto.randomUUID()}`;
  const sessionId = `session_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: orgId,
    name: "Native integration fixture",
    slug: orgId,
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: `${userId}@example.test`,
    id: userId,
    isPlatformAdmin: false,
    passwordHash: "!disabled!",
    updatedAt: now,
  });
  await db.upsertOrgMember({ createdAt: now, orgId, role: "member", userId });
  await db.upsertProfile({
    createdAt: now,
    id: profileId,
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Fixture",
    orgId,
    systemPrompt: "",
    updatedAt: now,
  });
  const channelUserId = {
    discord: "123456789012345678",
    telegram: "123456789",
    whatsapp: "6281111111111@s.whatsapp.net",
  }[channel];
  await db.upsertChannelOrgMapping({
    channel,
    channelUserId,
    createdAt: now,
    orgId,
    userId,
  });
  await db.upsertSession({
    agentQuestionnaire: null,
    agentTodos: [],
    channel,
    createdAt: now,
    id: sessionId,
    modelOverride: null,
    orgId,
    profileId,
    title: null,
    userId,
  });
  const file =
    channel === "whatsapp"
      ? getWhatsAppConfigPath(orgId)
      : channel === "telegram"
        ? getTelegramConfigPath(orgId)
        : getDiscordConfigPath(orgId);
  await writePrivateTextFile(
    file,
    `access_mode=open\nprofile_id=${profileId}\nbot_token=synthetic-no-network\nphone_number=6289999999999\n`,
    { ensureDir: dirname(file) }
  );
  await saveChannelIntegrationPolicy(orgId, channel, { version: 1 });
  await db.upsertTool({
    createdAt: now,
    description: "Native channel fixture",
    handlerConfig: {},
    handlerType: "builtin",
    id: "native_action_fixture",
    name: "channel_action",
    orgId,
    updatedAt: now,
  });
  await db.assignToolToProfile(profileId, "native_action_fixture");
  const agent = new AgentService(null, null, db);
  const service = new ChannelNativeActionService(
    db,
    agent.identityService,
    timeoutMs
  );
  const routeAgent = {
    beginSessionTurn: agent.beginSessionTurn.bind(agent),
    channelNativeActions: service,
    consumeSessionQuestionnaire: agent.consumeSessionQuestionnaire.bind(agent),
    decideChatToolApproval: agent.decideChatToolApproval.bind(agent),
    getUserConfigForOrg: agent.getUserConfigForOrg.bind(agent),
    identityService: agent.identityService,
    prepareAuthenticatedSessionTurnOptions:
      agent.prepareAuthenticatedSessionTurnOptions.bind(agent),
    resolveSession: agent.resolveSession.bind(agent),
    schedulePostTurnSkillReview() {},
    scheduleSessionTitleGeneration() {},
  };
  const { app, authService } = createMinimalHonoApp({
    agent: routeAgent,
    databaseAdapter: db,
  });
  const token = await createWorkspaceWorkerAuthToken({ channel, orgId });
  const actor = {
    channel,
    channelAddressed: true,
    channelChatId: "room-native",
    channelIsGroup: true,
    channelUserId,
    sessionId,
  };
  const context: ToolContext = { channel, orgId, profileId, sessionId, userId };
  const request = (
    path: string,
    body: unknown,
    overrides: { token?: string; orgId?: string; method?: string } = {}
  ) =>
    app.fetch(
      new Request(`http://localhost:4310${path}`, {
        headers: {
          authorization: `Bearer ${overrides.token ?? token}`,
          "content-type": "application/json",
          "x-org-id": overrides.orgId ?? orgId,
        },
        method: overrides.method ?? "POST",
        ...(overrides.method === "GET" ? {} : { body: JSON.stringify(body) }),
      })
    );
  return {
    actor,
    agent,
    app,
    authService,
    context,
    database,
    db,
    orgId,
    profileId,
    request,
    routeAgent,
    service,
    sessionId,
    token,
    userId,
  };
}
