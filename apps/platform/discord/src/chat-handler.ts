import { isDeepStrictEqual } from "node:util";
import type { AtlasClient, RemoteChatSession } from "@atlas/client";
import {
  type ChannelArtifactRef,
  channelArtifactRefFromArtifact,
  isAttachOnlyCommand,
} from "@atlas/core";
import { hasActiveAgentQuestionnaire } from "@atlas/core/agent-questionnaire";
import {
  type ChannelOrgStore,
  findOrgBySelectionInput,
  formatOrgSelectionPrompt,
  formatOrgSwitchConfirmation,
  prepareChannelOrgContext,
} from "@atlas/core/channel-org";
import { ChannelRateLimiter } from "@atlas/core/channel-rate-limiter";
import type {
  AgentQuestionnaire,
  SendMessageInput,
} from "@atlas/core/contract";
import {
  throwIfSignalAborted,
  waitForAbortable,
} from "@atlas/core/download-deadline";
import { saveInboundWorkspaceDocument } from "@atlas/core/inbound-document";
import {
  filterProfilesForChatAccess,
  formatProfileSelectionPrompt,
  formatProfileSwitchConfirmation,
  isProfileSelectionIndexInput,
  type ProfileScope,
  pickProfileForOrg,
  resolveProfileInput,
  resolveProfileInScopes,
} from "@atlas/core/profiles";
import type {
  ChatInputCommandInteraction,
  Message,
  TextBasedChannel,
  ThreadChannel,
} from "discord.js";
import { ChannelType } from "discord.js";
import {
  clearActiveStream,
  isAbortError,
  registerActiveStream,
  stopActiveStream,
} from "./active-stream";
import {
  ATTACH_COMMAND_WITH_FILE_REPLY,
  buildDiscordAttachmentInput,
  hasDiscordAttachments,
  PAIRING_MEDIA_REPLY,
  UNSUPPORTED_MEDIA_REPLY,
} from "./attachments";
import type { DiscordAuthStore } from "./auth-store";
import {
  deliverDiscordTurnArtifactShares,
  maybeSendRequestedDiscordArtifactAttachment,
  uploadDiscordArtifactFromToolResult,
} from "./channel-artifact-flow";
import { isChannelDebugEnabled } from "./channel-log";
import type { DiscordBridgeConfig } from "./config";
import { formatError, formatHelpText, splitDiscordMessage } from "./format";
import {
  type DiscordBotInfo,
  explainGuildMessageHandling,
  isDiscordGuildMessage,
  isDiscordGuildMessageAddressed,
  isDiscordThreadMessage,
  looksLikeHandshakeAttempt,
  parseTextCommand,
  resolveBotInfo,
  resolveChannelOrgKey,
  resolveConversationKey,
  resolveMentionedBotRoleIds,
  resolveOrgChannelId,
  stripBotMention,
} from "./guild-message";
import { isIgnorableInteractionError } from "./interaction-errors";
import {
  createDiscordMessenger,
  createInteractionMessenger,
  type DiscordMessenger,
  getMessageChannel,
  replyAsChat,
  trackDiscordMessages,
} from "./messenger";
import {
  DiscordMessageOwners,
  dispatchDiscordNativeAction,
} from "./native-actions";
import { sendDiscordNativeApproval } from "./native-approval-message";
import {
  type DiscordCallbackBinding,
  DiscordCallbackRegistry,
} from "./native-callbacks";
import { handleDiscordNativeInteraction } from "./native-interaction-handler";
import {
  type DiscordNativeCallback,
  type DiscordNativeInteraction,
  DiscordNativeQuestionnaireMessage,
} from "./native-questionnaire";
import { DiscordQuestionnaireMessage } from "./questionnaire-message";
import type { SessionStore } from "./session-store";
import type { ThreadStore } from "./thread-store";
import { DiscordTodoStatusMessage } from "./todo-status-message";
import { createTypingLoop } from "./typing-indicator";
import { DiscordVoiceSessions } from "./voice-session";

const chatLocks = new Map<string, Promise<void>>();
const rateLimiter = new ChannelRateLimiter();
const MAX_MESSAGE_LENGTH = 2000;
const pendingQuestionnaires = new Map<string, AgentQuestionnaire>();
const THREAD_OWNERSHIP_LOCK_KEY = "__discord_thread_ownership__";

/**
 * Max time a queued message waits for the previous agent run on the same key.
 * Long enough for legitimate multi-minute tool/LLM turns; short enough that a
 * wedged run cannot silence a thread forever. Slash commands bypass this lock.
 */
export const chatLockOptions = {
  waitMs: 15 * 60 * 1000,
};

const GROUP_MESSAGE_PREFIX =
  "[Discord group chat — your reply is visible to everyone with access to this channel or thread.]\n";

/** Posted when tools start before the model wrote any status text. */
const DISCORD_EARLY_ACK_FALLBACK = "On it.";

const DISCORD_LIVE_REPLY_STATUS_INTERVAL_MS = 900;
const DISCORD_LIVE_REPLY_PREVIEW_LENGTH = 280;
const DISCORD_LIVE_WORKING_LABEL = "🤖 Working...";
const DISCORD_LIVE_TOOL_LABEL = "🛠️ Running a tool...";

const LINK_IN_PRIVATE_REPLY =
  "Link your account in a private DM with this bot first.";

const PAIRING_PROMPT =
  "Welcome to Atlas.\n\n" +
  "Paste your pairing code from Integrations → Discord in the web dashboard. " +
  "You only need to do this once.";

const NO_CODE_PROMPT =
  "This bot is not linked yet.\n\n" +
  "Open Atlas Integrations → Discord, save your bot token, and copy the pairing code. " +
  "Then send that code here in a DM.";

const ALLOW_NOT_AUTHORIZED = "You are not authorized to use this command.";

export interface ChatHandlerDeps {
  authStore: DiscordAuthStore;
  client: AtlasClient;
  config: DiscordBridgeConfig;
  fixedWorkspaceId?: string;
  getBotInfo?: () => DiscordBotInfo | undefined;
  getDiscordClient?: () => import("discord.js").Client<true> | undefined;
  orgStore: ChannelOrgStore;
  sessionStore: SessionStore;
  threadStore: ThreadStore;
}

