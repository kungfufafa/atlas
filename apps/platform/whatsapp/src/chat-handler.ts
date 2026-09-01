import type { AtlasClient, RemoteChatSession } from "@atlas/client";
import {
  type ChannelArtifactRef,
  channelArtifactRefFromArtifact,
  isAttachOnlyCommand,
  saveInboundWorkspaceDocument,
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
  pickProfileForOrg,
  resolveProfileInput,
} from "@atlas/core/profiles";
import {
  clearWhatsAppPairingAssertion,
  normalizePairingCode,
  normalizeWhatsAppUserJid,
  syncWhatsAppOwnerPairing,
} from "@atlas/core/whatsapp-config";
import type {
  WAMessage,
  WAMessageKey,
  WASocket,
} from "@whiskeysockets/baileys";
import {
  clearActiveStream,
  isAbortError,
  registerActiveStream,
  stopActiveStream,
} from "./active-stream";
import {
  buildWhatsAppMediaInput,
  downloadWhatsAppMedia,
  mergeWhatsAppUserMessage,
  PAIRING_MEDIA_REPLY,
  UNSUPPORTED_MEDIA_REPLY,
  type WhatsAppMediaDownload,
} from "./attachments";
import { buildWhatsAppAudioInput } from "./audio";
import type { WhatsAppAuthStore } from "./auth-store";
import { getSafeWhatsAppErrorType } from "./baileys-logger";
import {
  deliverWhatsAppTurnArtifactShares,
  isPureWhatsAppAttachIntent,
  maybeSendRequestedWhatsAppArtifactAttachment,
} from "./channel-artifact-flow";
import type { WhatsAppBridgeConfig } from "./config";
import {
  formatError,
  formatHelpText,
  prepareWhatsAppReply,
  splitWhatsAppMessage,
} from "./format";
import {
  explainWhatsAppGroupMessageHandling,
  isWhatsAppGroupChat,
  resolveWhatsAppChannelOrgKey,
  stripWhatsAppBotMention,
} from "./group-message";
import {
  inspectInboundWhatsAppMedia,
  isPrivateWhatsAppChat,
  type WhatsAppInboundChat,
} from "./inbound-message";
import type { SessionStore } from "./session-store";
import { WhatsAppTodoStatusMessage } from "./todo-status-message";
import { createTypingLoop } from "./typing-indicator";

const chatLocks = new Map<string, Promise<void>>();
const rateLimiter = new ChannelRateLimiter();
const MAX_MESSAGE_LENGTH = 2000;
const MAX_QUOTED_CONTEXT_LENGTH = 4000;
const LOCK_TIMEOUT_MS = 120_000;

const GROUP_MESSAGE_PREFIX =
  "[WhatsApp group — your reply is visible to everyone in this group.]\n";

const LINK_IN_PRIVATE_REPLY =
  "Authorize this number in a private chat with the connected WhatsApp account first.";

const GROUP_PAIRING_REPLY =
  "Chat access codes can only be used in a private chat.";

const GROUP_SESSION_ERROR_REPLY =
  "Atlas could not open this group session. Check WhatsApp access and the workspace profile settings.";

const ATTACH_WITH_FILE_REPLY =
  "Send /attach by itself to receive the latest saved file. To give Atlas a file, send it without /attach.";

const WHATSAPP_LIVE_REPLY_STATUS_INTERVAL_MS = 900;
const WHATSAPP_EARLY_ACK_FALLBACK = "On it.";
const WHATSAPP_LIVE_WORKING_LABEL = "⌛ Working...";
const WHATSAPP_LIVE_TOOL_LABEL = "🛠️ Running a tool...";

const PAIRING_PROMPT =
  "Atlas has not authorized this chat yet.\n\n" +
  "Send the chat access code shown in Integrations \u2192 WhatsApp. " +
  "You only need to authorize this chat once.";

export interface ChatHandlerDeps {
  authStore: WhatsAppAuthStore;
  client: AtlasClient;
  config: WhatsAppBridgeConfig;
  downloadMedia?: WhatsAppMediaDownload;
  fixedWorkspaceId?: string;
  getSocket: () => WASocket | null;
  orgStore: ChannelOrgStore;
  sessionStore: SessionStore;
}

type WhatsAppHandlerInput = Pick<WhatsAppInboundChat, "jid" | "text"> &
  Partial<Omit<WhatsAppInboundChat, "jid" | "text">> & {
    inbound?: WAMessage | null;
  };

type NormalizedWhatsAppHandlerInput = WhatsAppInboundChat & {
  inbound?: WAMessage | null;
};

