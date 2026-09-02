import type { AtlasClient, RemoteChatSession } from "@atlas/client";
import {
  type ChannelArtifactRef,
  channelArtifactRefFromArtifact,
  formatMissingAttachArtifactMessage,
} from "@atlas/core";
import {
  type ChannelOrgStore,
  findOrgBySelectionInput,
  formatOrgSelectionPrompt,
  formatOrgSwitchConfirmation,
  prepareChannelOrgContext,
} from "@atlas/core/channel-org";
import { ChannelRateLimiter } from "@atlas/core/channel-rate-limiter";
import type { SendMessageInput } from "@atlas/core/contract";
import { waitForAbortable } from "@atlas/core/download-deadline";
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
import { normalizeHandshakeInput } from "@atlas/core/telegram-config";
import type { Context } from "grammy";
import {
  clearActiveStream,
  isAbortError,
  registerActiveStream,
  stopActiveStream,
} from "./active-stream";
import {
  buildTelegramDocumentInput,
  DOWNLOAD_FAILED_REPLY,
  hasTelegramDocument,
  UNSUPPORTED_MEDIA_REPLY,
} from "./attachments";
import {
  buildTelegramAudioInput,
  formatTelegramAudioError,
  hasTelegramAudio,
} from "./audio";
import type { TelegramAuthStore } from "./auth-store";
import {
  deliverTelegramTurnArtifactShares,
  maybeSendRequestedTelegramArtifactAttachment,
} from "./channel-artifact-flow";
import type { TelegramBridgeConfig } from "./config";
import { formatError, formatHelpText, splitTelegramMessage } from "./format";
import {
  explainGroupMessageHandling,
  isTelegramGroupChat,
  isTelegramTopicMessage,
  parseTelegramSlashCommand,
  resolveBotInfo,
  resolveChannelOrgKey,
  resolveConversationKey,
  stripBotMention,
  type TelegramBotInfo,
} from "./group-message";
import { buildTelegramImageInput } from "./images";
import { replyAsChat } from "./reply";
import {
  createTelegramRichMessenger,
  type TelegramRichMessenger,
} from "./rich-message";
import type { SessionStore } from "./session-store";
import { TelegramTodoStatusMessage } from "./todo-status-message";
import { createTypingLoop } from "./typing-indicator";

const chatLocks = new Map<string, Promise<void>>();
const rateLimiter = new ChannelRateLimiter();
const MAX_MESSAGE_LENGTH = 2000;
const LOCK_TIMEOUT_MS = 120_000;

const GROUP_MESSAGE_PREFIX =
  "[Telegram group — your reply is visible to everyone in this group.]\n";

const LINK_IN_PRIVATE_REPLY =
  "Link your account in a private chat with this bot first.";

const PAIRING_PROMPT =
  "Welcome to Atlas.\n\n" +
  "Paste your pairing code from Integrations → Telegram in the web dashboard. " +
  "You only need to do this once for this chat.";

const NO_CODE_PROMPT =
  "This bot is not linked yet.\n\n" +
  "Open Atlas Integrations → Telegram, save your bot token, and copy the pairing code. " +
  "Then send that code here.";

const TELEGRAM_EARLY_ACK_FALLBACK = "On it.";
const TELEGRAM_LIVE_REPLY_STATUS_INTERVAL_MS = 900;
const TELEGRAM_LIVE_REPLY_PREVIEW_LENGTH = 280;
const TELEGRAM_LIVE_WORKING_LABEL = "🤖 Working...";
const TELEGRAM_LIVE_TOOL_LABEL = "🛠️ Running a tool...";

export interface ChatHandlerDeps {
  authStore: TelegramAuthStore;
  client: AtlasClient;
  config: TelegramBridgeConfig;
  fixedWorkspaceId?: string;
  getBotInfo?: () => TelegramBotInfo | undefined;
  orgStore: ChannelOrgStore;
  sessionStore: SessionStore;
}