export function createChatHandler(deps: ChatHandlerDeps) {
  const {
    client,
    config,
    authStore,
    sessionStore,
    threadStore,
    orgStore,
    fixedWorkspaceId,
    getBotInfo = () => undefined,
    getDiscordClient = () => undefined,
  } = deps;
  const helpText = formatHelpText({
    workspaceLocked: Boolean(fixedWorkspaceId),
  });
  const nativeCallbacks = new DiscordCallbackRegistry<DiscordNativeCallback>();
  const nativeMessageOwners = new DiscordMessageOwners();
  let voiceSessions: DiscordVoiceSessions | undefined;
  const nativeRooms = new Map<
    string,
    {
      channelChatId: string;
      channelThreadId?: string;
      channelIsGroup: boolean;
      channelAddressed: boolean;
    }
  >();

  return {
    closeVoice: () => voiceSessions?.close(),
    handleMessage: (message: Message) =>
      client.isolateOrgId(() => handleMessageWithTerminalError(message)),
    handleNativeInteraction: (interaction: DiscordNativeInteraction) =>
      client.isolateOrgId(() =>
        handleDiscordNativeInteraction({
          authorize: (binding, callback) =>
            authorizeNativeCallback(binding, callback.questionnaireSnapshot),
          interaction,
          registry: nativeCallbacks,
        })
      ),
    handleSlashCommand: (interaction: ChatInputCommandInteraction) =>
      client.isolateOrgId(() => handleSlashCommand(interaction)),
    recheckVoice: async (guildId: string) =>
      await voiceSessions?.recheck(guildId),
  };

  function getVoiceSessions(): DiscordVoiceSessions {
    if (voiceSessions) {
      return voiceSessions;
    }
    const discord = getDiscordClient();
    if (!discord) {
      throw new Error("Discord voice transport is unavailable");
    }
    voiceSessions = new DiscordVoiceSessions({
      authorize: (binding) =>
        client.isolateOrgId(() => authorizeNativeCallback(binding)),
      client,
      discord,
      runTurn: (binding, text, signal) =>
        client.isolateOrgId(async () => {
          client.setOrgId(binding.orgId);
          return await withChatLock(binding.conversationKey, async () => {
            await authorizeNativeCallback(binding);
            const channel = await discord.channels.fetch(binding.channelId, {
              force: true,
            });
            if (!channel?.isTextBased()) {
              throw new Error("Discord voice conversation is unavailable");
            }
            let reply = "";
            await handleChatMessage(
              channel,
              binding.conversationKey,
              createDiscordMessenger(channel),
              text,
              true,
              false,
              binding.channelAddressed,
              undefined,
              binding.channelUserId,
              binding.channelOrgKey,
              signal,
              (text) => {
                reply = text;
              }
            );
            return reply;
          });
        }),
      status: async (binding, text) => {
        const channel = await discord.channels.fetch(binding.channelId, {
          force: true,
        });
        if (channel?.isSendable()) {
          await channel.send({ allowedMentions: { parse: [] }, content: text });
        }
      },
    });
    return voiceSessions;
  }

  async function handleVoiceCommand(
    interaction: ChatInputCommandInteraction,
    channelOrgKey: string,
    sessionKey: string,
    messenger: DiscordMessenger
  ): Promise<void> {
    const orgId =
      fixedWorkspaceId ?? getOrgSelection(orgStore, channelOrgKey)?.orgId;
    const discord = getDiscordClient();
    if (!(interaction.guildId && orgId && discord)) {
      throw new Error(
        "Discord voice requires a workspace-linked server conversation"
      );
    }
    if (interaction.commandName === "voice_leave") {
      const left = voiceSessions?.leave(
        interaction.guildId,
        interaction.user.id,
        orgId
      );
      await messenger.send(
        left
          ? "Left your voice session."
          : "You do not own an active voice session in this server."
      );
      return;
    }
    const voice = getVoiceSessions();
    voice.assertCanJoin(interaction.guildId);
    const guild = await discord.guilds.fetch(interaction.guildId);
    const voiceState = await guild.voiceStates.fetch(interaction.user.id, {
      force: true,
    });
    const channel = voiceState.channelId
      ? await discord.channels.fetch(voiceState.channelId, { force: true })
      : null;
    if (channel?.type !== ChannelType.GuildVoice) {
      throw new Error("Join a regular voice channel before using this command");
    }
    const voiceKey = resolveDiscordSessionKey(
      `voice:${guild.id}:${channel.id}`,
      interaction.user.id,
      true
    );
    const voiceOrgKey = resolveChannelOrgKey(
      channel.id,
      interaction.user.id,
      true
    );
    orgStore.set(voiceOrgKey, orgId);
    await orgStore.save();
    nativeRooms.set(voiceKey, {
      channelAddressed: true,
      channelChatId: channel.id,
      channelIsGroup: true,
    });
    const profileId = await resolveSessionProfileId(
      sessionKey,
      interaction.user.id
    );
    const session = await createAndBindSession(
      voiceKey,
      profileId,
      interaction.user.id
    );
    const binding: DiscordCallbackBinding = {
      channelAddressed: true,
      channelChatId: channel.id,
      channelId: channel.id,
      channelOrgKey: voiceOrgKey,
      channelUserId: interaction.user.id,
      conversationKey: voiceKey,
      guildId: guild.id,
      orgId,
      profileId,
      sessionId: session.id,
    };
    await client.bindChannelActionContext({
      channel: "discord",
      channelAddressed: true,
      channelChatId: channel.id,
      channelIsGroup: true,
      channelUserId: interaction.user.id,
      sessionId: session.id,
    });
    await voice.join(binding, channel);
    await messenger.send(
      "Voice connected. I will listen only to you. Use /voice_leave to disconnect."
    );
  }

  async function authorizeNativeCallback(
    binding: DiscordCallbackBinding,
    questionnaire?: AgentQuestionnaire
  ): Promise<void> {
    await authStore.reload();
    const selectedOrg =
      fixedWorkspaceId ??
      getOrgSelection(orgStore, binding.channelOrgKey)?.orgId;
    const record = sessionStore.get(binding.conversationKey);
    if (
      !authStore.isAuthorized(binding.channelUserId) ||
      selectedOrg !== binding.orgId ||
      record?.sessionId !== binding.sessionId ||
      record.profileId !== binding.profileId ||
      record.channelUserId !== binding.channelUserId ||
      (binding.channelThreadId &&
        !threadStore.hasThreadId(binding.channelThreadId))
    ) {
      throw new Error(
        "Discord callback no longer belongs to the active conversation"
      );
    }
    client.setOrgId(binding.orgId);
    await client.authorizeChannelPrincipal({
      channel: "discord",
      channelAddressed: binding.channelAddressed,
      channelChatId: binding.channelChatId,
      channelIsGroup: binding.guildId !== null,
      channelThreadId: binding.channelThreadId,
      channelUserId: binding.channelUserId,
      intent: "invoke",
      profileId: binding.profileId,
      sessionId: binding.sessionId,
    });
    if (questionnaire) {
      const current = await client.getSessionMessages(binding.sessionId);
      if (!isDeepStrictEqual(current.questionnaire, questionnaire)) {
        throw new Error("Discord questionnaire has been replaced or completed");
      }
    }
  }

  async function handleMessageWithTerminalError(
    message: Message
  ): Promise<void> {
    try {
      await handleMessage(message);
    } catch (error) {
      try {
        const channel = getMessageChannel(message);
        await createDiscordMessenger(channel).send(formatError(error));
      } catch {
        // The channel itself is unavailable, so there is nowhere to reply.
      }
    }
  }

  async function handleMessage(message: Message): Promise<void> {
    if (message.author.bot) {
      return;
    }

    const channel = getMessageChannel(message);
    const messenger = createDiscordMessenger(channel);
    const userId = message.author.id;
    const channelId = message.channel.id;
    const text = message.content?.trim();
    const isGuild = isDiscordGuildMessage(message);
    const isThread = isDiscordThreadMessage(message);
    const botInfo = resolveBotInfo(message, getBotInfo());
    // Ownership is by thread id alone — partial parentId cannot flip this to foreign.
    const botOwnsThread = isThread ? threadStore.hasThreadId(channelId) : false;
    const channelAddressed =
      !isGuild ||
      isDiscordGuildMessageAddressed(message, botInfo, { botOwnsThread });
    const groupDecision = isGuild
      ? explainGuildMessageHandling(message, botInfo, { botOwnsThread })
      : null;

    console.log(
      "[discord] handle",
      groupDecision?.reason ?? (isGuild ? "none" : "dm"),
      isChannelDebugEnabled()
        ? { botId: botInfo?.id, botOwnsThread, channelId, isThread }
        : { botOwnsThread, isThread }
    );

    if (groupDecision && !groupDecision.shouldHandle) {
      console.log("[discord] skip", groupDecision.reason);
      return;
    }

    if (text && text.length > MAX_MESSAGE_LENGTH) {
      await messenger.send(
        "Message is too long (maximum 2,000 characters). Please shorten your message."
      );
      return;
    }

    if (!rateLimiter.isAllowed(userId)) {
      if (rateLimiter.shouldSendCooldownNotice(userId)) {
        await messenger.send(
          "You are sending messages too quickly. Please wait a moment before trying again."
        );
      }
      return;
    }

    const resolvedParentId = isThread
      ? await resolveThreadParentChannelId(message)
      : undefined;
    const parentResolution = resolvedParentId
      ? { parentChannelId: resolvedParentId }
      : undefined;
    const parentChannelId = resolveOrgChannelId(
      message,
      channelId,
      isGuild,
      parentResolution
    );
    // Threads share the parent channel's org selection — do not key by thread id.
    const channelOrgKey = resolveChannelOrgKey(
      parentChannelId,
      userId,
      isGuild
    );
    const conversationKey = resolveConversationKey(
      message,
      channelId,
      isGuild,
      parentResolution
    );
    const sessionKey = resolveDiscordSessionKey(
      conversationKey,
      userId,
      isGuild
    );
    nativeRooms.set(sessionKey, {
      channelAddressed,
      channelChatId: parentChannelId,
      channelIsGroup: isGuild,
      channelThreadId: isThread ? channelId : undefined,
    });

    let isAuthorized = false;
    let fileConfig = authStore.getConfig();
    await withChatLock(sessionKey, async () => {
      await authStore.reload();
      isAuthorized = authStore.isAuthorized(userId);
      fileConfig = authStore.getConfig();
    });

    const isExplicitPairingAttempt = Boolean(
      !isGuild &&
        text &&
        fileConfig?.handshakeCode &&
        looksLikeHandshakeAttempt(text)
    );

    if (isExplicitPairingAttempt && text) {
      await withChatLock(sessionKey, async () => {
        await handlePairing(text, userId, channelOrgKey, sessionKey, messenger);
      });
      return;
    }

    // Thread creation runs outside the agent-stream lock so parallel parent mentions
    // can each open a thread. Agent work locks per conversation/thread key below.
    if (!isAuthorized) {
      console.log(
        isChannelDebugEnabled()
          ? `[discord] unauthorized ${userId}`
          : "[discord] unauthorized"
      );
      if (
        fileConfig?.accessMode === "allowlist" ||
        fileConfig?.accessMode === "denylist"
      ) {
        if (!isGuild) {
          await messenger.send(
            "This assistant is restricted and not authorized for this chat."
          );
        }
        return;
      }

      // Do not reveal pairing state or create reply noise for unlinked guild users.
      if (isGuild) {
        return;
      }

      if (!text) {
        await messenger.send(
          hasDiscordAttachments(message)
            ? PAIRING_MEDIA_REPLY
            : "Send your pairing code as text to link this chat."
        );
        return;
      }

      await withChatLock(sessionKey, async () => {
        await handlePairing(text, userId, channelOrgKey, sessionKey, messenger);
      });
      return;
    }

    if (isGuild && text && looksLikeHandshakeAttempt(text)) {
      await messenger.send(LINK_IN_PRIVATE_REPLY);
      return;
    }

    const command = text?.startsWith("/") ? parseTextCommand(text) : null;
    const bypassOrgGate =
      command === "/help" || command === "/start" || command === "/org";

    const mentionedBotRoleIds = isGuild
      ? resolveMentionedBotRoleIds(message)
      : [];

    if (!bypassOrgGate) {
      const orgGateText =
        isGuild && text && botInfo
          ? stripBotMention(text, botInfo, mentionedBotRoleIds)
          : text;
      const orgReady = await ensureOrgReady(
        messenger,
        channelOrgKey,
        orgGateText
      );
      if (!orgReady) {
        console.log(
          isChannelDebugEnabled()
            ? `[discord] skip org-gate ${channelOrgKey}`
            : "[discord] skip org-gate"
        );
        return;
      }
    }

    if (text && (command === "/org" || command === "/profile")) {
      await withChatLock(sessionKey, async () => {
        await handleTextCommand(
          text,
          command,
          sessionKey,
          channelOrgKey,
          isThread,
          messenger,
          userId
        );
      });
      return;
    }

    if (text && isAttachOnlyCommand(text) && hasDiscordAttachments(message)) {
      await messenger.send(ATTACH_COMMAND_WITH_FILE_REPLY);
      return;
    }

    const hasAttachments = hasDiscordAttachments(message);

    if (!(text || hasAttachments)) {
      await messenger.send(UNSUPPORTED_MEDIA_REPLY);
      return;
    }

    if (
      text?.startsWith("/") &&
      !isAttachOnlyCommand(text) &&
      !hasAttachments
    ) {
      await messenger.send(
        "Use slash commands from Discord's command menu for session control."
      );
      return;
    }

    const strippedText =
      isGuild && botInfo && text
        ? stripBotMention(text, botInfo, mentionedBotRoleIds)
        : (text ?? "");
    const messageText = strippedText.trim();
    if (!(messageText || hasAttachments)) {
      return;
    }

    let replyChannel = channel;
    let replyConversationKey = conversationKey;
    let replySessionKey = sessionKey;
    let replyMessenger = messenger;
    let replyIsThread = isThread;

    const shouldRouteToThread =
      isGuild &&
      !isThread &&
      (groupDecision?.reason === "bot-mention" ||
        groupDecision?.reason === "reply-to-bot" ||
        groupDecision?.reason === "attachment");

    const shouldClaimThread =
      isThread && groupDecision?.reason === "claim-thread";
    if (shouldRouteToThread || shouldClaimThread) {
      try {
        await client.authorizeChannelPrincipal({
          ...nativeRooms.get(sessionKey),
          channel: "discord",
          channelUserId: userId,
          intent: "invoke",
          profileId: await resolveSessionProfileId(sessionKey, userId),
        });
      } catch (error) {
        if (!channelAddressed && hasAttachments) {
          await messenger.send(
            "The file was ignored by this channel's access policy. Mention the bot or ask an admin to check channel access."
          );
          return;
        }
        throw error;
      }
      if (shouldClaimThread) {
        await trackOwnedThread(channelId);
      }
    }

    if (shouldRouteToThread) {
      const thread = await createGuildThread(message, messageText);

      if (thread) {
        replyChannel = thread as unknown as typeof replyChannel;
        replyConversationKey = `g:${channelId}:t:${thread.id}`;
        replySessionKey = resolveDiscordSessionKey(
          replyConversationKey,
          userId,
          true
        );
        replyMessenger = createDiscordMessenger(
          thread as unknown as Parameters<typeof createDiscordMessenger>[0]
        );
        replyIsThread = true;
        console.log(
          isChannelDebugEnabled()
            ? `[discord] thread created ${thread.id}`
            : "[discord] thread created"
        );
      } else {
        console.log("[discord] thread create failed, falling back to channel");
      }
    }

    async function runDiscordTurn(input: {
      attachmentMessage: Message | undefined;
      replyChannel: TextBasedChannel;
      replyConversationKey: string;
      replyIsThread: boolean;
      replyMessenger: DiscordMessenger;
      replySessionKey: string;
      signal: AbortSignal;
    }): Promise<void> {
      console.log(
        "[discord] chat start",
        ...(isChannelDebugEnabled() ? [input.replyConversationKey] : []),
        `messageId=${message.id ?? "unknown"}`,
        `textBytes=${Buffer.byteLength(messageText, "utf8")}`
      );

      await handleChatMessage(
        input.replyChannel,
        input.replySessionKey,
        input.replyMessenger,
        messageText,
        isGuild,
        input.replyIsThread,
        channelAddressed,
        input.attachmentMessage,
        userId,
        channelOrgKey,
        input.signal
      );

      console.log(
        isChannelDebugEnabled()
          ? `[discord] chat done ${input.replyConversationKey}`
          : "[discord] chat done"
      );
    }

    await withChatLock(replySessionKey, async () => {
      const signal = registerActiveStream(replySessionKey);
      try {
        await runDiscordTurn({
          attachmentMessage: hasAttachments ? message : undefined,
          replyChannel,
          replyConversationKey,
          replyIsThread,
          replyMessenger,
          replySessionKey,
          signal,
        });
      } catch (error) {
        await replyMessenger
          .send(isAbortError(error) ? "Stopped." : formatError(error))
          .catch(() => undefined);
      } finally {
        clearActiveStream(replySessionKey, signal);
      }
    });
  }

  async function createGuildThread(
    message: Message,
    messageText: string
  ): Promise<ThreadChannel | null> {
    let thread: ThreadChannel;
    try {
      thread = await message.startThread({
        autoArchiveDuration: 1440,
        name: deriveThreadName(messageText),
      });
    } catch (error) {
      console.error(
        "Failed to create Discord thread; falling back to channel reply:",
        error
      );
      return null;
    }

    await trackOwnedThread(thread.id);
    return thread;
  }

  /**
   * Register ownership in memory first, then persist. Save failures must not
   * leave a live Discord thread untracked (that yields permanent foreign-thread drops).
   */
  async function trackOwnedThread(threadId: string): Promise<void> {
    // Brief lock so concurrent ownership saves do not drop a newly created id.
    await withChatLock(THREAD_OWNERSHIP_LOCK_KEY, async () => {
      threadStore.add(threadId);
      try {
        await threadStore.save();
      } catch (error) {
        console.error(
          isChannelDebugEnabled()
            ? `Failed to persist Discord thread ownership for ${threadId}; keeping in-memory tracking:`
            : "Failed to persist Discord thread ownership; keeping in-memory tracking:",
          error
        );
      }
    });
  }

  async function handleCloseThread(
    interaction: ChatInputCommandInteraction,
    conversationKey: string,
    messenger: DiscordMessenger
  ): Promise<void> {
    const channel = interaction.channel;

    if (!channel?.isThread()) {
      await messenger.send("Use /close inside a bot conversation thread.");
      return;
    }

    if (!threadStore.hasThreadId(channel.id)) {
      await messenger.send("I can only close threads I started.");
      return;
    }

    const storedSession = sessionStore.get(conversationKey);
    await client.authorizeChannelPrincipal({
      ...nativeRooms.get(conversationKey),
      channel: "discord",
      channelUserId: interaction.user.id,
      intent: "invoke",
      profileId: storedSession?.profileId,
      sessionId: storedSession?.sessionId,
    });
    stopActiveStream(conversationKey);
    pendingQuestionnaires.delete(conversationKey);

    await withChatLock(THREAD_OWNERSHIP_LOCK_KEY, async () => {
      if (threadStore.deleteByThreadId(channel.id)) {
        await threadStore.save();
      }
    });

    await messenger.send("Thread closed.");

    try {
      if (!channel.archived) {
        await channel.setArchived(true);
      }
    } catch (error) {
      console.error("Failed to archive Discord thread after /close:", error);
      await messenger.send(
        "Couldn't archive the thread. Check the bot's Manage Threads permission."
      );
    }
  }

  async function handleAllowCommand(
    interaction: ChatInputCommandInteraction,
    messenger: DiscordMessenger,
    requesterId: string
  ): Promise<void> {
    if (!authStore.isPaired(requesterId)) {
      await messenger.send(ALLOW_NOT_AUTHORIZED);
      return;
    }

    const targetUser = interaction.options.getUser("user");

    if (!targetUser) {
      await messenger.send("Choose a Discord user to allow.");
      return;
    }

    const result = await client.addDiscordAllowedUser({
      requesterChannelUserId: requesterId,
      targetChannelUserId: targetUser.id,
    });
    await authStore.reload();

    if (!result.ok) {
      await messenger.send(result.message);
      return;
    }

    if (result.alreadyAllowed) {
      await messenger.send(
        `<@${result.userId}> is already on the allowed list.`
      );
      return;
    }

    await messenger.send(`Added <@${result.userId}> to the allowed list.`);
  }

  async function handleAttachCommand(
    interaction: ChatInputCommandInteraction,
    messenger: DiscordMessenger,
    conversationKey: string,
    sessionKey: string,
    userId: string
  ): Promise<void> {
    const channel = interaction.channel;
    if (!channel?.isTextBased()) {
      await messenger.send("This command is unavailable in this channel.");
      return;
    }

    let artifactSessionKey = sessionKey;
    let storedSession = sessionStore.get(sessionKey);
    if (storedSession?.channelUserId?.trim() !== userId) {
      storedSession = undefined;
    }

    if (!storedSession && conversationKey !== sessionKey) {
      const legacySession = sessionStore.get(conversationKey);
      const legacyOwner = legacySession?.channelUserId?.trim();
      if (legacySession && legacyOwner === userId) {
        artifactSessionKey = conversationKey;
        storedSession = legacySession;
      }
    }

    if (!storedSession) {
      await resolveSession(sessionKey, userId);
      storedSession = sessionStore.get(sessionKey);
    }

    const profileId = storedSession?.profileId;
    if (!profileId) {
      await messenger.send("No profile is available for this conversation.");
      return;
    }

    const sent = await maybeSendRequestedDiscordArtifactAttachment({
      attachUserText: "/attach",
      channel,
      channelUserId: userId,
      client,
      conversationKey: artifactSessionKey,
      messenger,
      profileId,
      sessionStore,
    });

    if (sent) {
      await messenger.send("Attached the latest saved artifact.");
    }
  }

  async function handleSlashCommand(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    // Caller (bot.ts) already deferred — do not wait on withChatLock here.
    // Agent replies hold that lock for a long time and would leave commands stuck.

    const userId = interaction.user.id;
    const channelId = interaction.channelId;
    const isGuild = !interaction.channel?.isDMBased();
    const isThread = Boolean(interaction.channel?.isThread());
    let threadParentId =
      isGuild &&
      isThread &&
      interaction.channel &&
      "parentId" in interaction.channel
        ? (interaction.channel.parentId ?? undefined)
        : undefined;
    if (isGuild && isThread && !threadParentId && interaction.channel) {
      threadParentId = await hydrateThreadParentId(interaction.channel);
    }
    const orgChannelId =
      isGuild && isThread ? (threadParentId ?? channelId) : channelId;
    const channelOrgKey = resolveChannelOrgKey(orgChannelId, userId, isGuild);
    const conversationKey = isGuild
      ? isThread
        ? `g:${threadParentId ?? channelId}:t:${interaction.channel!.id}`
        : channelId
      : channelId;
    const sessionKey = resolveDiscordSessionKey(
      conversationKey,
      userId,
      isGuild
    );

    const messenger = createInteractionMessenger(
      (content) => interaction.reply({ content: content.slice(0, 2000) }),
      (content) => interaction.followUp({ content: content.slice(0, 2000) }),
      (content) => interaction.editReply({ content: content.slice(0, 2000) }),
      true
    );
    nativeRooms.set(sessionKey, {
      channelAddressed: true,
      channelChatId: orgChannelId,
      channelIsGroup: isGuild,
      channelThreadId: isThread ? channelId : undefined,
    });

    try {
      await authStore.reload();

      if (!authStore.isAuthorized(userId)) {
        if (!interaction.channel?.isDMBased()) {
          await interaction.deleteReply().catch(() => undefined);
          return;
        }

        if (
          interaction.commandName === "start" ||
          interaction.commandName === "help"
        ) {
          await handlePairingSlash(interaction.commandName, messenger);
          return;
        }

        await messenger.send(PAIRING_PROMPT);
        return;
      }

      if (
        interaction.commandName === "start" ||
        interaction.commandName === "help"
      ) {
        await messenger.send(helpText);
        return;
      }

      if (interaction.commandName === "stop") {
        if (stopActiveStream(sessionKey)) {
          await messenger.send("Stopping…");
        } else {
          await messenger.send("Nothing to stop.");
        }
        return;
      }

      const orgReady = await ensureOrgReady(
        messenger,
        channelOrgKey,
        undefined
      );
      if (!orgReady) {
        return;
      }

      switch (interaction.commandName) {
        case "voice_join":
        case "voice_leave":
          await handleVoiceCommand(
            interaction,
            channelOrgKey,
            sessionKey,
            messenger
          );
          return;
        case "close":
          await handleCloseThread(interaction, sessionKey, messenger);
          return;
        case "allow":
          await handleAllowCommand(interaction, messenger, userId);
          return;
        case "attach": {
          await handleAttachCommand(
            interaction,
            messenger,
            conversationKey,
            sessionKey,
            userId
          );
          return;
        }
        case "clear": {
          stopActiveStream(sessionKey);
          pendingQuestionnaires.delete(sessionKey);
          const session = await resolveSession(sessionKey, userId);
          await session.clear();
          await clearSessionArtifactState(sessionKey);
          await messenger.send("History cleared.");
          return;
        }
        case "compact": {
          stopActiveStream(sessionKey);
          const session = await resolveSession(sessionKey, userId);
          const result = await session.compact({ force: true });
          await messenger.send(
            `Compacted (${result.action}). Messages: ${result.messagesAfter}.`
          );
          return;
        }
        case "new": {
          stopActiveStream(sessionKey);
          pendingQuestionnaires.delete(sessionKey);
          await createAndBindSession(sessionKey, undefined, userId);
          await messenger.send("Started a new conversation.");
          return;
        }
        case "status":
          await replyStatus(messenger, sessionKey, userId);
          return;
        default:
          await messenger.send("Unknown command. Try /help");
      }
    } catch (error) {
      // Finalize the deferred reply so Discord does not stay on "thinking…".
      if (isIgnorableInteractionError(error)) {
        console.warn(
          "Slash command interaction expired before reply could be sent."
        );
        return;
      }

      console.error("Slash command error:", error);
      await messenger.send(formatError(error)).catch(() => {});
    }
  }

  async function handlePairing(
    text: string,
    userId: string,
    channelOrgKey: string,
    sessionKey: string,
    messenger: DiscordMessenger
  ): Promise<void> {
    const command = parseTextCommand(text);
    const fileConfig = authStore.getConfig();
    const hasHandshake = Boolean(fileConfig?.handshakeCode);

    if (command === "/help") {
      await replyChunks(messenger, `${PAIRING_PROMPT}\n\n${helpText}`);
      return;
    }

    if (command === "/start") {
      await messenger.send(hasHandshake ? PAIRING_PROMPT : NO_CODE_PROMPT);
      return;
    }

    if (!hasHandshake) {
      await messenger.send(NO_CODE_PROMPT);
      return;
    }

    if (!looksLikeHandshakeAttempt(text)) {
      await messenger.send(PAIRING_PROMPT);
      return;
    }

    try {
      const result = await authStore.tryPair(
        text,
        userId,
        ({ channelUserId, pairingAssertion, pairingUserId }) =>
          bindPairingPrincipal({
            channelOrgKey,
            channelUserId,
            pairingAssertion,
            pairingUserId,
            sessionKey,
          })
      );
      await messenger.send(result.message);
    } catch (error) {
      console.error("Failed to bind Discord channel principal:", error);
      await messenger.send(
        "Could not link this chat. The pairing code is still active; try again."
      );
    }
  }

  async function bindPairingPrincipal(input: {
    channelOrgKey: string;
    channelUserId: string;
    pairingAssertion: string;
    pairingUserId: string;
    sessionKey: string;
  }): Promise<void> {
    const orgId =
      fixedWorkspaceId ??
      getOrgSelection(orgStore, input.channelOrgKey)?.orgId ??
      undefined;
    if (!orgId) {
      throw new Error(
        "Discord pairing requires an authoritative workspace context."
      );
    }
    const principal = await client.bindChannelPrincipal({
      channel: "discord",
      channelUserId: input.channelUserId,
      expectedUserId: input.pairingUserId,
      pairingAssertion: input.pairingAssertion,
    });
    if (principal.orgId !== orgId || principal.userId !== input.pairingUserId) {
      throw new Error(
        "Discord pairing principal did not match the pending authorization."
      );
    }

    const invalidatedSessionKeys = new Set(
      sessionStore.deleteByChannelUserId(input.channelUserId)
    );
    if (sessionStore.get(input.sessionKey)) {
      sessionStore.delete(input.sessionKey);
      invalidatedSessionKeys.add(input.sessionKey);
    }
    for (const invalidatedSessionKey of invalidatedSessionKeys) {
      stopActiveStream(invalidatedSessionKey);
      pendingQuestionnaires.delete(invalidatedSessionKey);
    }
    await sessionStore.save();
  }

  async function handlePairingSlash(
    command: string,
    messenger: DiscordMessenger
  ): Promise<void> {
    const hasHandshake = Boolean(authStore.getConfig()?.handshakeCode);

    if (command === "help") {
      await replyChunks(messenger, `${PAIRING_PROMPT}\n\n${helpText}`);
      return;
    }

    await messenger.send(hasHandshake ? PAIRING_PROMPT : NO_CODE_PROMPT);
  }

  async function handleTextCommand(
    text: string,
    command: string,
    conversationKey: string,
    channelOrgKey: string,
    isThread: boolean,
    messenger: DiscordMessenger,
    userId: string
  ): Promise<void> {
    if (command === "/org") {
      await handleOrgCommand(text, channelOrgKey, conversationKey, messenger);
      return;
    }

    if (command === "/profile") {
      await handleProfileCommand(
        text,
        conversationKey,
        channelOrgKey,
        isThread,
        messenger,
        userId
      );
    }
  }

  async function tryBuildAttachmentInput(
    message: Message,
    messenger: DiscordMessenger,
    caption: string,
    signal: AbortSignal,
    sessionId: string,
    workspace: {
      orgId?: string;
      profileId?: string;
      channelUserId: string;
      origin: {
        channelChatId: string;
        channelThreadId?: string;
        channelIsGroup: boolean;
        channelAddressed: boolean;
      };
    }
  ): Promise<SendMessageInput | "reject" | null> {
    if (!hasDiscordAttachments(message)) {
      return null;
    }

    try {
      await waitForAbortable(
        client.authorizeChannelPrincipal({
          ...workspace.origin,
          channel: "discord",
          channelUserId: workspace.channelUserId,
          intent: "files",
          profileId: workspace.profileId,
          sessionId,
        }),
        signal
      );
      const result = await buildDiscordAttachmentInput(message, {
        caption,
        saveInboundDocument: async (file) => {
          throwIfSignalAborted(signal);
          const { orgId, profileId } = workspace;
          if (!(orgId && profileId)) {
            throw new Error(
              "Select a workspace and profile before saving a file."
            );
          }
          await waitForAbortable(
            client.authorizeChannelPrincipal({
              ...workspace.origin,
              channel: "discord",
              channelUserId: workspace.channelUserId,
              intent: "files",
              profileId,
              sessionId,
            }),
            signal
          );
          throwIfSignalAborted(signal);
          return saveInboundWorkspaceDocument({
            bytes: file.bytes,
            filename: file.filename,
            orgId,
            profileId,
          });
        },
        signal,
        transcribeAudio: (input) =>
          client.transcribeAudio({ ...input, sessionId }),
      });

      if (!result) {
        return null;
      }

      if (result.kind === "reject") {
        await messenger.send(result.message);
        return "reject";
      }

      return result.input;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      await messenger.send("Could not download that file. Try again.");
      return "reject";
    }
  }

  async function handleChatMessage(
    channel: TextBasedChannel,
    conversationKey: string,
    transport: DiscordMessenger,
    attachUserText: string,
    isGuild: boolean,
    isThread: boolean,
    channelAddressed: boolean,
    attachmentMessage: Message | undefined,
    authorUserId: string,
    channelOrgKey: string,
    signal?: AbortSignal,
    onReply?: (reply: string) => void,
    expectedQuestionnaire?: AgentQuestionnaire
  ): Promise<void> {
    let nativeBinding: DiscordCallbackBinding | undefined;
    const messenger = trackDiscordMessages(transport, (messageId) => {
      if (nativeBinding) {
        nativeMessageOwners.record(messageId, nativeBinding);
      }
    });
    const activeSignal = signal ?? registerActiveStream(conversationKey);
    const ownsSignal = signal === undefined;
    const typingLoop = createTypingLoop(messenger);
    const todoStatus = new DiscordTodoStatusMessage(messenger);
    let questionnaireStatus:
      | DiscordQuestionnaireMessage
      | DiscordNativeQuestionnaireMessage = new DiscordQuestionnaireMessage(
      messenger
    );
    const liveReply = createDiscordLiveReply(messenger);
    let reply = "";
    let earlyAck = false;
    let postedQuestionnaire = false;
    const pendingArtifactUploads: Promise<unknown>[] = [];
    const uploadedArtifactPaths = new Set<string>();
    const streamedArtifacts = new Map<string, ChannelArtifactRef>();
    let profileId: string | undefined;
    let session: RemoteChatSession | undefined;
    const nativeParentId = channel.isThread()
      ? (channel.parentId ?? (await hydrateThreadParentId(channel)))
      : undefined;
    nativeRooms.set(conversationKey, {
      channelAddressed,
      channelChatId: nativeParentId ?? channel.id,
      channelIsGroup: isGuild,
      channelThreadId: isThread ? channel.id : undefined,
    });

    try {
      const activeSession = await waitForAbortable(
        resolveSession(conversationKey, authorUserId),
        activeSignal
      );
      session = activeSession;
      profileId = sessionStore.get(conversationKey)?.profileId;
      const orgId =
        fixedWorkspaceId ?? getOrgSelection(orgStore, channelOrgKey)?.orgId;
      const parentId = nativeParentId;
      if (!(orgId && profileId) || (channel.isThread() && !parentId)) {
        throw new Error("Discord native conversation context is unavailable");
      }
      nativeBinding = {
        channelAddressed,
        channelChatId: parentId ?? channel.id,
        channelId: channel.id,
        channelOrgKey,
        channelThreadId: channel.isThread() ? channel.id : undefined,
        channelUserId: authorUserId,
        conversationKey,
        guildId: "guildId" in channel ? channel.guildId : null,
        orgId,
        profileId,
        sessionId: activeSession.id,
      };
      const turnBinding = nativeBinding;
      nativeCallbacks.revokeSession(activeSession.id);
      await client.bindChannelActionContext({
        channel: "discord",
        channelAddressed,
        channelChatId: nativeBinding.channelChatId,
        channelIsGroup: isGuild,
        channelThreadId: nativeBinding.channelThreadId,
        channelUserId: authorUserId,
        sessionId: activeSession.id,
      });
      if (messenger.sendComponents && messenger.editComponents) {
        questionnaireStatus = new DiscordNativeQuestionnaireMessage({
          binding: turnBinding,
          isCurrent: (id) =>
            pendingQuestionnaires.get(conversationKey)?.id === id,
          messenger,
          onAnswer: async (message, questionnaire) =>
            await withChatLock(conversationKey, async () => {
              await authorizeNativeCallback(turnBinding, questionnaire);
              let completed = false;
              await handleChatMessage(
                channel,
                conversationKey,
                messenger,
                message,
                isGuild,
                isThread,
                turnBinding.channelAddressed,
                undefined,
                authorUserId,
                channelOrgKey,
                undefined,
                () => {
                  completed = true;
                },
                questionnaire
              );
              if (!completed) {
                throw new Error("Questionnaire answer was not accepted");
              }
            }),
          registry: nativeCallbacks,
        });
      }

      // `/attach` remains a non-LLM shortcut. Natural-language sends use the
      // send_discord_artifact tool from the agent turn.
      if (profileId && isAttachOnlyCommand(attachUserText)) {
        await waitForAbortable(
          maybeSendRequestedDiscordArtifactAttachment({
            attachUserText,
            channel,
            channelAddressed,
            channelUserId: authorUserId,
            client,
            conversationKey,
            messenger,
            profileId,
            sessionStore,
          }),
          activeSignal
        );
        return;
      }

      const attachmentInput = attachmentMessage
        ? await tryBuildAttachmentInput(
            attachmentMessage,
            messenger,
            attachUserText,
            activeSignal,
            activeSession.id,
            {
              channelUserId: authorUserId,
              orgId:
                fixedWorkspaceId ??
                getOrgSelection(orgStore, channelOrgKey)?.orgId,
              origin: nativeRooms.get(conversationKey)!,
              profileId,
            }
          )
        : null;
      if (attachmentInput === "reject") {
        return;
      }

      // Forward free text to the agent — do not gate Discord replies on questionnaire parsing.
      const streamInput = withGroupContext(
        {
          documents: attachmentInput?.documents,
          expectedQuestionnaire,
          images: attachmentInput?.images,
          message: attachmentInput?.message ?? attachUserText,
        },
        isGuild
      );

      typingLoop.start();

      reply = await activeSession.sendStream(
        streamInput,
        {
          onApprovalRequested: (approval) => {
            pendingArtifactUploads.push(
              sendDiscordNativeApproval({
                approval,
                binding: turnBinding,
                decide: (decision) =>
                  client.decideChannelApproval({
                    approvalId: approval.id,
                    channel: "discord",
                    channelAddressed: turnBinding.channelAddressed,
                    channelChatId: turnBinding.channelChatId,
                    channelIsGroup: isGuild,
                    channelThreadId: turnBinding.channelThreadId,
                    channelUserId: authorUserId,
                    decision,
                    profileId,
                    sessionId: activeSession.id,
                  }),
                messenger,
                registry: nativeCallbacks,
              }).catch(() => {
                stopActiveStream(conversationKey);
              })
            );
          },
          onArtifactCreated: (artifact) => {
            const ref = channelArtifactRefFromArtifact(artifact);
            if (ref) {
              streamedArtifacts.set(ref.path, ref);
            }
          },
          onChannelActionRequested: (request) => {
            const discord = getDiscordClient();
            const action = discord
              ? dispatchDiscordNativeAction(
                  {
                    binding: turnBinding,
                    client,
                    discord,
                    inboundMessageId: attachmentMessage?.id,
                    owners: nativeMessageOwners,
                    reauthorize: async (action) => {
                      await authorizeNativeCallback(turnBinding);
                      await client.authorizeChannelPrincipal({
                        channel: "discord",
                        channelAddressed: turnBinding.channelAddressed,
                        channelChatId: turnBinding.channelChatId,
                        channelIsGroup: isGuild,
                        channelThreadId: turnBinding.channelThreadId,
                        channelUserId: authorUserId,
                        intent: "invoke",
                        nativeAction: action.kind,
                        profileId: turnBinding.profileId,
                        sessionId: activeSession.id,
                      });
                    },
                    signal: activeSignal,
                    threadStore,
                  },
                  request
                )
              : Promise.reject(new Error("Discord transport is unavailable"));
            pendingArtifactUploads.push(
              action
                .then((receipt) => {
                  if (
                    request.action.kind === "send_media" &&
                    (receipt.status === "accepted" ||
                      receipt.status === "unknown")
                  ) {
                    uploadedArtifactPaths.add(request.action.path);
                    uploadedArtifactPaths.add(
                      request.action.path.replace(/^artifacts\//, "")
                    );
                  }
                })
                .catch(() => {
                  stopActiveStream(conversationKey);
                })
            );
          },
          onChunk: (delta) => {
            reply += delta;
            liveReply.updateFromReply(reply);
          },
          onQuestionnaireUpdated: (questionnaire) => {
            typingLoop.ping();
            if (hasActiveAgentQuestionnaire(questionnaire)) {
              postedQuestionnaire = true;
              pendingQuestionnaires.set(conversationKey, questionnaire!);
              pendingArtifactUploads.push(
                questionnaireStatus.update(questionnaire).catch(() => {
                  stopActiveStream(conversationKey);
                })
              );
            } else {
              pendingQuestionnaires.delete(conversationKey);
              questionnaireStatus.clear();
            }
          },
          onThinking: () => {
            typingLoop.ping();
            liveReply.updateWorking();
          },
          onTodosUpdated: (todos) => {
            typingLoop.ping();
            void todoStatus.update(todos);
          },
          onToolEnd: (event) => {
            typingLoop.ping();
            if (!(profileId && event.tool === "send_discord_artifact")) {
              return;
            }

            pendingArtifactUploads.push(
              (async () => {
                const path = await uploadDiscordArtifactFromToolResult({
                  channel,
                  channelAddressed,
                  channelUserId: authorUserId,
                  client,
                  messenger,
                  profileId,
                  result: event.result,
                  sessionId: activeSession.id,
                });
                if (path) {
                  uploadedArtifactPaths.add(path);
                }
              })()
            );
          },
          onToolStart: () => {
            typingLoop.ping();
            if (earlyAck) {
              liveReply.updateTooling();
              return;
            }

            if (liveReply.hasStatusMessage()) {
              liveReply.updateTooling();
              earlyAck = true;
              return;
            }

            if (reply.trim()) {
              liveReply.postStatus(reply);
              earlyAck = true;
              return;
            }

            const earlyText = reply.trim() || DISCORD_EARLY_ACK_FALLBACK;
            liveReply.postStatus(earlyText);
            earlyAck = true;
          },
        },
        { signal: activeSignal }
      );

      await Promise.all(pendingArtifactUploads);
      await todoStatus.complete();

      if (activeSignal.aborted) {
        if (reply.trim()) {
          if (!(await liveReply.replaceWithFinal(reply))) {
            await replyAsChat(messenger, reply);
          }
          await messenger.send("Stopped.");
        } else if (!(await liveReply.replaceWithFinal("Stopped."))) {
          await messenger.send("Stopped.");
        }
        return;
      }
    } catch (error) {
      if (isAbortError(error)) {
        await todoStatus.stop();
        if (reply.trim()) {
          if (!(await liveReply.replaceWithFinal(reply))) {
            await replyAsChat(messenger, reply);
          }
          await messenger.send("Stopped.");
        } else if (!(await liveReply.replaceWithFinal("Stopped."))) {
          await messenger.send("Stopped.");
        }
        return;
      }

      await todoStatus.fail();
      if (!(await liveReply.replaceWithError(formatError(error)))) {
        await messenger.send(formatError(error));
      }
      return;
    } finally {
      if (ownsSignal) {
        clearActiveStream(conversationKey, activeSignal);
      }
      typingLoop.stop();
    }

    onReply?.(reply);
    if (reply.trim()) {
      if (!(await liveReply.replaceWithFinal(reply))) {
        await replyAsChat(messenger, reply);
      }
    } else if (liveReply.hasStatusMessage() || earlyAck) {
      const terminalText = postedQuestionnaire
        ? "Waiting for your answers."
        : "(empty reply)";
      if (!(await liveReply.replaceWithFinal(terminalText))) {
        await messenger.send(terminalText);
      }
    } else if (!postedQuestionnaire) {
      await messenger.send("(empty reply)");
    }

    if (profileId && session) {
      await deliverDiscordTurnArtifactShares({
        channel,
        channelAddressed,
        channelUserId: authorUserId,
        client,
        conversationKey,
        messenger,
        profileId,
        session,
        sessionStore,
        skipPaths: uploadedArtifactPaths,
        streamedArtifacts: [...streamedArtifacts.values()],
      });
    }
  }

  function createDiscordLiveReply(messenger: DiscordMessenger) {
    let statusMessageId: string | null = null;
    let lastStatusText = "";
    let lastStatusAt = 0;
    let statusChain = Promise.resolve();
    let statusSupportsPreview = false;
    let statusRequested = false;

    function requestStatus(
      status: string,
      options: { allowPreview?: boolean } = {}
    ) {
      const now = Date.now();
      const normalized = status.trim();

      if (!normalized || normalized === lastStatusText) {
        return;
      }

      if (now - lastStatusAt < DISCORD_LIVE_REPLY_STATUS_INTERVAL_MS) {
        return;
      }

      lastStatusAt = now;
      lastStatusText = normalized;
      statusRequested = true;
      if (options.allowPreview !== undefined) {
        statusSupportsPreview = options.allowPreview;
      }
      statusChain = statusChain
        .then(() => sendStatus(normalized))
        .catch(() => {});
    }

    async function sendStatus(status: string): Promise<void> {
      if (!status) {
        return;
      }

      try {
        if (statusMessageId === null) {
          const message = await messenger.send(status);
          statusMessageId = message?.id ?? null;
          return;
        }

        await messenger.edit(statusMessageId, status);
      } catch {
        // Status updates are best-effort only.
      }
    }

    async function replaceWithFinal(finalText: string): Promise<boolean> {
      await statusChain;
      if (statusMessageId === null) {
        return false;
      }

      const chunks = splitDiscordMessage(finalText);
      if (chunks.length === 0) {
        return false;
      }

      try {
        await messenger.edit(statusMessageId, chunks[0] ?? "");
        for (const chunk of chunks.slice(1)) {
          await replyAsChat(messenger, chunk);
        }
        return true;
      } catch {
        return false;
      }
    }

    function makeReplyPreview(reply: string): string {
      const trimmed = reply.trim();
      if (!trimmed) {
        return DISCORD_LIVE_WORKING_LABEL;
      }

      const preview = trimmed.slice(0, DISCORD_LIVE_REPLY_PREVIEW_LENGTH);
      const suffix =
        trimmed.length > DISCORD_LIVE_REPLY_PREVIEW_LENGTH ? "…" : "";

      return `${DISCORD_LIVE_WORKING_LABEL}\n\n${preview}${suffix}`;
    }

    async function replaceWithError(errorText: string): Promise<boolean> {
      await statusChain;
      if (statusMessageId === null) {
        return false;
      }

      try {
        await messenger.edit(statusMessageId, `⚠️ ${errorText}`);
        return true;
      } catch {
        return false;
      }
    }

    return {
      hasStatusMessage: (): boolean => statusRequested,
      postStatus: (statusText: string): void => {
        requestStatus(statusText, { allowPreview: false });
      },
      replaceWithError,
      replaceWithFinal,
      updateFromReply: (reply: string): void => {
        if (!statusMessageId) {
          return;
        }

        requestStatus(statusSupportsPreview ? makeReplyPreview(reply) : reply, {
          allowPreview: false,
        });
      },
      updateTooling: (): void => {
        requestStatus(DISCORD_LIVE_TOOL_LABEL, { allowPreview: true });
      },
      updateWorking: (): void => {
        requestStatus(DISCORD_LIVE_WORKING_LABEL, { allowPreview: true });
      },
    };
  }

  async function ensureOrgReady(
    messenger: DiscordMessenger,
    channelOrgKey: string,
    messageText: string | undefined
  ): Promise<boolean> {
    if (fixedWorkspaceId) {
      client.setOrgId(fixedWorkspaceId);
      if (
        getOrgSelection(orgStore, channelOrgKey)?.orgId !== fixedWorkspaceId
      ) {
        orgStore.set(channelOrgKey, fixedWorkspaceId);
        await orgStore.save();
      }
      return true;
    }

    const orgContext = await prepareChannelOrgContext({
      getSelectedOrgId: () => getOrgSelection(orgStore, channelOrgKey)?.orgId,
      listOrgs: () => client.listUserOrgs(),
      saveSelectedOrgId: async (orgId) => {
        orgStore.set(channelOrgKey, orgId);
        await orgStore.save();
      },
      text: messageText?.startsWith("/") ? undefined : messageText,
    });

    if (orgContext.status === "empty") {
      await messenger.send("No organizations are configured yet.");
      return false;
    }

    if (orgContext.status === "prompt") {
      await replyChunks(messenger, orgContext.message);
      return false;
    }

    client.setOrgId(orgContext.orgId);

    if (orgContext.justSelected) {
      await messenger.send(formatOrgSwitchConfirmation(orgContext.orgName));
      return false;
    }

    return true;
  }

  async function handleOrgCommand(
    text: string,
    channelOrgKey: string,
    conversationKey: string,
    messenger: DiscordMessenger
  ): Promise<void> {
    if (fixedWorkspaceId) {
      await messenger.send(
        "This bot belongs to one workspace and cannot switch workspaces."
      );
      return;
    }

    const { orgs } = await client.listUserOrgs();

    if (orgs.length === 0) {
      await messenger.send("No organizations are configured yet.");
      return;
    }

    const arg = text.trim().split(/\s+/).slice(1).join(" ");

    if (!arg) {
      await replyChunks(
        messenger,
        formatOrgSelectionPrompt(
          orgs,
          getOrgSelection(orgStore, channelOrgKey)?.orgId
        )
      );
      return;
    }

    const picked = findOrgBySelectionInput(arg, orgs);

    if (!picked) {
      await messenger.send("Unknown organization. Send /org to see the list.");
      return;
    }

    const previousOrgId = getOrgSelection(orgStore, channelOrgKey)?.orgId;
    orgStore.set(channelOrgKey, picked.id);
    await orgStore.save();
    client.setOrgId(picked.id);

    if (previousOrgId && previousOrgId !== picked.id) {
      pendingQuestionnaires.delete(conversationKey);
      sessionStore.delete(conversationKey);
      await sessionStore.save();
    }

    await messenger.send(formatOrgSwitchConfirmation(picked.name));
  }

  async function handleProfileCommand(
    text: string,
    conversationKey: string,
    channelOrgKey: string,
    isThread: boolean,
    messenger: DiscordMessenger,
    userId: string
  ): Promise<void> {
    const workspaceLocked = Boolean(fixedWorkspaceId);
    const { orgs } = workspaceLocked
      ? { orgs: [] }
      : await client.listUserOrgs();
    const currentOrgId =
      fixedWorkspaceId ?? getOrgSelection(orgStore, channelOrgKey)?.orgId;
    const currentOrg = currentOrgId
      ? orgs.find((org) => org.id === currentOrgId)
      : undefined;
    const arg = text.trim().split(/\s+/).slice(1).join(" ");
    const currentProfileId = await resolveSessionProfileId(
      conversationKey,
      userId
    );

    if (!arg) {
      const profiles = await listSelectableProfiles();

      if (profiles.length === 0) {
        await messenger.send("No profiles are available.");
        return;
      }

      await replyChunks(
        messenger,
        formatProfileSelectionPrompt(
          profiles,
          currentProfileId,
          currentOrg?.name
        )
      );
      return;
    }

    const currentOrgProfiles = currentOrgId
      ? await listSelectableProfiles()
      : [];
    const currentOrgNumericPick =
      currentOrgId &&
      isProfileSelectionIndexInput(arg, currentOrgProfiles.length)
        ? resolveProfileInput(currentOrgProfiles, arg)
        : undefined;
    const currentOrgProfilePick =
      currentOrgId && (isThread || workspaceLocked)
        ? resolveProfileInput(currentOrgProfiles, arg)
        : undefined;
    const resolved =
      currentOrgId && (currentOrgNumericPick || currentOrgProfilePick)
        ? {
            profile: currentOrgNumericPick ?? currentOrgProfilePick!,
            scope: {
              orgId: currentOrgId,
              orgName: currentOrg?.name ?? "Current org",
              profiles: currentOrgProfiles,
            },
          }
        : isThread || workspaceLocked
          ? null
          : resolveProfileInScopes(await listProfileScopes(orgs), arg);

    if (!resolved) {
      await messenger.send("Unknown profile. Send /profile to see the list.");
      return;
    }

    if ("ambiguous" in resolved) {
      await messenger.send(
        workspaceLocked
          ? "Unknown profile. Send /profile to see the list."
          : `That profile exists in multiple orgs (${resolved.ambiguous}). Send /org first, then /profile.`
      );
      return;
    }

    const { scope, profile: picked } = resolved;

    if (scope.orgId !== currentOrgId) {
      if (workspaceLocked) {
        await messenger.send("Unknown profile. Send /profile to see the list.");
        return;
      }

      pendingQuestionnaires.delete(conversationKey);
      orgStore.set(channelOrgKey, scope.orgId);
      await orgStore.save();
      client.setOrgId(scope.orgId);
      sessionStore.delete(conversationKey);
      await sessionStore.save();
    }

    if (picked.id === currentProfileId && scope.orgId === currentOrgId) {
      await messenger.send(`Already using ${picked.name}.`);
      return;
    }

    await createAndBindSession(conversationKey, picked.id, userId);
    const orgNote =
      workspaceLocked || scope.orgId === currentOrgId
        ? ""
        : ` (${scope.orgName})`;
    await messenger.send(
      `${formatProfileSwitchConfirmation(picked.name)}${orgNote}`
    );
  }

  async function listProfileScopes(
    orgs: Array<{ id: string; name: string }>
  ): Promise<ProfileScope[]> {
    const scopes: ProfileScope[] = [];

    for (const org of orgs) {
      const profiles = await listSelectableProfiles(org.id);

      if (profiles.length > 0) {
        scopes.push({ orgId: org.id, orgName: org.name, profiles });
      }
    }

    return scopes;
  }

  async function listSelectableProfiles(orgId?: string) {
    const { profiles } = await client.listProfiles(orgId);
    return filterProfilesForChatAccess(profiles, { excludeSuperAgent: true });
  }

  async function replyStatus(
    messenger: DiscordMessenger,
    chatId: string,
    channelUserId?: string
  ): Promise<void> {
    try {
      const health = await client.health();
      const lines = [
        `Server: ${health.ok ? "ok" : "degraded"}`,
        `Provider configured: ${health.providerConfigured ? "yes" : "no"}`,
      ];

      if (health.providerConfigured) {
        const models = await client.getModels();
        const profiles = await listSelectableProfiles();
        const profileId = await resolveSessionProfileId(chatId, channelUserId);
        const profile = profiles.find((entry) => entry.id === profileId);
        const modelLabel = profile?.model?.includes("::")
          ? profile.model.slice(profile.model.indexOf("::") + 2)
          : (profile?.model ?? "none");
        lines.push(`Profile: ${profile?.name ?? profileId}`);
        lines.push(`Provider: ${models.provider ?? "unknown"}`);
        lines.push(`Model: ${modelLabel}`);
      } else {
        lines.push("Chat runs in offline mode without an API key.");
      }

      await replyChunks(messenger, lines.join("\n"));
    } catch (error) {
      await messenger.send(formatError(error));
    }
  }

  async function resolveSession(
    chatId: string,
    channelUserId: string
  ): Promise<RemoteChatSession> {
    const existing = sessionStore.get(chatId);
    const normalizedChannelUserId = channelUserId?.trim() ?? "";
    const belongsToCurrentSender =
      existing?.channelUserId?.trim() === normalizedChannelUserId;

    if (existing && belongsToCurrentSender) {
      const hot = sessionStore.getHotSession<RemoteChatSession>(chatId);
      if (hot) {
        return hot;
      }

      const session = client.createChatSession(existing.sessionId, "discord");

      try {
        await session.getMessages();
        sessionStore.setHotSession(chatId, session);
        return session;
      } catch {
        // Session missing on server; create a new one below
      }
    }

    return createAndBindSession(chatId, undefined, channelUserId);
  }

  async function createAndBindSession(
    chatId: string,
    profileId: string | undefined,
    channelUserId: string
  ): Promise<RemoteChatSession> {
    pendingQuestionnaires.delete(chatId);
    const principalUserId = channelUserId.trim();
    if (!principalUserId) {
      throw new Error("Discord channel user identity is required.");
    }
    const resolvedProfileId =
      profileId ?? (await resolveSessionProfileId(chatId, principalUserId));
    const session = await client.createSession("discord", {
      externalPrincipal: {
        ...nativeRooms.get(chatId),
        channelUserId: principalUserId,
      },
      profileId: resolvedProfileId,
    });

    sessionStore.set(chatId, {
      channelUserId: principalUserId,
      profileId: resolvedProfileId,
      sessionId: session.id,
      updatedAt: new Date().toISOString(),
    });
    sessionStore.setHotSession(chatId, session);
    await sessionStore.save();

    return session;
  }

  async function resolveSessionProfileId(
    chatId: string,
    channelUserId?: string
  ): Promise<string> {
    const profiles = await listSelectableProfiles();
    const storedProfileId = sessionStore.get(chatId)?.profileId;

    if (storedProfileId) {
      const match = profiles.find((profile) => profile.id === storedProfileId);

      if (match) {
        return match.id;
      }
    }

    // New thread sessions inherit the parent channel's /profile selection.
    const parentChannelId = parentChannelIdFromConversationKey(chatId);
    if (parentChannelId) {
      const parentSessionKey = channelUserId
        ? resolveDiscordSessionKey(parentChannelId, channelUserId, true)
        : parentChannelId;
      const parentProfileId = sessionStore.get(parentSessionKey)?.profileId;
      if (parentProfileId) {
        const match = profiles.find(
          (profile) => profile.id === parentProfileId
        );
        if (match) {
          return match.id;
        }
      }
    }

    return pickProfileForOrg(profiles, config.profileId).id;
  }

  async function clearSessionArtifactState(
    conversationKey: string
  ): Promise<void> {
    const existing = sessionStore.get(conversationKey);
    if (!existing) {
      return;
    }

    sessionStore.set(conversationKey, {
      channelUserId: existing.channelUserId,
      profileId: existing.profileId,
      sessionId: existing.sessionId,
      updatedAt: new Date().toISOString(),
    });
    await sessionStore.save();
  }
}

export function resolveDiscordSessionKey(
  conversationKey: string,
  channelUserId: string,
  isGuild: boolean
): string {
  if (!isGuild) {
    return conversationKey;
  }

  return `${conversationKey}:sender:${encodeURIComponent(channelUserId.trim())}`;
}

function withGroupContext(
  input: SendMessageInput,
  isGuild: boolean
): SendMessageInput {
  if (!isGuild) {
    return input;
  }

  const message = input.message?.trim();

  if (message) {
    return { ...input, message: `${GROUP_MESSAGE_PREFIX}${message}` };
  }

  return { ...input, message: GROUP_MESSAGE_PREFIX.trim() };
}

function deriveThreadName(messageText: string): string {
  const cleaned = messageText.replace(/\s+/g, " ").trim();

  if (!cleaned) {
    return "Atlas chat";
  }

  // Discord thread names are capped at 100 characters.
  if (cleaned.length <= 100) {
    return cleaned;
  }

  const sliced = cleaned.slice(0, 100);
  const lastSpace = sliced.lastIndexOf(" ");

  if (lastSpace > 40) {
    return sliced.slice(0, lastSpace);
  }

  return sliced;
}

function getOrgSelection(
  orgStore: ChannelOrgStore,
  channelOrgKey: string
): { orgId: string } | undefined {
  const record = orgStore.get(channelOrgKey);

  if (!record) {
    return;
  }

  return { orgId: record.orgId };
}

async function replyChunks(
  messenger: DiscordMessenger,
  text: string
): Promise<void> {
  for (const chunk of splitDiscordMessage(text)) {
    await messenger.send(chunk);
  }
}

/** Parent guild channel id from `g:{parent}:t:{thread}` conversation keys. */
function parentChannelIdFromConversationKey(
  chatId: string
): string | undefined {
  const match = /^g:(.+):t:(.+)$/.exec(chatId);
  return match?.[1];
}

/**
 * Hydrate parent guild channel id for thread messages when Discord delivers a
 * partial channel (`Partials.Channel`) without `parentId`. Ownership checks use
 * the thread id alone; this only protects org + conversation keys.
 */
async function resolveThreadParentChannelId(
  message: Message
): Promise<string | undefined> {
  if (!message.channel.isThread()) {
    return;
  }

  if (message.channel.parentId) {
    return message.channel.parentId;
  }

  return hydrateThreadParentId(message.channel);
}

async function hydrateThreadParentId(
  channel: TextBasedChannel | { fetch?: () => Promise<unknown>; id?: string }
): Promise<string | undefined> {
  if (typeof channel.fetch !== "function") {
    return;
  }

  try {
    const fetched = await channel.fetch();
    if (fetched && typeof fetched === "object" && "isThread" in fetched) {
      const thread = fetched as ThreadChannel;
      if (
        typeof thread.isThread === "function" &&
        thread.isThread() &&
        thread.parentId
      ) {
        return thread.parentId;
      }
    }
  } catch (error) {
    const id = "id" in channel ? String(channel.id) : "unknown";
    console.warn(
      isChannelDebugEnabled()
        ? `Failed to hydrate Discord thread parentId for ${id}:`
        : "Failed to hydrate Discord thread parentId:",
      error
    );
  }
}

/**
 * Serialize work per conversation key. Waiting for a prior run is bounded so a
 * hung agent turn cannot queue follow-ups forever; after the wait budget the
 * next message proceeds (concurrent with the wedged run).
 */
export async function withChatLock<T>(
  chatId: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = chatLocks.get(chatId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  chatLocks.set(chatId, gate);

  const waitMs = chatLockOptions.waitMs;
  let timedOut = false;
  if (waitMs > 0) {
    timedOut = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), waitMs);
      previous
        .then(() => {
          clearTimeout(timer);
          resolve(false);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(false);
        });
    });
  } else {
    await previous.catch(() => undefined);
  }

  if (timedOut) {
    console.warn(
      `Chat lock${isChannelDebugEnabled() ? ` for ${chatId}` : ""} exceeded ${waitMs}ms wait; proceeding to recover from a wedged run.`
    );
  }

  try {
    return await fn();
  } finally {
    release();
    if (chatLocks.get(chatId) === gate) {
      chatLocks.delete(chatId);
    }
  }
}

/** @internal Test helper — clears the in-process chat lock map and rate limiter. */
export function resetChatLocksForTests(): void {
  chatLocks.clear();
  rateLimiter.reset();
}

export function getChatLockCountForTests(): number {
  return chatLocks.size;
}