export function createChatHandler(deps: ChatHandlerDeps) {
  const {
    client,
    config,
    authStore,
    sessionStore,
    orgStore,
    getSocket,
    fixedWorkspaceId,
    downloadMedia,
  } = deps;
  const helpText = formatHelpText({
    workspaceLocked: Boolean(fixedWorkspaceId),
  });

  async function handleMessage(data: WhatsAppHandlerInput): Promise<void> {
    const inboundChat = normalizeInboundChat(data);
    const { jid, text, fromMe, senderPn, inbound } = inboundChat;
    const trimmed = text.trim();
    const media = inspectInboundWhatsAppMedia(inbound?.message);
    const isGroup = inboundChat.isGroup;
    const conversationKey = chatKey(jid);
    const channelOrgKey = resolveWhatsAppChannelOrgKey(
      conversationKey,
      isGroup
    );
    const groupDecision = isGroup
      ? explainWhatsAppGroupMessageHandling({
          me: inboundChat.me,
          mentionedJids: inboundChat.mentionedJids,
          quotedParticipant: inboundChat.quotedParticipant,
          text: trimmed,
        })
      : null;

    if (groupDecision && !groupDecision.shouldHandle) {
      console.log(
        `Ignored WhatsApp group message reason=${groupDecision.reason}`
      );
      return;
    }

    if (isGroup && !inboundChat.senderJid) {
      console.warn("Ignored WhatsApp group message without a sender identity.");
      return;
    }

    if (!(trimmed || media)) {
      return;
    }

    if (await shouldSilentlyIgnoreUnauthorizedPairing(inboundChat)) {
      return;
    }

    if (!isGroup && trimmed && isStopCommand(trimmed)) {
      if (!stopActiveStream(conversationKey)) {
        await sendText(jid, "Nothing to stop.");
      }

      return;
    }

    if (isGroup && isStopCommand(trimmed)) {
      await authStore.reload();
      for (const senderJid of inboundChat.senderJids) {
        await authStore.rememberSenderPn(senderJid, senderPn);
      }
      const fileConfig = authStore.getConfig();
      const authorized =
        fromMe ||
        inboundChat.senderJids.some((senderJid) =>
          authStore.isAuthorized(senderJid, { senderPn })
        );
      if (!authorized) {
        if (
          fileConfig?.accessMode !== "allowlist" &&
          fileConfig?.accessMode !== "denylist"
        ) {
          await sendText(jid, LINK_IN_PRIVATE_REPLY);
        }
        return;
      }

      if (!stopActiveStream(conversationKey)) {
        await sendText(jid, "Nothing to stop.");
      }
      return;
    }

    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      await sendText(
        jid,
        "Message is too long (maximum 2,000 characters). Please shorten your message."
      );
      return;
    }

    const rateLimitKey = isGroup
      ? `${conversationKey}:${inboundChat.senderJid}`
      : conversationKey;
    if (!rateLimiter.isAllowed(rateLimitKey)) {
      if (rateLimiter.shouldSendCooldownNotice(rateLimitKey)) {
        await sendText(
          jid,
          "You are sending messages too quickly. Please wait a moment before trying again."
        );
      }
      return;
    }

    await withChatLock(conversationKey, async () => {
      await authStore.reload();
      const fileConfig = authStore.getConfig();
      const senderJids = isGroup ? inboundChat.senderJids : [conversationKey];
      for (const senderJid of senderJids) {
        await authStore.rememberSenderPn(senderJid, senderPn);
      }
      let authorized = isGroup
        ? fromMe ||
          senderJids.some((senderJid) =>
            authStore.isAuthorized(senderJid, { senderPn })
          )
        : authStore.isAuthorized(jid, { senderPn });

      if (!(isGroup || authorized) && fromMe && fileConfig?.pairedJid) {
        await syncWhatsAppOwnerPairing({
          forceLidUpdate: true,
          orgId: fixedWorkspaceId,
          ownerJid: fileConfig.pairedJid,
          ownerLid: jid,
        });
        await authStore.reload();
        authorized = authStore.isAuthorized(jid, { senderPn });
      }

      const principalChannelUserId = isGroup
        ? inboundChat.senderJid
        : conversationKey;
      if (authorized && !isGroup) {
        await bindPendingChannelPrincipal(principalChannelUserId);
      }

      if (!authorized) {
        if (
          fileConfig?.accessMode === "allowlist" ||
          fileConfig?.accessMode === "denylist"
        ) {
          const command = parseCommand(trimmed);
          if (!isGroup && (command === "/start" || command === "/help")) {
            await sendText(
              jid,
              "This assistant is restricted and not authorized for this chat."
            );
          }
          return;
        }

        if (isGroup) {
          if (
            (fileConfig?.accessMode ?? "pairing") === "pairing" &&
            !fileConfig?.pairingCode
          ) {
            return;
          }
          await sendText(jid, LINK_IN_PRIVATE_REPLY);
          return;
        }

        if (
          media &&
          !trimmed.startsWith("/") &&
          !looksLikePairingCodeAttempt(trimmed)
        ) {
          await sendText(jid, PAIRING_MEDIA_REPLY);
          return;
        }

        await handlePairing(jid, trimmed);
        return;
      }

      const messageText = isGroup
        ? stripWhatsAppBotMention({
            me: inboundChat.me,
            mentionedJids: inboundChat.mentionedJids,
            text: trimmed,
          })
        : trimmed;

      if (isGroup && looksLikePairingCodeAttempt(messageText)) {
        await sendText(jid, GROUP_PAIRING_REPLY);
        return;
      }

      const command = trimmed.startsWith("/") ? parseCommand(trimmed) : null;
      const bypassOrgGate =
        command === "/help" || command === "/start" || command === "/org";

      if (!bypassOrgGate) {
        const orgReady = await ensureOrgReady(channelOrgKey, messageText, jid);
        if (!orgReady) {
          return;
        }
      }

      const pureAttachIntent = isPureWhatsAppAttachIntent(messageText);
      if (media && isAttachOnlyCommand(messageText)) {
        await sendText(jid, ATTACH_WITH_FILE_REPLY);
        return;
      }

      if (pureAttachIntent && !trimmed.startsWith("/") && !media) {
        await handleAttachRequest(
          conversationKey,
          jid,
          messageText,
          principalChannelUserId
        );
        return;
      }

      const attachCommandHasInstructions =
        command === "/attach" && !isAttachOnlyCommand(messageText);
      if (trimmed.startsWith("/") && !attachCommandHasInstructions) {
        try {
          await handleCommand(
            conversationKey,
            channelOrgKey,
            jid,
            trimmed,
            principalChannelUserId
          );
        } catch (error) {
          await sendText(
            jid,
            isGroup ? GROUP_SESSION_ERROR_REPLY : formatError(error)
          );
        }
        return;
      }

      const signal = registerActiveStream(conversationKey);
      try {
        const mediaInput = await tryBuildMediaInput(
          jid,
          channelOrgKey,
          inbound,
          signal
        );
        if (mediaInput === "reject") {
          return;
        }

        if (mediaInput) {
          await handleChatMessage(
            conversationKey,
            jid,
            withInboundGroupContext(
              {
                ...mediaInput,
                message: mergeWhatsAppUserMessage(
                  messageText,
                  isGroup
                    ? stripWhatsAppBotMention({
                        me: inboundChat.me,
                        mentionedJids: inboundChat.mentionedJids,
                        text: mediaInput.message,
                      })
                    : mediaInput.message
                ),
              },
              inboundChat
            ),
            inbound,
            principalChannelUserId,
            messageText,
            signal
          );
          return;
        }

        if (media?.kind === "audio") {
          const audioInput = await tryBuildAudioInput(jid, inbound, signal);
          if (audioInput === "reject") {
            return;
          }

          if (audioInput) {
            await handleChatMessage(
              conversationKey,
              jid,
              withInboundGroupContext(
                {
                  ...audioInput,
                  message: messageText
                    ? `${audioInput.message}\n\n${messageText}`
                    : audioInput.message,
                },
                inboundChat
              ),
              inbound,
              principalChannelUserId,
              messageText,
              signal
            );
            return;
          }
        }

        if (media?.kind === "unsupported" && !trimmed) {
          await sendText(jid, UNSUPPORTED_MEDIA_REPLY);
          return;
        }

        if (!(messageText || isGroup)) {
          return;
        }

        await handleChatMessage(
          conversationKey,
          jid,
          withInboundGroupContext({ message: messageText }, inboundChat),
          inbound,
          principalChannelUserId,
          messageText,
          signal
        );
      } catch (error) {
        await sendText(
          jid,
          isAbortError(error) ? "Stopped." : formatError(error)
        );
      } finally {
        clearActiveStream(conversationKey, signal);
      }
    });
  }

  async function shouldSilentlyIgnoreUnauthorizedPairing(
    inboundChat: NormalizedWhatsAppHandlerInput
  ): Promise<boolean> {
    await authStore.reload();
    const fileConfig = authStore.getConfig();
    if (
      (fileConfig?.accessMode ?? "pairing") !== "pairing" ||
      fileConfig?.pairingCode
    ) {
      return false;
    }

    if (!inboundChat.isGroup && inboundChat.fromMe && fileConfig?.pairedJid) {
      return false;
    }

    const senderJids = inboundChat.isGroup
      ? inboundChat.senderJids
      : [inboundChat.jid];
    return !senderJids.some((senderJid) =>
      authStore.isAuthorized(senderJid, { senderPn: inboundChat.senderPn })
    );
  }

  async function handlePairing(jid: string, text: string): Promise<void> {
    const command = parseCommand(text);
    const fileConfig = authStore.getConfig();
    const hasPairingCode = Boolean(fileConfig?.pairingCode);

    if (!hasPairingCode) {
      return;
    }

    if (command === "/help") {
      await sendText(jid, `${PAIRING_PROMPT}\n\n${helpText}`);
      return;
    }

    if (command === "/start") {
      await sendText(jid, PAIRING_PROMPT);
      return;
    }

    if (!looksLikePairingCodeAttempt(text)) {
      await sendText(jid, PAIRING_PROMPT);
      return;
    }

    const result = await authStore.tryPair(text, chatKey(jid));
    await sendText(jid, result.message);
    if (result.ok) {
      await bindPendingChannelPrincipal(chatKey(jid), result.pairingAssertion);
    }
  }

  async function bindPendingChannelPrincipal(
    channelUserId: string,
    pairingAssertion?: string | null
  ): Promise<void> {
    const assertion =
      pairingAssertion?.trim() ||
      authStore.getConfig()?.pairingAssertion?.trim() ||
      "";
    if (!assertion) {
      return;
    }
    const orgId = fixedWorkspaceId ?? orgStore.get(channelUserId)?.orgId;
    if (!orgId) {
      return;
    }
    try {
      await client.bindChannelPrincipal({
        channel: "whatsapp",
        channelUserId,
        pairingAssertion: assertion,
      });
      await clearWhatsAppPairingAssertion(orgId);
      await authStore.reload();
    } catch (error) {
      console.error("Failed to bind WhatsApp channel principal.", {
        errorType: getSafeWhatsAppErrorType(error),
      });
    }
  }

  async function handleCommand(
    conversationKey: string,
    channelOrgKey: string,
    sendJid: string,
    text: string,
    channelUserId: string
  ): Promise<void> {
    const command = parseCommand(text);

    switch (command) {
      case "/start":
      case "/help":
        await sendText(sendJid, helpText);
        return;

      case "/clear": {
        const session = await resolveSession(conversationKey, channelUserId);
        await session.clear();
        await clearSessionArtifactState(conversationKey);
        await sendText(sendJid, "History cleared.");
        return;
      }

      case "/attach":
        await handleAttachRequest(
          conversationKey,
          sendJid,
          text,
          channelUserId
        );
        return;

      case "/compact": {
        const session = await resolveSession(conversationKey, channelUserId);
        const result = await session.compact({ force: true });
        await sendText(
          sendJid,
          `Compacted (${result.action}). Messages: ${result.messagesAfter}.`
        );
        return;
      }

      case "/new": {
        await createAndBindSession(conversationKey, undefined, channelUserId);
        await sendText(sendJid, "Started a new conversation.");
        return;
      }

      case "/status":
        await replyStatus(sendJid);
        return;

      case "/profile":
        await handleProfileCommand(
          conversationKey,
          sendJid,
          text,
          channelUserId
        );
        return;

      case "/org":
        await handleOrgCommand(conversationKey, channelOrgKey, sendJid, text);
        return;

      default:
        await sendText(sendJid, "Unknown command. Try /help");
    }
  }

  async function handleAttachRequest(
    conversationKey: string,
    sendJid: string,
    attachUserText: string,
    channelUserId: string
  ): Promise<void> {
    let profileId: string;
    try {
      await resolveSession(conversationKey, channelUserId);
      const storedProfileId = sessionStore.get(conversationKey)?.profileId;
      if (!storedProfileId) {
        throw new Error("WhatsApp session has no profile mapping.");
      }
      profileId = storedProfileId;
    } catch (error) {
      await sendText(
        sendJid,
        isWhatsAppGroupChat(sendJid)
          ? GROUP_SESSION_ERROR_REPLY
          : formatError(error)
      );
      return;
    }

    await maybeSendRequestedWhatsAppArtifactAttachment({
      attachUserText,
      client,
      conversationKey,
      getSocket,
      jid: sendJid,
      profileId,
      sendText: (target, text) => sendText(target, text, { raw: true }),
      sessionStore,
    });
  }

  async function clearSessionArtifactState(
    conversationKey: string
  ): Promise<void> {
    sessionStore.updateArtifactState(conversationKey, {
      artifactShareUrls: {},
      deliverableArtifacts: [],
    });
    await sessionStore.save();
  }

  async function ensureOrgReady(
    channelOrgKey: string,
    messageText: string,
    replyJid: string
  ): Promise<boolean> {
    if (fixedWorkspaceId) {
      client.setOrgId(fixedWorkspaceId);
      if (orgStore.get(channelOrgKey)?.orgId !== fixedWorkspaceId) {
        orgStore.set(channelOrgKey, fixedWorkspaceId);
        await orgStore.save();
      }
      return true;
    }

    const orgContext = await prepareChannelOrgContext({
      getSelectedOrgId: () => orgStore.get(channelOrgKey)?.orgId,
      listOrgs: () => client.listUserOrgs(),
      saveSelectedOrgId: async (orgId) => {
        orgStore.set(channelOrgKey, orgId);
        await orgStore.save();
      },
      text: messageText.startsWith("/") ? undefined : messageText,
    });

    if (orgContext.status === "empty") {
      await sendText(replyJid, "No organizations are configured yet.");
      return false;
    }

    if (orgContext.status === "prompt") {
      await sendText(replyJid, orgContext.message);
      return false;
    }

    client.setOrgId(orgContext.orgId);

    if (orgContext.justSelected) {
      await sendText(replyJid, formatOrgSwitchConfirmation(orgContext.orgName));
      return false;
    }

    return true;
  }

  async function handleOrgCommand(
    conversationKey: string,
    channelOrgKey: string,
    sendJid: string,
    text: string
  ): Promise<void> {
    if (fixedWorkspaceId) {
      await sendText(
        sendJid,
        "This WhatsApp integration belongs to one workspace and cannot switch workspaces."
      );
      return;
    }

    const { orgs } = await client.listUserOrgs();

    if (orgs.length === 0) {
      await sendText(sendJid, "No organizations are configured yet.");
      return;
    }

    const arg = text.trim().split(/\s+/).slice(1).join(" ");
    if (!arg) {
      await sendText(
        sendJid,
        formatOrgSelectionPrompt(orgs, orgStore.get(channelOrgKey)?.orgId)
      );
      return;
    }

    const picked = findOrgBySelectionInput(arg, orgs);
    if (!picked) {
      await sendText(
        sendJid,
        "Unknown organization. Send /org to see the list."
      );
      return;
    }

    const previousOrgId = orgStore.get(channelOrgKey)?.orgId;
    orgStore.set(channelOrgKey, picked.id);
    await orgStore.save();
    client.setOrgId(picked.id);

    if (previousOrgId && previousOrgId !== picked.id) {
      sessionStore.delete(conversationKey);
      await sessionStore.save();
    }

    await sendText(sendJid, formatOrgSwitchConfirmation(picked.name));
  }

  async function handleProfileCommand(
    conversationKey: string,
    sendJid: string,
    text: string,
    channelUserId: string
  ): Promise<void> {
    const profiles = await listSelectableProfiles();
    if (profiles.length === 0) {
      await sendText(sendJid, "No profiles are available.");
      return;
    }

    const arg = text.trim().split(/\s+/).slice(1).join(" ");
    const currentProfileId = (await resolveProfileSelection(conversationKey))
      .profileId;

    if (!arg) {
      await sendText(
        sendJid,
        formatProfileSelectionPrompt(profiles, currentProfileId)
      );
      return;
    }

    const picked = resolveProfileInput(profiles, arg);
    if (!picked) {
      await sendText(
        sendJid,
        "Unknown profile. Send /profile to see the list."
      );
      return;
    }

    if (picked.id === currentProfileId) {
      await sendText(sendJid, `Already using ${picked.name}.`);
      return;
    }

    await createAndBindSession(conversationKey, picked.id, channelUserId, {
      profileOverride: true,
    });
    await sendText(sendJid, formatProfileSwitchConfirmation(picked.name));
  }

  async function tryBuildMediaInput(
    jid: string,
    channelOrgKey: string,
    inbound: WAMessage | null | undefined,
    signal: AbortSignal
  ): Promise<SendMessageInput | "reject" | null> {
    if (!inbound?.message) {
      return null;
    }

    const media = inspectInboundWhatsAppMedia(inbound.message);
    if (!media || media.kind === "unsupported" || media.kind === "audio") {
      return null;
    }

    const result = await buildWhatsAppMediaInput(
      inbound,
      (message, options) =>
        downloadMedia
          ? downloadMedia(message, options)
          : downloadWhatsAppMedia(message, getSocket(), options),
      {
        saveInboundDocument: async (file) => {
          const orgId = fixedWorkspaceId ?? orgStore.get(channelOrgKey)?.orgId;
          if (!orgId) {
            throw new Error("WhatsApp workspace is not selected.");
          }

          const profileId = await resolveProfileId(jid);
          return saveInboundWorkspaceDocument({
            bytes: file.bytes,
            filename: file.filename,
            orgId,
            profileId,
          });
        },
        signal,
      }
    );

    if (!result) {
      return null;
    }

    if (result.kind === "reject") {
      await sendText(jid, result.message);
      return "reject";
    }

    return result.input;
  }

  async function tryBuildAudioInput(
    jid: string,
    inbound: WAMessage | null | undefined,
    signal: AbortSignal
  ): Promise<SendMessageInput | "reject" | null> {
    if (!inbound?.message) {
      return null;
    }

    const result = await buildWhatsAppAudioInput(
      inbound,
      (message, options) =>
        downloadMedia
          ? downloadMedia(message, options)
          : downloadWhatsAppMedia(message, getSocket(), options),
      (input) => client.transcribeAudio(input),
      { signal }
    );

    if (result.kind === "reject") {
      await sendText(jid, result.message);
      return "reject";
    }

    return result.input;
  }

  async function handleChatMessage(
    conversationKey: string,
    jid: string,
    input: SendMessageInput,
    inbound: WAMessage | null | undefined,
    channelUserId: string,
    artifactIntentText: string,
    signal: AbortSignal
  ): Promise<void> {
    const typingLoop = createTypingLoop(getSocket(), jid);
    const todoStatus = new WhatsAppTodoStatusMessage(getSocket(), jid);
    const liveReply = createWhatsAppLiveReply(getSocket, jid);
    let reply = "";
    let earlyAck = false;
    const streamedArtifacts = new Map<string, ChannelArtifactRef>();
    let profileId: string | undefined;
    let session: RemoteChatSession | undefined;

    try {
      session = await waitForAbortable(
        resolveSession(conversationKey, channelUserId),
        signal
      );
      profileId = sessionStore.get(conversationKey)?.profileId;
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
              earlyAck = true;
              return;
            }

            if (reply.trim()) {
              return;
            }

            liveReply.postStatus(WHATSAPP_EARLY_ACK_FALLBACK);
            earlyAck = true;
          },
        },
        { signal }
      );

      await todoStatus.complete();

      if (signal.aborted) {
        if (reply.trim()) {
          if (!(await liveReply.replaceWithFinal(reply.trim()))) {
            await sendText(jid, reply.trim(), { quoted: inbound });
          }
          await sendText(jid, "Stopped.");
        } else if (!(await liveReply.replaceWithFinal("Stopped."))) {
          await sendText(jid, "Stopped.");
        }
        return;
      }
    } catch (error) {
      if (isAbortError(error)) {
        await todoStatus.stop();
        if (reply.trim()) {
          if (!(await liveReply.replaceWithFinal(reply.trim()))) {
            await sendText(jid, reply.trim(), { quoted: inbound });
          }
          await sendText(jid, "Stopped.");
        } else if (!(await liveReply.replaceWithFinal("Stopped."))) {
          await sendText(jid, "Stopped.");
        }
        return;
      }

      await todoStatus.fail();
      const errorText =
        session || !isWhatsAppGroupChat(jid)
          ? formatError(error)
          : GROUP_SESSION_ERROR_REPLY;
      if (!(await liveReply.replaceWithError(errorText))) {
        await sendText(jid, errorText);
      }
      return;
    } finally {
      typingLoop.stop();
    }

    if (reply.trim()) {
      if (!(await liveReply.replaceWithFinal(reply.trim()))) {
        await sendText(jid, reply.trim(), { quoted: inbound });
      }
    } else if (liveReply.hasStatusMessage() || earlyAck) {
      if (!(await liveReply.replaceWithFinal("(empty reply)"))) {
        await sendText(jid, "(empty reply)");
      }
    } else {
      await sendText(jid, "(empty reply)");
    }

    if (profileId && session) {
      await deliverWhatsAppTurnArtifactShares({
        client,
        conversationKey,
        getSocket,
        jid,
        profileId,
        sendText: (target, text) => sendText(target, text, { raw: true }),
        session,
        sessionStore,
        shareUserText: artifactIntentText,
        streamedArtifacts: [...streamedArtifacts.values()],
      });
    }
  }

  function createWhatsAppLiveReply(
    getSocket: () => WASocket | null,
    jid: string
  ) {
    let statusMessageKey: WAMessageKey | null = null;
    let statusRequested = false;
    let lastStatusText = "";
    let lastStatusAt = 0;
    let statusChain = Promise.resolve();

    function requestStatus(status: string) {
      const now = Date.now();
      const normalized = status.trim();

      if (!normalized || normalized === lastStatusText) {
        return;
      }

      if (now - lastStatusAt < WHATSAPP_LIVE_REPLY_STATUS_INTERVAL_MS) {
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

      const socket = getSocket();
      if (!socket) {
        return;
      }

      try {
        if (statusMessageKey === null) {
          const sent = await socket.sendMessage(jid, { text: status });
          statusMessageKey = sent?.key?.id ? sent.key : null;
          return;
        }

        await socket.sendMessage(jid, {
          edit: statusMessageKey,
          text: status,
        });
      } catch {
        // Status updates are best-effort only.
      }
    }

    async function replaceWithFinal(finalText: string): Promise<boolean> {
      await statusChain;
      if (statusMessageKey === null) {
        return false;
      }

      const prepared = prepareWhatsAppReply(finalText);
      const chunks = splitWhatsAppMessage(prepared);
      const first = chunks[0];
      const socket = getSocket();
      if (!(first && socket)) {
        return false;
      }

      try {
        await socket.sendMessage(jid, { edit: statusMessageKey, text: first });
        for (const chunk of chunks.slice(1)) {
          await socket.sendMessage(jid, { text: chunk });
        }
        return true;
      } catch {
        return false;
      }
    }

    async function replaceWithError(errorText: string): Promise<boolean> {
      return replaceWithFinal(`⚠️ ${errorText}`);
    }

    return {
      hasStatusMessage: (): boolean => statusRequested,
      postStatus: (statusText: string): void => {
        requestStatus(statusText);
      },
      replaceWithError,
      replaceWithFinal,
      updateFromReply: (reply: string): void => {
        if (!statusRequested) {
          return;
        }

        const trimmed = reply.trim();
        const preview = trimmed.length
          ? trimmed.slice(0, 70)
          : WHATSAPP_LIVE_WORKING_LABEL;
        requestStatus(`${WHATSAPP_LIVE_WORKING_LABEL}\n\n${preview}`);
      },
      updateTooling: (): void => {
        requestStatus(WHATSAPP_LIVE_TOOL_LABEL);
      },
      updateWorking: (): void => {
        requestStatus(WHATSAPP_LIVE_WORKING_LABEL);
      },
    };
  }

  async function replyStatus(jid: string): Promise<void> {
    try {
      const health = await client.health();
      const lines = [
        `Server: ${health.ok ? "ok" : "degraded"}`,
        `Provider configured: ${health.providerConfigured ? "yes" : "no"}`,
      ];

      if (health.providerConfigured) {
        const models = await client.getModels();
        const profileId = await resolveProfileId(jid);
        const profiles = await client.listProfiles();
        const profile = profiles.profiles.find(
          (entry) => entry.id === profileId
        );
        const modelLabel = profile?.model?.includes("::")
          ? profile.model.slice(profile.model.indexOf("::") + 2)
          : (profile?.model ?? "none");
        lines.push(`Profile: ${profile?.name ?? profileId}`);
        lines.push(`Provider: ${models.provider ?? "unknown"}`);
        lines.push(`Model: ${modelLabel}`);
      } else {
        lines.push("Chat runs in offline mode without an API key.");
      }

      await sendText(jid, lines.join("\n"));
    } catch (error) {
      await sendText(jid, formatError(error));
    }
  }

  async function listSelectableProfiles() {
    const { profiles } = await client.listProfiles();
    return filterProfilesForChatAccess(profiles, { excludeSuperAgent: true });
  }

  async function resolveProfileSelection(jid: string): Promise<{
    profileId: string;
    profileOverride: boolean;
  }> {
    const fileConfig = authStore.getConfig();
    const configuredProfileId =
      fileConfig?.profileId?.trim() || config.profileId;
    const existing = sessionStore.get(jid);
    const profileOverride = existing?.profileOverride === true;
    const preferredProfileId = profileOverride
      ? existing.profileId
      : configuredProfileId;
    const profiles = await listSelectableProfiles();
    const profileId = pickProfileForOrg(profiles, preferredProfileId).id;

    return {
      profileId,
      profileOverride: profileOverride && profileId === existing?.profileId,
    };
  }

  async function resolveProfileId(jid: string): Promise<string> {
    return (await resolveProfileSelection(jid)).profileId;
  }

  async function resolveSession(
    jid: string,
    channelUserId: string
  ): Promise<RemoteChatSession> {
    const selection = await resolveProfileSelection(jid);
    const { profileId } = selection;
    const existing = sessionStore.get(jid);

    if (existing && existing.profileId === profileId) {
      const hot = sessionStore.getHotSession<RemoteChatSession>(jid);
      if (hot) {
        return hot;
      }

      const session = client.createChatSession(existing.sessionId, "whatsapp");

      try {
        await session.getMessages();
        sessionStore.setHotSession(jid, session);
        return session;
      } catch {
        // Session missing on server; create a new one below
      }
    }

    return createAndBindSession(jid, profileId, channelUserId, {
      profileOverride: selection.profileOverride,
    });
  }

  async function createAndBindSession(
    jid: string,
    profileId?: string,
    channelUserId?: string,
    options?: { profileOverride?: boolean }
  ): Promise<RemoteChatSession> {
    const selection = profileId
      ? {
          profileId,
          profileOverride: options?.profileOverride === true,
        }
      : await resolveProfileSelection(jid);
    const resolvedProfileId = selection.profileId;
    const principalUserId = channelUserId?.trim() || jid;
    const session = await client.createSession("whatsapp", {
      externalPrincipal: { channelUserId: principalUserId },
      profileId: resolvedProfileId,
    });

    sessionStore.set(jid, {
      profileId: resolvedProfileId,
      profileOverride: selection.profileOverride || undefined,
      sessionId: session.id,
      updatedAt: new Date().toISOString(),
    });
    sessionStore.setHotSession(jid, session);
    await sessionStore.save();

    return session;
  }

  async function sendText(
    jid: string,
    text: string,
    options?: { quoted?: WAMessage | null; raw?: boolean }
  ): Promise<void> {
    const socket = getSocket();
    if (!socket) {
      console.error("WhatsApp is not connected; dropping outbound text.");
      return;
    }

    const prepared = options?.raw ? text.trim() : prepareWhatsAppReply(text);
    if (!prepared) {
      return;
    }

    const chunks = splitWhatsAppMessage(prepared);
    for (const [index, chunk] of chunks.entries()) {
      await socket.sendMessage(
        jid,
        { text: chunk },
        index === 0 && options?.quoted ? { quoted: options.quoted } : undefined
      );
    }
  }

  return (data: WhatsAppHandlerInput) =>
    client.isolateOrgId(() => handleMessage(data));
}