export function createChatHandler(deps: ChatHandlerDeps) {
  const {
    client,
    config,
    authStore,
    sessionStore,
    orgStore,
    fixedWorkspaceId,
    getBotInfo = () => undefined,
  } = deps;
  const helpText = formatHelpText({
    workspaceLocked: Boolean(fixedWorkspaceId),
  });

  async function handleMessage(ctx: Context): Promise<void> {
    if (!ctx.chat) {
      return;
    }

    const telegram = createTelegramRichMessenger(ctx);
    const chatId = String(ctx.chat.id);
    const userId = ctx.from?.id;

    if (userId === undefined) {
      return;
    }

    const text = ctx.message?.text?.trim();
    const isGroup = isTelegramGroupChat(ctx);
    const botInfo = resolveBotInfo(ctx, getBotInfo());
    const groupDecision = isGroup
      ? explainGroupMessageHandling(ctx, botInfo)
      : null;

    if (groupDecision && !groupDecision.shouldHandle) {
      const parts = [
        "Ignored Telegram group message",
        `reason=${groupDecision.reason}`,
        `bot=@${botInfo?.username ?? "unknown"}`,
        `messageId=${ctx.message?.message_id ?? "unknown"}`,
        `textBytes=${Buffer.byteLength(text ?? "", "utf8")}`,
      ];
      if (process.env.ATLAS_CH_DEBUG === "1") {
        parts.splice(
          3,
          0,
          `botId=${botInfo?.id ?? "unknown"}`,
          `chatId=${chatId}`,
          `userId=${userId}`
        );
      }
      console.log(parts.join(" "));
      return;
    }

    const channelOrgKey = resolveChannelOrgKey(chatId, userId, isGroup);
    const conversationKey = resolveConversationKey(ctx, chatId, isGroup);
    const channelUserId = String(userId);
    const sessionKey = resolveTelegramSessionKey(
      conversationKey,
      channelUserId,
      isGroup
    );
    const isTopic = isTelegramTopicMessage(ctx);

    if (text && isStopCommand(text, botInfo?.username, isGroup)) {
      await authStore.reload();
      if (!authStore.isAuthorized(userId)) {
        if (isGroup) {
          const fileConfig = authStore.getConfig();
          if (
            fileConfig?.accessMode !== "allowlist" &&
            fileConfig?.accessMode !== "denylist"
          ) {
            await telegram.send(LINK_IN_PRIVATE_REPLY);
          }
        }
        return;
      }

      if (!stopActiveStream(sessionKey)) {
        await telegram.send("Nothing to stop.");
      }

      return;
    }

    if (text && text.length > MAX_MESSAGE_LENGTH) {
      await telegram.send(
        "Message is too long (maximum 2,000 characters). Please shorten your message."
      );
      return;
    }

    if (!rateLimiter.isAllowed(String(userId))) {
      if (rateLimiter.shouldSendCooldownNotice(String(userId))) {
        await telegram.send(
          "You are sending messages too quickly. Please wait a moment before trying again."
        );
      }
      return;
    }

    await withChatLock(sessionKey, async () => {
      await authStore.reload();
      const isAuthorized = authStore.isAuthorized(userId);
      const fileConfig = authStore.getConfig();
      const isExplicitPairingAttempt = Boolean(
        !isGroup &&
          text &&
          fileConfig?.handshakeCode &&
          looksLikeHandshakeAttempt(text)
      );
      if (isExplicitPairingAttempt && text) {
        await handlePairing(text, userId, channelOrgKey, sessionKey, telegram);
        return;
      }

      if (!isAuthorized) {
        if (
          fileConfig?.accessMode === "allowlist" ||
          fileConfig?.accessMode === "denylist"
        ) {
          if (!isGroup) {
            await telegram.send(
              "This assistant is restricted and not authorized for this chat."
            );
          }
          return;
        }

        if (isGroup) {
          await telegram.send(LINK_IN_PRIVATE_REPLY);
          return;
        }

        if (!text) {
          if (
            ctx.message?.photo?.length ||
            hasTelegramDocument(ctx) ||
            hasTelegramAudio(ctx)
          ) {
            await telegram.send(
              "Send your pairing code as text to link this chat."
            );
            return;
          }

          await telegram.send("Text messages only.");
          return;
        }

        await handlePairing(text, userId, channelOrgKey, sessionKey, telegram);
        return;
      }

      if (isGroup && text && looksLikeHandshakeAttempt(text)) {
        await telegram.send(LINK_IN_PRIVATE_REPLY);
        return;
      }

      const command = text?.startsWith("/")
        ? parseTelegramSlashCommand(text, {
            botUsername: botInfo?.username,
            requireBotTarget: isGroup,
          })
        : null;
      const bypassOrgGate =
        command === "/help" || command === "/start" || command === "/org";

      if (!bypassOrgGate) {
        const orgGateText =
          isGroup && text && botInfo?.username
            ? stripBotMention(text, botInfo.username)
            : text;
        const orgReady = await ensureOrgReady(
          telegram,
          channelOrgKey,
          orgGateText
        );
        if (!orgReady) {
          return;
        }
      }

      if (command && text) {
        await handleCommand(
          ctx,
          text,
          sessionKey,
          channelOrgKey,
          isTopic,
          telegram
        );
        return;
      }

      const signal = registerActiveStream(sessionKey);
      try {
        const imageInput = await tryBuildImageInput(ctx, telegram, signal);

        if (imageInput === "reject") {
          return;
        }

        if (imageInput) {
          await handleChatMessage(
            ctx,
            withGroupContext(imageInput, isGroup),
            sessionKey,
            telegram,
            "",
            signal
          );
          return;
        }

        const documentInput = await tryBuildDocumentInput(
          ctx,
          telegram,
          signal
        );

        if (documentInput === "reject") {
          return;
        }

        if (documentInput) {
          await handleChatMessage(
            ctx,
            withGroupContext(documentInput, isGroup),
            sessionKey,
            telegram,
            "",
            signal
          );
          return;
        }

        const preparedAudio = await tryBuildAudioInput(
          ctx,
          telegram,
          sessionKey,
          channelUserId,
          signal
        );

        if (preparedAudio === "reject") {
          return;
        }

        if (preparedAudio) {
          await handleChatMessage(
            ctx,
            withGroupContext(preparedAudio.input, isGroup),
            sessionKey,
            telegram,
            "",
            signal,
            preparedAudio.session
          );
          return;
        }

        if (hasTelegramDocument(ctx)) {
          return;
        }

        if (!text) {
          await telegram.send(UNSUPPORTED_MEDIA_REPLY);
          return;
        }

        const messageText = isGroup
          ? stripBotMention(text, botInfo?.username)
          : text;

        await handleChatMessage(
          ctx,
          withGroupContext({ message: messageText }, isGroup),
          sessionKey,
          telegram,
          messageText,
          signal
        );
      } catch (error) {
        if (isAbortError(error)) {
          await telegram.send("Stopped.");
        } else {
          await telegram.send(formatError(error));
        }
      } finally {
        clearActiveStream(sessionKey, signal);
      }
    });
  }

  async function handlePairing(
    text: string,
    userId: number,
    channelOrgKey: string,
    sessionKey: string,
    telegram: TelegramRichMessenger
  ): Promise<void> {
    const command = parseTelegramSlashCommand(text);
    const fileConfig = authStore.getConfig();
    const hasHandshake = Boolean(fileConfig?.handshakeCode);

    if (command === "/help") {
      await replyChunks(telegram, `${PAIRING_PROMPT}\n\n${helpText}`);
      return;
    }

    if (command === "/start") {
      await telegram.send(hasHandshake ? PAIRING_PROMPT : NO_CODE_PROMPT);
      return;
    }

    if (!hasHandshake) {
      await telegram.send(NO_CODE_PROMPT);
      return;
    }

    if (!looksLikeHandshakeAttempt(text)) {
      await telegram.send(PAIRING_PROMPT);
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
      await telegram.send(result.message);
    } catch (error) {
      console.error("Failed to bind Telegram channel principal:", error);
      await telegram.send(
        "Could not link this chat. The pairing code is still active; try again."
      );
    }
    // Pairing messages stay out of agent session history — only Telegram + config.ini.
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
        "Telegram pairing requires an authoritative workspace context."
      );
    }
    const principal = await client.bindChannelPrincipal({
      channel: "telegram",
      channelUserId: input.channelUserId,
      expectedUserId: input.pairingUserId,
      pairingAssertion: input.pairingAssertion,
    });
    if (principal.orgId !== orgId || principal.userId !== input.pairingUserId) {
      throw new Error(
        "Telegram pairing principal did not match the pending authorization."
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
    }
    await sessionStore.save();
  }

  async function handleCommand(
    ctx: Context,
    text: string,
    conversationKey: string,
    channelOrgKey: string,
    isTopic: boolean,
    telegram: TelegramRichMessenger
  ): Promise<void> {
    const command = parseTelegramSlashCommand(text, {
      botUsername: resolveBotInfo(ctx, getBotInfo())?.username,
      requireBotTarget: isTelegramGroupChat(ctx),
    });
    if (command === null) {
      return;
    }

    switch (command) {
      case "/start":
      case "/help":
        await replyChunks(telegram, helpText);
        return;

      case "/clear": {
        const session = await resolveSession(
          conversationKey,
          String(ctx.from?.id ?? "")
        );
        await session.clear();
        await clearSessionArtifactState(conversationKey);
        await telegram.send("History cleared.");
        return;
      }

      case "/compact": {
        const session = await resolveSession(
          conversationKey,
          String(ctx.from?.id ?? "")
        );
        const result = await session.compact({ force: true });
        await telegram.send(
          `Compacted (${result.action}). Messages: ${result.messagesAfter}.`
        );
        return;
      }

      case "/new": {
        await createAndBindSession(
          conversationKey,
          undefined,
          String(ctx.from?.id ?? "")
        );
        await telegram.send("Started a new conversation.");
        return;
      }

      case "/status":
        await replyStatus(telegram, conversationKey);
        return;

      case "/attach": {
        await resolveSession(conversationKey, String(ctx.from?.id ?? ""));
        const profileId = sessionStore.get(conversationKey)?.profileId;
        if (!profileId) {
          await telegram.send(formatMissingAttachArtifactMessage());
          return;
        }

        await maybeSendRequestedTelegramArtifactAttachment({
          attachUserText: text,
          client,
          conversationKey,
          ctx,
          messenger: telegram,
          profileId,
          sessionStore,
        });
        return;
      }

      case "/org":
        await handleOrgCommand(text, channelOrgKey, conversationKey, telegram);
        return;

      case "/profile":
        await handleProfileCommand(
          text,
          conversationKey,
          channelOrgKey,
          isTopic,
          telegram,
          String(ctx.from?.id ?? "")
        );
        return;

      default:
        await telegram.send("Unknown command. Try /help");
    }
  }

  async function tryBuildImageInput(
    ctx: Context,
    telegram: TelegramRichMessenger,
    signal: AbortSignal
  ): Promise<SendMessageInput | "reject" | null> {
    try {
      return await buildTelegramImageInput(ctx, { signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      await telegram.send(formatError(error));
      return "reject";
    }
  }

  async function tryBuildDocumentInput(
    ctx: Context,
    telegram: TelegramRichMessenger,
    signal: AbortSignal
  ): Promise<SendMessageInput | "reject" | null> {
    try {
      const result = await buildTelegramDocumentInput(ctx, { signal });

      if (!result) {
        return null;
      }

      if (result.kind === "reject") {
        await telegram.send(result.message);
        return "reject";
      }

      return result.input;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      await telegram.send(DOWNLOAD_FAILED_REPLY);
      return "reject";
    }
  }

  async function tryBuildAudioInput(
    ctx: Context,
    telegram: TelegramRichMessenger,
    sessionKey: string,
    channelUserId: string,
    signal: AbortSignal
  ): Promise<
    | {
        input: SendMessageInput;
        session: RemoteChatSession;
      }
    | "reject"
    | null
  > {
    if (!hasTelegramAudio(ctx)) {
      return null;
    }

    try {
      const session = await waitForAbortable(
        resolveSession(sessionKey, channelUserId),
        signal
      );
      const input = await buildTelegramAudioInput(ctx, client, session.id, {
        signal,
      });
      return input ? { input, session } : null;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      await telegram.send(formatTelegramAudioError(error));
      return "reject";
    }
  }

  async function handleChatMessage(
    ctx: Context,
    input: SendMessageInput,
    sessionKey: string,
    telegram: TelegramRichMessenger,
    attachUserText: string,
    signal: AbortSignal,
    preparedSession?: RemoteChatSession
  ): Promise<void> {
    const typingLoop = createTypingLoop(ctx);
    const todoStatus = new TelegramTodoStatusMessage(telegram);
    const liveReply = createTelegramLiveReply(telegram);
    let reply = "";
    let earlyAck = false;
    let profileId: string | undefined;
    let session: RemoteChatSession | undefined;
    const streamedArtifacts = new Map<string, ChannelArtifactRef>();

    try {
      session =
        preparedSession ??
        (await waitForAbortable(
          resolveSession(sessionKey, String(ctx.from?.id ?? "")),
          signal
        ));
      profileId = sessionStore.get(sessionKey)?.profileId;

      if (profileId) {
        await waitForAbortable(
          maybeSendRequestedTelegramArtifactAttachment({
            attachUserText,
            client,
            conversationKey: sessionKey,
            ctx,
            messenger: telegram,
            profileId,
            sessionStore,
          }),
          signal
        );
      }

      typingLoop.start();

      reply = await session.sendStream(
        input,
        {
          onArtifactCreated: (artifact) => {
            const ref = channelArtifactRefFromArtifact(artifact);
            if (ref) {
              streamedArtifacts.set(ref.path, ref);
            }
          },
          onChunk: (delta) => {
            reply += delta;
            liveReply.updateFromReply(reply);
          },
          onThinking: () => {
            typingLoop.ping();
            liveReply.updateWorking();
          },
          onTodosUpdated: (todos) => {
            typingLoop.ping();
            void todoStatus.update(todos);
          },
          onToolEnd: () => {
            typingLoop.ping();
          },
          onToolStart: () => {
            typingLoop.ping();
            if (liveReply.hasStatusMessage()) {
              liveReply.updateTooling();
              return;
            }

            if (reply.trim()) {
              return;
            }

            const earlyText = reply.trim() || TELEGRAM_EARLY_ACK_FALLBACK;
            liveReply.postStatus(earlyText);
            earlyAck = true;
          },
        },
        { signal }
      );

      await todoStatus.complete();

      if (signal.aborted) {
        const finalReply = reply.trim();
        if (finalReply) {
          if (!(await liveReply.replaceWithFinal(finalReply))) {
            await replyAsChat(telegram, finalReply);
          }
          await telegram.send("Stopped.");
        } else if (!(await liveReply.replaceWithFinal("Stopped."))) {
          await telegram.send("Stopped.");
        }
        return;
      }
    } catch (error) {
      if (isAbortError(error)) {
        await todoStatus.stop();
        const finalReply = reply.trim();
        if (finalReply) {
          if (!(await liveReply.replaceWithFinal(finalReply))) {
            await replyAsChat(telegram, finalReply);
          }
          await telegram.send("Stopped.");
        } else if (!(await liveReply.replaceWithFinal("Stopped."))) {
          await telegram.send("Stopped.");
        }
        return;
      }

      await todoStatus.fail();
      if (!(await liveReply.replaceWithError(formatError(error)))) {
        await telegram.send(formatError(error));
      }
      return;
    } finally {
      typingLoop.stop();
    }

    const finalReply = reply.trim();
    if (finalReply) {
      if (!(await liveReply.replaceWithFinal(finalReply))) {
        await replyAsChat(telegram, finalReply);
      }
    } else if (liveReply.hasStatusMessage() || earlyAck) {
      if (!(await liveReply.replaceWithFinal("(empty reply)"))) {
        await telegram.send("(empty reply)");
      }
    } else {
      await telegram.send("(empty reply)");
    }

    if (profileId && session) {
      await deliverTelegramTurnArtifactShares({
        client,
        conversationKey: sessionKey,
        ctx,
        messenger: telegram,
        profileId,
        session,
        sessionStore,
        streamedArtifacts: [...streamedArtifacts.values()],
      });
    }
  }

  function createTelegramLiveReply(messenger: TelegramRichMessenger) {
    let statusMessageId: number | null = null;
    let lastStatusText = "";
    let lastStatusAt = 0;
    let statusChain = Promise.resolve();
    let statusRequested = false;

    function requestStatus(status: string) {
      const now = Date.now();
      const normalized = status.trim();

      if (!normalized || normalized === lastStatusText) {
        return;
      }

      if (now - lastStatusAt < TELEGRAM_LIVE_REPLY_STATUS_INTERVAL_MS) {
        return;
      }

      lastStatusAt = now;
      lastStatusText = normalized;
      statusRequested = true;
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
          statusMessageId = message?.message_id ?? null;
          return;
        }

        await messenger.edit(statusMessageId, status);
      } catch {
        // Status updates are best-effort only.
      }
    }

    async function replaceWithFinal(replyText: string): Promise<boolean> {
      await statusChain;
      if (statusMessageId === null) {
        return false;
      }

      const chunks = splitTelegramMessage(replyText);
      if (chunks.length === 0) {
        return true;
      }

      try {
        await messenger.edit(statusMessageId, chunks[0] ?? "");
        for (const chunk of chunks.slice(1)) {
          await replyAsChat(messenger, chunk);
        }
        return true;
      } catch {
        statusMessageId = null;
        return false;
      }
    }

    function makeReplyPreview(reply: string): string {
      const trimmed = reply.trim();
      if (!trimmed) {
        return TELEGRAM_LIVE_WORKING_LABEL;
      }

      const preview = trimmed.slice(0, TELEGRAM_LIVE_REPLY_PREVIEW_LENGTH);
      const suffix =
        trimmed.length > TELEGRAM_LIVE_REPLY_PREVIEW_LENGTH ? "…" : "";

      return `${TELEGRAM_LIVE_WORKING_LABEL}\n\n${preview}${suffix}`;
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
        requestStatus(statusText);
      },
      replaceWithError,
      replaceWithFinal,
      updateFromReply: (reply: string): void => {
        if (!statusMessageId) {
          return;
        }
        requestStatus(makeReplyPreview(reply));
      },
      updateTooling: (): void => {
        requestStatus(TELEGRAM_LIVE_TOOL_LABEL);
      },
      updateWorking: (): void => {
        requestStatus(TELEGRAM_LIVE_WORKING_LABEL);
      },
    };
  }

  async function ensureOrgReady(
    telegram: TelegramRichMessenger,
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
      await telegram.send("No organizations are configured yet.");
      return false;
    }

    if (orgContext.status === "prompt") {
      await replyChunks(telegram, orgContext.message);
      return false;
    }

    client.setOrgId(orgContext.orgId);

    if (orgContext.justSelected) {
      await telegram.send(formatOrgSwitchConfirmation(orgContext.orgName));
      return false;
    }

    return true;
  }

  async function handleOrgCommand(
    text: string,
    channelOrgKey: string,
    conversationKey: string,
    telegram: TelegramRichMessenger
  ): Promise<void> {
    if (fixedWorkspaceId) {
      await telegram.send(
        "This bot belongs to one workspace and cannot switch workspaces."
      );
      return;
    }

    const { orgs } = await client.listUserOrgs();

    if (orgs.length === 0) {
      await telegram.send("No organizations are configured yet.");
      return;
    }

    const arg = text.trim().split(/\s+/).slice(1).join(" ");
    if (!arg) {
      await replyChunks(
        telegram,
        formatOrgSelectionPrompt(
          orgs,
          getOrgSelection(orgStore, channelOrgKey)?.orgId
        )
      );
      return;
    }

    const picked = findOrgBySelectionInput(arg, orgs);
    if (!picked) {
      await telegram.send("Unknown organization. Send /org to see the list.");
      return;
    }

    const previousOrgId = getOrgSelection(orgStore, channelOrgKey)?.orgId;
    orgStore.set(channelOrgKey, picked.id);
    await orgStore.save();
    client.setOrgId(picked.id);

    if (previousOrgId && previousOrgId !== picked.id) {
      sessionStore.delete(conversationKey);
      await sessionStore.save();
    }

    await telegram.send(formatOrgSwitchConfirmation(picked.name));
  }

  async function handleProfileCommand(
    text: string,
    conversationKey: string,
    channelOrgKey: string,
    isTopic: boolean,
    telegram: TelegramRichMessenger,
    channelUserId: string
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
    const currentProfileId = await resolveSessionProfileId(conversationKey);

    if (!arg) {
      const profiles = await listSelectableProfiles();

      if (profiles.length === 0) {
        await telegram.send("No profiles are available.");
        return;
      }

      await replyChunks(
        telegram,
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
      currentOrgId && isTopic
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
        : isTopic || workspaceLocked
          ? null
          : resolveProfileInScopes(await listProfileScopes(orgs), arg);

    if (!resolved) {
      if (isTopic && currentOrgId && !workspaceLocked) {
        const crossOrgMatch = resolveProfileInScopes(
          await listProfileScopes(orgs),
          arg
        );

        if (crossOrgMatch) {
          await telegram.send(
            "That profile is in another org. Send /org first, then /profile."
          );
          return;
        }
      }

      await telegram.send("Unknown profile. Send /profile to see the list.");
      return;
    }

    if ("ambiguous" in resolved) {
      await telegram.send(
        workspaceLocked
          ? "Unknown profile. Send /profile to see the list."
          : `That profile exists in multiple orgs (${resolved.ambiguous}). Send /org first, then /profile.`
      );
      return;
    }

    const { scope, profile: picked } = resolved;

    if (scope.orgId !== currentOrgId) {
      if (workspaceLocked) {
        await telegram.send("Unknown profile. Send /profile to see the list.");
        return;
      }

      orgStore.set(channelOrgKey, scope.orgId);
      await orgStore.save();
      client.setOrgId(scope.orgId);
      sessionStore.delete(conversationKey);
      await sessionStore.save();
    }

    if (picked.id === currentProfileId && scope.orgId === currentOrgId) {
      await telegram.send(`Already using ${picked.name}.`);
      return;
    }

    await createAndBindSession(conversationKey, picked.id, channelUserId);
    const orgNote =
      workspaceLocked || scope.orgId === currentOrgId
        ? ""
        : ` (${scope.orgName})`;
    await telegram.send(
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
    telegram: TelegramRichMessenger,
    chatId: string
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
        const profileId = await resolveSessionProfileId(chatId);
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

      await replyChunks(telegram, lines.join("\n"));
    } catch (error) {
      await telegram.send(formatError(error));
    }
  }

  async function resolveSession(
    chatId: string,
    channelUserId: string
  ): Promise<RemoteChatSession> {
    const existing = sessionStore.get(chatId);
    const normalizedChannelUserId = channelUserId.trim();
    const belongsToCurrentSender =
      existing?.channelUserId?.trim() === normalizedChannelUserId;

    if (existing && belongsToCurrentSender) {
      const hot = sessionStore.getHotSession<RemoteChatSession>(chatId);
      if (hot) {
        return hot;
      }

      const session = client.createChatSession(existing.sessionId, "telegram");

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
    const resolvedProfileId =
      profileId ?? (await resolveSessionProfileId(chatId));
    const principalUserId = channelUserId.trim();
    if (!principalUserId) {
      throw new Error("Telegram channel user identity is required.");
    }
    const session = await client.createSession("telegram", {
      externalPrincipal: { channelUserId: principalUserId },
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

  async function resolveSessionProfileId(chatId: string): Promise<string> {
    const profiles = await listSelectableProfiles();
    const storedProfileId = sessionStore.get(chatId)?.profileId;

    if (storedProfileId) {
      const match = profiles.find((profile) => profile.id === storedProfileId);

      if (match) {
        return match.id;
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

  return (ctx: Context) =>
    client.isolateOrgId(async () => {
      try {
        await handleMessage(ctx);
      } catch (error) {
        if (!ctx.chat) {
          return;
        }
        const telegram = createTelegramRichMessenger(ctx);
        await telegram.send(formatError(error)).catch(() => undefined);
      }
    });
}

export function resolveTelegramSessionKey(
  conversationKey: string,
  channelUserId: string,
  isGroup: boolean
): string {
  if (!isGroup) {
    return conversationKey;
  }

  return `${conversationKey}:sender:${encodeURIComponent(channelUserId.trim())}`;
}

function withGroupContext(
  input: SendMessageInput,
  isGroup: boolean
): SendMessageInput {
  if (!isGroup) {
    return input;
  }

  const message = input.message?.trim();

  if (message) {
    return { ...input, message: `${GROUP_MESSAGE_PREFIX}${message}` };
  }

  return { ...input, message: GROUP_MESSAGE_PREFIX.trim() };
}

function getOrgSelection(
  orgStore: ChannelOrgStore,
  channelOrgKey: string
): ReturnType<ChannelOrgStore["get"]> {
  const selected = orgStore.get(channelOrgKey);

  if (selected) {
    return selected;
  }

  // ponytail: legacy private keys were bare user ids before group support
  if (channelOrgKey.startsWith("u:")) {
    return orgStore.get(channelOrgKey.slice(2));
  }
}

async function replyChunks(
  telegram: TelegramRichMessenger,
  text: string
): Promise<void> {
  for (const chunk of splitTelegramMessage(text)) {
    await telegram.send(chunk);
  }
}

function looksLikeHandshakeAttempt(text: string): boolean {
  return /^[0-9A-F]{8}$/.test(normalizeHandshakeInput(text));
}

function isStopCommand(
  text: string,
  botUsername?: string,
  requireBotTarget = false
): boolean {
  return (
    parseTelegramSlashCommand(text, { botUsername, requireBotTarget }) ===
    "/stop"
  );
}

export function resetChatLocksForTests(): void {
  chatLocks.clear();
  rateLimiter.reset();
}

export async function withChatLock(
  chatId: string,
  fn: () => Promise<void>
): Promise<void> {
  const previous = chatLocks.get(chatId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(
    () => current,
    () => current
  );
  chatLocks.set(chatId, chain);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Chat lock timeout")),
      LOCK_TIMEOUT_MS
    );
  });

  try {
    await Promise.race([previous, timeoutPromise]).catch(() => {});
    await fn();
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    release();
    if (chatLocks.get(chatId) === chain) {
      chatLocks.delete(chatId);
    }
  }
}

export function seedChatLockForTests(
  chatId: string,
  promise: Promise<void>
): void {
  chatLocks.set(chatId, promise);
}