function normalizeInboundChat(
  data: WhatsAppHandlerInput
): NormalizedWhatsAppHandlerInput {
  const jid = chatKey(data.jid);
  const isGroup = isWhatsAppGroupChat(jid);
  const candidates = [
    ...(data.senderJids ?? []),
    data.senderJid,
    data.senderPn,
  ];
  const senderJids: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const normalized = candidate?.trim() ? chatKey(candidate) : "";
    if (
      normalized &&
      isPrivateWhatsAppChat(normalized) &&
      !seen.has(normalized)
    ) {
      seen.add(normalized);
      senderJids.push(normalized);
    }
  }

  if (!(isGroup || senderJids.length)) {
    senderJids.push(jid);
  }

  const requestedSenderJid = data.senderJid?.trim()
    ? chatKey(data.senderJid)
    : "";
  const senderJid = isPrivateWhatsAppChat(requestedSenderJid)
    ? requestedSenderJid
    : (senderJids[0] ?? "");

  return {
    fromMe: data.fromMe ?? false,
    inbound: data.inbound,
    isGroup,
    jid,
    me: data.me,
    mentionedJids: data.mentionedJids ?? [],
    quotedParticipant: data.quotedParticipant ?? null,
    quotedText: data.quotedText ?? null,
    senderJid,
    senderJids,
    senderPn: data.senderPn ?? null,
    text: data.text,
  };
}

function withInboundGroupContext(
  input: SendMessageInput,
  inbound: WhatsAppInboundChat
): SendMessageInput {
  if (!inbound.isGroup) {
    return input;
  }

  const quote = truncateQuotedContext(inbound.quotedText);
  const message = input.message?.trim() ?? "";
  const withQuote = quote
    ? message
      ? `[Quoted message]\n${quote}\n\n${message}`
      : `[Quoted message]\n${quote}`
    : message;

  return {
    ...input,
    message: withQuote
      ? `${GROUP_MESSAGE_PREFIX}${withQuote}`
      : GROUP_MESSAGE_PREFIX.trim(),
  };
}

function truncateQuotedContext(quotedText: string | null): string {
  const quote = quotedText?.trim() ?? "";
  if (quote.length <= MAX_QUOTED_CONTEXT_LENGTH) {
    return quote;
  }

  return `${quote.slice(0, MAX_QUOTED_CONTEXT_LENGTH)}…`;
}

function chatKey(jid: string): string {
  return normalizeWhatsAppUserJid(jid);
}

function parseCommand(text: string): string {
  const token = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return token;
}

function isStopCommand(text: string): boolean {
  return parseCommand(text) === "/stop";
}

function looksLikePairingCodeAttempt(text: string): boolean {
  const trimmed = text.trim();

  if (!trimmed || /\s/.test(trimmed) || trimmed.startsWith("/")) {
    return false;
  }

  if (/^[0-9A-F]{8}$/.test(normalizePairingCode(trimmed))) {
    return true;
  }

  return trimmed === trimmed.toUpperCase() && /^[A-Z0-9-]{4,12}$/.test(trimmed);
}

export function resetChatLocksForTests(): void {
  chatLocks.clear();
  rateLimiter.reset();
}

export async function withChatLock(
  jid: string,
  fn: () => Promise<void>
): Promise<void> {
  const previous = chatLocks.get(jid) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(
    () => current,
    () => current
  );
  chatLocks.set(jid, chain);

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
    if (chatLocks.get(jid) === chain) {
      chatLocks.delete(jid);
    }
  }
}

export function seedChatLockForTests(
  jid: string,
  promise: Promise<void>
): void {
  chatLocks.set(jid, promise);
}
