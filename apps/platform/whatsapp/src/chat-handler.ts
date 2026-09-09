import type { AtlasClient, RemoteChatSession } from "@atlas/client";
import {
  type ChannelArtifactRef,
  channelArtifactRefFromArtifact,
  isAttachOnlyCommand,
  saveInboundWorkspaceDocument,
} from "@atlas/core";
import type { SaveInboundDocument } from "@atlas/core/attachments/inbound-document";
import {
  type ChannelOrgStore,
  findOrgBySelectionInput,
  formatOrgSelectionPrompt,
  formatOrgSwitchConfirmation,
  prepareChannelOrgContext,
} from "@atlas/core/channel-org";
import { ChannelRateLimiter } from "@atlas/core/channel-rate-limiter";
import type { SendMessageInput } from "@atlas/core/contract";
import {
  throwIfSignalAborted,
  waitForAbortable,
} from "@atlas/core/download-deadline";
import {
  filterProfilesForChatAccess,
  formatProfileSelectionPrompt,
  formatProfileSwitchConfirmation,
  pickProfileForOrg,
  resolveProfileInput,
} from "@atlas/core/profiles";
import {
  isWhatsAppPairingCodeActive,
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
  isWhatsAppDeliveryRetryableError,
  isWhatsAppInboundReplaySafeError,
  WhatsAppDeliveryRetryableError,
  WhatsAppInboundReplaySafeError,
} from "./delivery-error";
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
import { allowUnaddressedWhatsAppGroup } from "./group-policy";
import {
  inspectInboundWhatsAppMedia,
  isPrivateWhatsAppChat,
  type WhatsAppInboundChat,
} from "./inbound-message";
import {
  executeWhatsAppNativeAction,
  WhatsAppMessageRegistry,
} from "./native-actions";
import {
  type WhatsAppNativeBinding,
  WhatsAppNativeControls,
  type WhatsAppNativeReaction,
} from "./native-controls";
import type { SessionStore } from "./session-store";
import { WhatsAppTodoStatusMessage } from "./todo-status-message";
import { createTypingLoop } from "./typing-indicator";

const chatLocks = new Map<string, Promise<void>>();
const rateLimiter = new ChannelRateLimiter();
const MAX_MESSAGE_LENGTH = 2000;
const MAX_QUOTED_CONTEXT_LENGTH = 4000;
const LOCK_TIMEOUT_MS = 120_000;
const DEFAULT_SEND_TIMEOUT_MS = 30_000;
const DEFAULT_SEND_RETRY_ATTEMPTS = 3;
const DEFAULT_SEND_RETRY_BASE_DELAY_MS = 250;
const MAX_SEND_RETRY_ATTEMPTS = 5;
const MAX_SEND_RETRY_DELAY_MS = 5000;
const TRANSIENT_SEND_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_SOCKET_CLOSED",
  "ETIMEDOUT",
  "WHATSAPP_SOCKET_UNAVAILABLE",
]);
const TRANSIENT_SEND_MESSAGE =
  /\b(?:connection (?:closed|reset)|disconnected|network|rate.?limit|restart required|socket (?:closed|disconnected|hang up)|temporar(?:y|ily)|try again)\b/i;

export { WhatsAppDeliveryRetryableError };

class WhatsAppSendTimeoutError extends Error {
  readonly code = "WHATSAPP_SEND_TIMEOUT";

  constructor() {
    super("WhatsApp send timed out.");
    this.name = "TimeoutError";
  }
}

class WhatsAppSocketUnavailableError extends Error {
  readonly code = "WHATSAPP_SOCKET_UNAVAILABLE";

  constructor() {
    super("WhatsApp is not connected.");
    this.name = "NetworkError";
  }
}

export class WhatsAppChatBusyError extends Error {
  readonly code = "WHATSAPP_CHAT_BUSY";
  readonly retryable = true;

  constructor() {
    super("WhatsApp chat is busy processing another message.");
    this.name = "TimeoutError";
  }
}

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

const PAIRING_BIND_ERROR_REPLY =
  "Atlas could not finish authorizing this chat. The chat access code is still active; try again.";

const IDENTITY_LINK_REQUIRED_REPLY =
  "This WhatsApp sender is permitted but is not linked to an Atlas user yet. Ask a workspace admin to generate a chat access code, then send it here.";

export interface ChatHandlerDeps {
  authStore: WhatsAppAuthStore;
  client: AtlasClient;
  config: WhatsAppBridgeConfig;
  downloadMedia?: WhatsAppMediaDownload;
  fixedWorkspaceId?: string;
  getSocket: () => WASocket | null;
  orgStore: ChannelOrgStore;
  sendRetryAttempts?: number;
  sendRetryBaseDelayMs?: number;
  sendTimeoutMs?: number;
  sessionStore: SessionStore;
}

type WhatsAppHandlerInput = Pick<WhatsAppInboundChat, "jid" | "text"> &
  Partial<Omit<WhatsAppInboundChat, "jid" | "text">> & {
    inbound?: WAMessage | null;
  };

type NormalizedWhatsAppHandlerInput = WhatsAppInboundChat & {
  inbound?: WAMessage | null;
};

interface WhatsAppSessionPrincipal {
  channelAddressed?: boolean;
  channelChatId: string;
  channelIsGroup?: boolean;
  channelUserAliases: string[];
  channelUserId: string;
}

interface InboundReplayBoundary {
  replayUnsafe: boolean;
}

export function createChatHandler(deps: ChatHandlerDeps) {
  const nativeControls = new WhatsAppNativeControls();
  const messageRegistry = new WhatsAppMessageRegistry();
  const {
    client,
    config,
    authStore,
    sessionStore,
    orgStore,
    getSocket,
    fixedWorkspaceId,
    downloadMedia,
    sendRetryAttempts = DEFAULT_SEND_RETRY_ATTEMPTS,
    sendRetryBaseDelayMs = DEFAULT_SEND_RETRY_BASE_DELAY_MS,
    sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
  } = deps;
  if (!(Number.isFinite(sendTimeoutMs) && sendTimeoutMs > 0)) {
    throw new RangeError("WhatsApp send timeout must be greater than zero.");
  }
  if (
    !(
      Number.isInteger(sendRetryAttempts) &&
      sendRetryAttempts > 0 &&
      sendRetryAttempts <= MAX_SEND_RETRY_ATTEMPTS
    )
  ) {
    throw new RangeError(
      `WhatsApp send retry attempts must be between 1 and ${MAX_SEND_RETRY_ATTEMPTS}.`
    );
  }
  if (
    !(
      Number.isFinite(sendRetryBaseDelayMs) &&
      sendRetryBaseDelayMs >= 0 &&
      sendRetryBaseDelayMs <= MAX_SEND_RETRY_DELAY_MS
    )
  ) {
    throw new RangeError(
      `WhatsApp send retry delay must be between 0 and ${MAX_SEND_RETRY_DELAY_MS} milliseconds.`
    );
  }
  const helpText = formatHelpText({
    workspaceLocked: Boolean(fixedWorkspaceId),
  });

  async function handleMessage(
    data: WhatsAppHandlerInput,
    replayBoundary: InboundReplayBoundary
  ): Promise<void> {
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

    const requiresGroupAddress = Boolean(
      groupDecision &&
        !groupDecision.shouldHandle &&
        !(await allowUnaddressedWhatsAppGroup(
          fixedWorkspaceId ?? orgStore.get(channelOrgKey)?.orgId,
          inboundChat
        ))
    );
    if (requiresGroupAddress && !media) {
      console.log(
        `Ignored WhatsApp group message reason=${groupDecision?.reason}`
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
      if (!authStore.isAuthorized(jid, { senderPn })) {
        return;
      }
      if (
        !(await canStopSession(conversationKey, channelOrgKey, inboundChat))
      ) {
        return;
      }
      replayBoundary.replayUnsafe = true;
      if (!stopActiveStream(conversationKey)) {
        await sendText(jid, "Nothing to stop.");
      }

      return;
    }

    if (isGroup && isStopCommand(trimmed)) {
      replayBoundary.replayUnsafe = true;
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

      const senderSessionKey = resolveWhatsAppSessionKey(
        conversationKey,
        inboundChat.senderJid
      );
      if (
        !(await canStopSession(senderSessionKey, channelOrgKey, inboundChat))
      ) {
        return;
      }
      if (!stopActiveStream(senderSessionKey)) {
        await sendText(jid, "Nothing to stop.");
      }
      return;
    }

    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      replayBoundary.replayUnsafe = true;
      await sendText(
        jid,
        "Message is too long (maximum 2,000 characters). Please shorten your message."
      );
      return;
    }

    const rateLimitKey = isGroup
      ? `${conversationKey}:${inboundChat.senderJid}`
      : conversationKey;
    // The limiter mutates its sliding window. From this point onward, replaying
    // the whole handler could consume the same inbound message more than once.
    replayBoundary.replayUnsafe = true;
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
      const senderJids = isGroup
        ? inboundChat.senderJids
        : [conversationKey, ...inboundChat.senderJids].filter(
            (senderJid, index, values) => values.indexOf(senderJid) === index
          );
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
      const sessionPrincipal: WhatsAppSessionPrincipal = {
        channelAddressed: groupDecision?.shouldHandle ?? true,
        channelChatId: jid,
        channelIsGroup: isWhatsAppGroupChat(jid),
        channelUserAliases: senderJids.filter(
          (senderJid) => senderJid !== principalChannelUserId
        ),
        channelUserId: principalChannelUserId,
      };

      const isExactActivePairingCode = Boolean(
        !isGroup &&
          fileConfig?.pairingCode &&
          isWhatsAppPairingCodeActive(fileConfig) &&
          normalizePairingCode(trimmed) ===
            normalizePairingCode(fileConfig.pairingCode)
      );
      if (isExactActivePairingCode) {
        replayBoundary.replayUnsafe = true;
        await handlePairing(jid, trimmed);
        return;
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

        replayBoundary.replayUnsafe = true;
        await handlePairing(jid, trimmed);
        return;
      }

      if (requiresGroupAddress) {
        await sendText(
          jid,
          "This file was ignored because this group requires a mention. Resend it with an @mention of Atlas, or reply to an Atlas message."
        );
        return;
      }

      const sessionKey = resolveWhatsAppSessionKey(
        conversationKey,
        principalChannelUserId
      );

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
        replayBoundary.replayUnsafe = true;
        await handleAttachRequest(
          sessionKey,
          jid,
          messageText,
          sessionPrincipal
        );
        return;
      }

      const attachCommandHasInstructions =
        command === "/attach" && !isAttachOnlyCommand(messageText);
      if (trimmed.startsWith("/") && !attachCommandHasInstructions) {
        replayBoundary.replayUnsafe = true;
        try {
          await handleCommand(
            sessionKey,
            channelOrgKey,
            jid,
            trimmed,
            sessionPrincipal
          );
        } catch (error) {
          await sendText(
            jid,
            isGroup ? GROUP_SESSION_ERROR_REPLY : formatError(error)
          );
        }
        return;
      }

      const signal = registerActiveStream(sessionKey);
      try {
        const preparedSession = media
          ? await waitForAbortable(
              resolveSession(sessionKey, sessionPrincipal),
              signal
            )
          : undefined;
        if (media) {
          replayBoundary.replayUnsafe = true;
        }

        const mediaInput = await tryBuildMediaInput(
          sessionKey,
          jid,
          channelOrgKey,
          inbound,
          sessionPrincipal,
          signal
        );
        if (mediaInput === "reject") {
          return;
        }

        if (mediaInput) {
          replayBoundary.replayUnsafe = true;
          await handleChatMessage(
            sessionKey,
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
            sessionPrincipal,
            messageText,
            signal,
            preparedSession
          );
          return;
        }

        if (media?.kind === "audio") {
          if (!preparedSession) {
            throw new Error("WhatsApp audio requires an authorized session.");
          }

          replayBoundary.replayUnsafe = true;
          const audioInput = await tryBuildAudioInput({
            caption: messageText,
            channelOrgKey,
            inbound,
            jid,
            principal: sessionPrincipal,
            sessionId: preparedSession.id,
            sessionKey,
            signal,
          });
          if (audioInput === "reject") {
            return;
          }

          if (audioInput) {
            await handleChatMessage(
              sessionKey,
              jid,
              withInboundGroupContext(audioInput, inboundChat),
              inbound,
              sessionPrincipal,
              messageText,
              signal,
              preparedSession
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

        replayBoundary.replayUnsafe = true;
        await handleChatMessage(
          sessionKey,
          jid,
          withInboundGroupContext({ message: messageText }, inboundChat),
          inbound,
          sessionPrincipal,
          messageText,
          signal
        );
      } catch (error) {
        await sendText(
          jid,
          isAbortError(error) ? "Stopped." : formatError(error)
        );
      } finally {
        clearActiveStream(sessionKey, signal);
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

  async function canStopSession(
    sessionKey: string,
    channelOrgKey: string,
    inboundChat: NormalizedWhatsAppHandlerInput
  ): Promise<boolean> {
    const existing = sessionStore.get(sessionKey);
    if (!existing) {
      return true;
    }
    const orgId = fixedWorkspaceId ?? orgStore.get(channelOrgKey)?.orgId;
    if (!orgId) {
      return false;
    }
    client.setOrgId(orgId);
    try {
      await client.authorizeChannelPrincipal({
        channel: "whatsapp",
        channelAddressed: true,
        channelChatId: inboundChat.jid,
        channelIsGroup: inboundChat.isGroup,
        channelUserAliases: inboundChat.senderJids.filter(
          (jid) => jid !== inboundChat.senderJid
        ),
        channelUserId: inboundChat.senderJid,
        intent: "invoke",
        profileId: existing.profileId,
        sessionId: existing.sessionId,
      });
      return true;
    } catch {
      return false;
    }
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

    const channelUserId = chatKey(jid);
    let result: { message: string; ok: boolean };
    try {
      result = await authStore.tryPair(
        text,
        channelUserId,
        async ({ pairingAssertion, pairingUserId }) => {
          await bindPendingChannelPrincipal(
            channelUserId,
            pairingAssertion,
            pairingUserId
          );
        }
      );
    } catch (error) {
      console.error("Failed to bind WhatsApp channel principal.", {
        errorType: getSafeWhatsAppErrorType(error),
      });
      await sendText(jid, PAIRING_BIND_ERROR_REPLY);
      return;
    }

    await sendText(jid, result.message);
  }

  async function bindPendingChannelPrincipal(
    channelUserId: string,
    pairingAssertion: string,
    pairingUserId: string
  ): Promise<void> {
    const assertion = pairingAssertion.trim();
    const expectedUserId = pairingUserId.trim();
    const orgId = fixedWorkspaceId ?? orgStore.get(channelUserId)?.orgId;
    if (!orgId) {
      throw new Error(
        "WhatsApp pairing requires an authoritative workspace context."
      );
    }
    client.setOrgId(orgId);
    const principal = await client.bindChannelPrincipal({
      channel: "whatsapp",
      channelUserId,
      expectedUserId,
      pairingAssertion: assertion,
    });
    if (principal.orgId !== orgId || principal.userId !== expectedUserId) {
      throw new Error(
        "WhatsApp pairing principal did not match the pending authorization."
      );
    }

    const invalidatedSessionKeys =
      sessionStore.deleteByChannelUserId(channelUserId);
    for (const sessionKey of invalidatedSessionKeys) {
      stopActiveStream(sessionKey);
    }
    await sessionStore.save();
  }

  async function handleCommand(
    sessionKey: string,
    channelOrgKey: string,
    sendJid: string,
    text: string,
    principal: WhatsAppSessionPrincipal
  ): Promise<void> {
    const command = parseCommand(text);

    switch (command) {
      case "/start":
      case "/help":
        await sendText(sendJid, helpText);
        return;

      case "/clear": {
        const session = await resolveSession(sessionKey, principal);
        await session.clear();
        await clearSessionArtifactState(sessionKey);
        await sendText(sendJid, "History cleared.");
        return;
      }

      case "/attach":
        await handleAttachRequest(sessionKey, sendJid, text, principal);
        return;

      case "/compact": {
        const session = await resolveSession(sessionKey, principal);
        const result = await session.compact({ force: true });
        await sendText(
          sendJid,
          `Compacted (${result.action}). Messages: ${result.messagesAfter}.`
        );
        return;
      }

      case "/new": {
        await createAndBindSession(sessionKey, undefined, principal);
        await sendText(sendJid, "Started a new conversation.");
        return;
      }

      case "/status":
        await replyStatus(sendJid, sessionKey);
        return;

      case "/profile":
        await handleProfileCommand(sessionKey, sendJid, text, principal);
        return;

      case "/org":
        await handleOrgCommand(sessionKey, channelOrgKey, sendJid, text);
        return;

      default:
        await sendText(sendJid, "Unknown command. Try /help");
    }
  }

  async function handleAttachRequest(
    sessionKey: string,
    sendJid: string,
    attachUserText: string,
    principal: WhatsAppSessionPrincipal
  ): Promise<void> {
    let profileId: string;
    let deliverySessionId: string;
    try {
      const session = await resolveSession(sessionKey, principal, "read");
      deliverySessionId = session.id;
      const storedProfileId = sessionStore.get(sessionKey)?.profileId;
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
      beforeDelivery: async () => {
        if (sessionStore.get(sessionKey)?.sessionId !== deliverySessionId) {
          throw new Error("WhatsApp session has changed.");
        }
        await client.authorizeChannelPrincipal({
          ...principal,
          channel: "whatsapp",
          intent: "read",
          profileId,
          sessionId: deliverySessionId,
        });
      },
      client,
      conversationKey: sessionKey,
      getSocket,
      jid: sendJid,
      profileId,
      sendText: (target, text) => sendText(target, text, { raw: true }),
      sessionStore,
    });
  }

  async function clearSessionArtifactState(sessionKey: string): Promise<void> {
    sessionStore.updateArtifactState(sessionKey, {
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
    sessionKey: string,
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
      sessionStore.delete(sessionKey);
      await sessionStore.save();
    }

    await sendText(sendJid, formatOrgSwitchConfirmation(picked.name));
  }

  async function handleProfileCommand(
    sessionKey: string,
    sendJid: string,
    text: string,
    principal: WhatsAppSessionPrincipal
  ): Promise<void> {
    const profiles = await listSelectableProfiles();
    if (profiles.length === 0) {
      await sendText(sendJid, "No profiles are available.");
      return;
    }

    const arg = text.trim().split(/\s+/).slice(1).join(" ");
    const currentProfileId = (await resolveProfileSelection(sessionKey))
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

    await createAndBindSession(sessionKey, picked.id, principal, {
      profileOverride: true,
    });
    await sendText(sendJid, formatProfileSwitchConfirmation(picked.name));
  }

  async function tryBuildMediaInput(
    sessionKey: string,
    jid: string,
    channelOrgKey: string,
    inbound: WAMessage | null | undefined,
    principal: WhatsAppSessionPrincipal,
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
        saveInboundDocument: createInboundDocumentSaver(
          sessionKey,
          channelOrgKey,
          principal,
          signal
        ),
        signal,
        transcribeVideoAudio: (input) =>
          client.transcribeAudio({
            ...input,
            sessionId: sessionStore.get(sessionKey)!.sessionId,
          }),
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

  async function authorizeInboundFile(
    sessionKey: string,
    channelOrgKey: string,
    principal: WhatsAppSessionPrincipal,
    signal: AbortSignal
  ): Promise<{ orgId: string; profileId: string }> {
    throwIfSignalAborted(signal);
    const orgId = fixedWorkspaceId ?? orgStore.get(channelOrgKey)?.orgId;
    if (!orgId) {
      throw new Error("WhatsApp workspace is not selected.");
    }

    const profileId = await resolveProfileId(sessionKey);
    await client.authorizeChannelPrincipal({
      channel: "whatsapp",
      channelAddressed: principal.channelAddressed,
      channelChatId: principal.channelChatId,
      channelIsGroup: isWhatsAppGroupChat(principal.channelChatId),
      channelUserAliases: principal.channelUserAliases,
      channelUserId: principal.channelUserId,
      intent: "files",
      profileId,
      sessionId: sessionStore.get(sessionKey)?.sessionId,
    });
    throwIfSignalAborted(signal);
    return { orgId, profileId };
  }

  function createInboundDocumentSaver(
    sessionKey: string,
    channelOrgKey: string,
    principal: WhatsAppSessionPrincipal,
    signal: AbortSignal
  ): SaveInboundDocument {
    return async (file) => {
      const scope = await authorizeInboundFile(
        sessionKey,
        channelOrgKey,
        principal,
        signal
      );
      return saveInboundWorkspaceDocument({
        bytes: file.bytes,
        filename: file.filename,
        ...scope,
      });
    };
  }

  async function tryBuildAudioInput({
    caption,
    channelOrgKey,
    inbound,
    jid,
    principal,
    sessionId,
    sessionKey,
    signal,
  }: {
    caption: string;
    channelOrgKey: string;
    inbound: WAMessage | null | undefined;
    jid: string;
    principal: WhatsAppSessionPrincipal;
    sessionId: string;
    sessionKey: string;
    signal: AbortSignal;
  }): Promise<SendMessageInput | "reject" | null> {
    if (!inbound?.message) {
      return null;
    }

    await authorizeInboundFile(sessionKey, channelOrgKey, principal, signal);
    const result = await buildWhatsAppAudioInput(
      inbound,
      (message, options) =>
        downloadMedia
          ? downloadMedia(message, options)
          : downloadWhatsAppMedia(message, getSocket(), options),
      (input) => client.transcribeAudio({ ...input, sessionId }),
      {
        caption,
        saveInboundDocument: createInboundDocumentSaver(
          sessionKey,
          channelOrgKey,
          principal,
          signal
        ),
        signal,
      }
    );

    if (result.kind === "reject") {
      await sendText(jid, result.message);
      return "reject";
    }

    return result.input;
  }

  async function handleChatMessage(
    sessionKey: string,
    jid: string,
    input: SendMessageInput,
    inbound: WAMessage | null | undefined,
    principal: WhatsAppSessionPrincipal,
    artifactIntentText: string,
    signal: AbortSignal,
    preparedSession?: RemoteChatSession
  ): Promise<void> {
    const typingLoop = createTypingLoop(getSocket(), jid);
    const todoStatus = new WhatsAppTodoStatusMessage(getSocket(), jid);
    let outgoingBinding: WhatsAppNativeBinding | undefined;
    const liveReply = createWhatsAppLiveReply(getSocket, jid, (key) => {
      if (outgoingBinding) {
        messageRegistry.remember(outgoingBinding, key);
      }
    });
    let reply = "";
    let earlyAck = false;
    const streamedArtifacts = new Map<string, ChannelArtifactRef>();
    const nativeMediaPaths = new Set<string>();
    let profileId: string | undefined;
    let session: RemoteChatSession | undefined;
    let controlsPending = Promise.resolve();
    const enqueueControl = (operation: () => Promise<void>) => {
      controlsPending = controlsPending.then(operation).catch((error) => {
        console.error("WhatsApp native control failed.", {
          errorType: getSafeWhatsAppErrorType(error),
        });
      });
    };

    try {
      session =
        preparedSession ??
        (await waitForAbortable(resolveSession(sessionKey, principal), signal));
      profileId = sessionStore.get(sessionKey)?.profileId;
      const canonical = await client.authorizeChannelPrincipal({
        channel: "whatsapp",
        channelAddressed: principal.channelAddressed,
        channelChatId: jid,
        channelIsGroup: isWhatsAppGroupChat(jid),
        channelUserAliases: principal.channelUserAliases,
        channelUserId: principal.channelUserId,
        intent: "invoke",
        profileId,
        sessionId: session.id,
      });
      if (!profileId) {
        throw new Error("WhatsApp session profile is missing.");
      }
      const nativeBinding: WhatsAppNativeBinding = {
        ...principal,
        destination: jid,
        orgId: canonical.orgId,
        profileId,
        sessionId: session.id,
        userId: canonical.userId,
      };
      outgoingBinding = nativeBinding;
      await client.bindChannelActionContext({
        channel: "whatsapp",
        channelAddressed: principal.channelAddressed,
        channelChatId: jid,
        channelIsGroup: isWhatsAppGroupChat(jid),
        channelUserAliases: principal.channelUserAliases,
        channelUserId: principal.channelUserId,
        sessionId: session.id,
      });
      if (inbound?.key) {
        messageRegistry.remember(nativeBinding, inbound.key);
      }
      typingLoop.start();

      reply = await session.sendStream(
        input,
        {
          onApprovalRequested: (approval) => {
            enqueueControl(async () => {
              const socket = getSocket();
              if (!socket) {
                throw new Error("WhatsApp is disconnected.");
              }
              await nativeControls.approval({
                approval,
                binding: nativeBinding,
                decide: async (decision, reaction) => {
                  await client.decideChannelApproval({
                    approvalId: approval.id,
                    channel: "whatsapp",
                    channelAddressed: true,
                    channelChatId: jid,
                    channelIsGroup: isWhatsAppGroupChat(jid),
                    channelUserAliases: reaction.actorAliases,
                    channelUserId: reaction.actorId,
                    decision,
                    profileId: nativeBinding.profileId,
                    sessionId: nativeBinding.sessionId,
                  });
                },
                socket,
              });
            });
          },
          onArtifactCreated: (artifact) => {
            const ref = channelArtifactRefFromArtifact(artifact);
            if (ref) {
              streamedArtifacts.set(ref.path, ref);
            }
          },
          onChannelActionRequested: (request) => {
            enqueueControl(async () => {
              const actor = {
                channel: "whatsapp" as const,
                channelAddressed: principal.channelAddressed,
                channelChatId: jid,
                channelIsGroup: isWhatsAppGroupChat(jid),
                channelUserAliases: principal.channelUserAliases,
                channelUserId: principal.channelUserId,
                requestId: request.id,
                sessionId: nativeBinding.sessionId,
              };
              const claimed = await client.claimChannelAction(actor);
              const receipt = await executeWhatsAppNativeAction({
                beforeSend: async () => {
                  await client.authorizeChannelPrincipal({
                    ...principal,
                    channel: "whatsapp",
                    intent: "files",
                    nativeAction: claimed.action.kind,
                    profileId: nativeBinding.profileId,
                    sessionId: nativeBinding.sessionId,
                  });
                },
                binding: nativeBinding,
                currentMessageId: inbound?.key.id ?? undefined,
                readMedia: async (path) => {
                  await client.authorizeChannelPrincipal({
                    ...principal,
                    channel: "whatsapp",
                    intent: "files",
                    profileId: nativeBinding.profileId,
                    sessionId: nativeBinding.sessionId,
                  });
                  const file = await client.readProfileArtifactContent(
                    nativeBinding.profileId,
                    path,
                    { sessionId: nativeBinding.sessionId }
                  );
                  return {
                    bytes: new Uint8Array(file.data),
                    filename: path.split("/").at(-1) ?? "artifact",
                    mimeType: file.contentType.split(";")[0]!.trim(),
                  };
                },
                registry: messageRegistry,
                request: claimed,
                signal,
                socket: getSocket(),
              });
              if (
                claimed.action.kind === "send_media" &&
                receipt.status !== "failed"
              ) {
                nativeMediaPaths.add(claimed.action.path);
              }
              await client.completeChannelAction({ ...actor, receipt });
            });
          },
          onChunk: (delta) => {
            reply += delta;
            liveReply.updateFromReply(reply);
          },
          onQuestionnaireUpdated: (questionnaire) => {
            if (!questionnaire?.questions.length) {
              enqueueControl(async () =>
                nativeControls.clearQuestionnaire(nativeBinding)
              );
              return;
            }
            const questionnaireSnapshot = structuredClone(questionnaire);
            enqueueControl(async () => {
              const socket = getSocket();
              if (!socket) {
                throw new Error("WhatsApp is disconnected.");
              }
              await nativeControls.questionnaire({
                answer: async (answer, reaction) => {
                  await withChatLock(chatKey(jid), async () => {
                    client.setOrgId(nativeBinding.orgId);
                    const currentPrincipal = {
                      channelAddressed: true,
                      channelChatId: jid,
                      channelIsGroup: isWhatsAppGroupChat(jid),
                      channelUserAliases: reaction.actorAliases,
                      channelUserId: reaction.actorId,
                    };
                    const active = await resolveSession(
                      sessionKey,
                      currentPrincipal
                    );
                    if (active.id !== nativeBinding.sessionId) {
                      throw new Error(
                        "WhatsApp questionnaire session has changed."
                      );
                    }
                    const answerSignal = registerActiveStream(sessionKey);
                    try {
                      await handleChatMessage(
                        sessionKey,
                        jid,
                        {
                          expectedQuestionnaire: questionnaireSnapshot,
                          message: isWhatsAppGroupChat(jid)
                            ? `${GROUP_MESSAGE_PREFIX}${answer}`
                            : answer,
                        },
                        undefined,
                        currentPrincipal,
                        "",
                        answerSignal,
                        active
                      );
                    } finally {
                      clearActiveStream(sessionKey, answerSignal);
                    }
                  });
                },
                binding: nativeBinding,
                questionnaire: questionnaireSnapshot,
                socket,
              });
            });
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

      await controlsPending;

      await todoStatus.complete();

      if (signal.aborted) {
        if (reply.trim()) {
          if (!(await liveReply.replaceWithFinal(reply.trim()))) {
            await sendText(jid, reply.trim(), {
              binding: outgoingBinding,
              quoted: inbound,
            });
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
            await sendText(jid, reply.trim(), {
              binding: outgoingBinding,
              quoted: inbound,
            });
          }
          await sendText(jid, "Stopped.");
        } else if (!(await liveReply.replaceWithFinal("Stopped."))) {
          await sendText(jid, "Stopped.");
        }
        return;
      }

      await todoStatus.fail();
      const errorText = session
        ? formatError(error)
        : formatSessionOpenError(jid, error);
      if (!(await liveReply.replaceWithError(errorText))) {
        await sendText(jid, errorText);
      }
      return;
    } finally {
      typingLoop.stop();
    }

    if (reply.trim()) {
      if (!(await liveReply.replaceWithFinal(reply.trim()))) {
        await sendText(jid, reply.trim(), {
          binding: outgoingBinding,
          quoted: inbound,
        });
      }
    } else if (liveReply.hasStatusMessage() || earlyAck) {
      if (!(await liveReply.replaceWithFinal("(empty reply)"))) {
        await sendText(jid, "(empty reply)");
      }
    } else {
      await sendText(jid, "(empty reply)");
    }

    if (profileId && session) {
      const deliverySessionId = session.id;
      await client.authorizeChannelPrincipal({
        channel: "whatsapp",
        channelAddressed: principal.channelAddressed,
        channelChatId: principal.channelChatId,
        channelIsGroup: isWhatsAppGroupChat(principal.channelChatId),
        channelUserAliases: principal.channelUserAliases,
        channelUserId: principal.channelUserId,
        intent: "read",
        profileId,
        sessionId: session.id,
      });
      await deliverWhatsAppTurnArtifactShares({
        alreadyDeliveredPaths: [...nativeMediaPaths],
        beforeDelivery: async () => {
          if (sessionStore.get(sessionKey)?.sessionId !== deliverySessionId) {
            throw new Error("WhatsApp session has changed.");
          }
          await client.authorizeChannelPrincipal({
            ...principal,
            channel: "whatsapp",
            intent: "read",
            profileId,
            sessionId: deliverySessionId,
          });
        },
        client,
        conversationKey: sessionKey,
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
    jid: string,
    onSent: (key: WAMessageKey) => void
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
          if (statusMessageKey) {
            onSent(statusMessageKey);
          }
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
          const sent = await socket.sendMessage(jid, { text: chunk });
          if (sent?.key) {
            onSent(sent.key);
          }
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

  async function replyStatus(jid: string, sessionKey: string): Promise<void> {
    try {
      const health = await client.health();
      const lines = [
        `Server: ${health.ok ? "ok" : "degraded"}`,
        `Provider configured: ${health.providerConfigured ? "yes" : "no"}`,
      ];

      if (health.providerConfigured) {
        const models = await client.getModels();
        const profileId = await resolveProfileId(sessionKey);
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
    sessionKey: string,
    principal: WhatsAppSessionPrincipal,
    intent: "invoke" | "read" = "invoke"
  ): Promise<RemoteChatSession> {
    const selection = await resolveProfileSelection(sessionKey);
    const { profileId } = selection;
    const existing = sessionStore.get(sessionKey);
    const normalizedChannelUserId = chatKey(principal.channelUserId);
    const existingChannelUserId = existing?.channelUserId
      ? chatKey(existing.channelUserId)
      : null;
    const belongsToCurrentSender = existingChannelUserId
      ? existingChannelUserId === normalizedChannelUserId
      : sessionKey === normalizedChannelUserId;

    if (
      existing &&
      existing.profileId === profileId &&
      belongsToCurrentSender
    ) {
      await client.authorizeChannelPrincipal({
        channel: "whatsapp",
        channelAddressed: principal.channelAddressed,
        channelChatId: principal.channelChatId,
        channelIsGroup: isWhatsAppGroupChat(principal.channelChatId),
        channelUserAliases: principal.channelUserAliases,
        channelUserId: principal.channelUserId,
        intent,
        profileId,
        sessionId: existing.sessionId,
      });
      const hot = sessionStore.getHotSession<RemoteChatSession>(sessionKey);
      if (hot) {
        return hot;
      }
      const session = client.createChatSession(existing.sessionId, "whatsapp");

      try {
        await session.getMessages();
        sessionStore.setHotSession(sessionKey, session);
        return session;
      } catch {
        // Session missing on server; create a new one below
      }
    }

    return createAndBindSession(sessionKey, profileId, principal, {
      profileOverride: selection.profileOverride,
    });
  }

  async function createAndBindSession(
    sessionKey: string,
    profileId: string | undefined,
    principal: WhatsAppSessionPrincipal,
    options?: { profileOverride?: boolean }
  ): Promise<RemoteChatSession> {
    const selection = profileId
      ? {
          profileId,
          profileOverride: options?.profileOverride === true,
        }
      : await resolveProfileSelection(sessionKey);
    const resolvedProfileId = selection.profileId;
    const principalUserId = principal.channelUserId.trim();
    if (!principalUserId) {
      throw new Error("WhatsApp channel user identity is required.");
    }
    const session = await client.createSession("whatsapp", {
      externalPrincipal: {
        channelAddressed: principal.channelAddressed,
        channelChatId: principal.channelChatId,
        channelIsGroup: isWhatsAppGroupChat(principal.channelChatId),
        channelUserAliases: principal.channelUserAliases,
        channelUserId: principalUserId,
      },
      profileId: resolvedProfileId,
    });

    sessionStore.set(sessionKey, {
      channelUserId: principalUserId,
      profileId: resolvedProfileId,
      profileOverride: selection.profileOverride || undefined,
      sessionId: session.id,
      updatedAt: new Date().toISOString(),
    });
    sessionStore.setHotSession(sessionKey, session);
    await sessionStore.save();

    return session;
  }

  async function sendText(
    jid: string,
    text: string,
    options?: {
      quoted?: WAMessage | null;
      raw?: boolean;
      binding?: WhatsAppNativeBinding;
    }
  ): Promise<void> {
    const prepared = options?.raw ? text.trim() : prepareWhatsAppReply(text);
    if (!prepared) {
      return;
    }

    const chunks = splitWhatsAppMessage(prepared);
    for (const [index, chunk] of chunks.entries()) {
      const sentKey = await sendChunkWithRetry({
        chunk,
        getSocket,
        jid,
        quoted: index === 0 ? options?.quoted : undefined,
        retryAttempts: sendRetryAttempts,
        retryBaseDelayMs: sendRetryBaseDelayMs,
        timeoutMs: sendTimeoutMs,
      });
      if (sentKey && options?.binding) {
        messageRegistry.remember(options.binding, sentKey);
      }
    }
  }

  const handler = (data: WhatsAppHandlerInput) =>
    client.isolateOrgId(async () => {
      const replayBoundary: InboundReplayBoundary = { replayUnsafe: false };
      try {
        await handleMessage(data, replayBoundary);
      } catch (error) {
        if (
          replayBoundary.replayUnsafe ||
          isWhatsAppDeliveryRetryableError(error) ||
          isWhatsAppInboundReplaySafeError(error)
        ) {
          throw error;
        }

        throw new WhatsAppInboundReplaySafeError(
          "WhatsApp inbound handling failed before the delivery boundary.",
          { cause: error }
        );
      }
    });
  return Object.assign(handler, {
    onReaction: (reaction: WhatsAppNativeReaction) =>
      client.isolateOrgId(async () => {
        await nativeControls.react(reaction, async (binding, event) => {
          const record = sessionStore.get(
            resolveWhatsAppSessionKey(
              chatKey(binding.destination),
              binding.channelUserId
            )
          );
          const selectedOrg =
            fixedWorkspaceId ??
            orgStore.get(
              resolveWhatsAppChannelOrgKey(
                chatKey(binding.destination),
                isWhatsAppGroupChat(binding.destination)
              )
            )?.orgId;
          if (
            record?.sessionId !== binding.sessionId ||
            record.profileId !== binding.profileId ||
            selectedOrg !== binding.orgId
          ) {
            throw new Error(
              "WhatsApp control belongs to a previous conversation selection."
            );
          }
          client.setOrgId(binding.orgId);
          await authStore.reload();
          if (
            ![event.actorId, ...event.actorAliases].some((jid) =>
              authStore.isAuthorized(jid)
            )
          ) {
            throw new Error("WhatsApp reaction sender is not admitted.");
          }
          return client.authorizeChannelPrincipal({
            channel: "whatsapp",
            channelAddressed: true,
            channelChatId: binding.destination,
            channelIsGroup: isWhatsAppGroupChat(binding.destination),
            channelUserAliases: event.actorAliases,
            channelUserId: event.actorId,
            intent: "invoke",
            profileId: binding.profileId,
            sessionId: binding.sessionId,
          });
        });
      }),
  });
}

interface SendChunkWithRetryInput {
  chunk: string;
  getSocket: () => WASocket | null;
  jid: string;
  quoted?: WAMessage | null;
  retryAttempts: number;
  retryBaseDelayMs: number;
  timeoutMs: number;
}

async function sendChunkWithRetry(
  input: SendChunkWithRetryInput
): Promise<WAMessageKey | undefined> {
  let lastError: unknown = new WhatsAppSocketUnavailableError();

  for (let attempt = 1; attempt <= input.retryAttempts; attempt += 1) {
    const socket = input.getSocket();

    try {
      if (!socket) {
        throw new WhatsAppSocketUnavailableError();
      }

      const sent = await withSendTimeout(
        socket.sendMessage(
          input.jid,
          { text: input.chunk },
          input.quoted ? { quoted: input.quoted } : undefined
        ),
        input.timeoutMs
      );
      return sent?.key;
    } catch (error) {
      lastError = error;
      const canRetry =
        attempt < input.retryAttempts &&
        !(error instanceof WhatsAppSendTimeoutError) &&
        isTransientWhatsAppSendError(error);
      if (!canRetry) {
        break;
      }

      console.warn("WhatsApp outbound chunk retry scheduled.", {
        attempt,
        errorType: getSafeWhatsAppErrorType(error),
        maxAttempts: input.retryAttempts,
      });
      await waitForRetryDelay(
        calculateSendRetryDelayMs(input.retryBaseDelayMs, attempt)
      );
    }
  }

  throw new WhatsAppDeliveryRetryableError(
    "WhatsApp disconnected before outbound text was delivered.",
    { cause: lastError }
  );
}

export function isTransientWhatsAppSendError(error: unknown): boolean {
  if (error instanceof WhatsAppSendTimeoutError) {
    // The original promise may still complete, so retrying would risk sending
    // the same chunk twice.
    return false;
  }
  if (!(error && typeof error === "object")) {
    return false;
  }

  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : null;
  if (code && TRANSIENT_SEND_ERROR_CODES.has(code.toUpperCase())) {
    return true;
  }

  const statusCode = readWhatsAppSendStatusCode(record);
  if (
    statusCode === 408 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode === 515 ||
    (statusCode !== null && statusCode >= 500 && statusCode < 600)
  ) {
    return true;
  }

  const message = typeof record.message === "string" ? record.message : "";
  if (TRANSIENT_SEND_MESSAGE.test(message)) {
    return true;
  }

  return record.cause ? isTransientWhatsAppSendError(record.cause) : false;
}

function readWhatsAppSendStatusCode(
  error: Record<string, unknown>
): number | null {
  if (typeof error.statusCode === "number") {
    return error.statusCode;
  }

  const output = error.output;
  if (!(output && typeof output === "object")) {
    return null;
  }
  const statusCode = (output as Record<string, unknown>).statusCode;
  return typeof statusCode === "number" ? statusCode : null;
}

function calculateSendRetryDelayMs(
  baseDelayMs: number,
  attempt: number
): number {
  return Math.min(MAX_SEND_RETRY_DELAY_MS, baseDelayMs * 2 ** (attempt - 1));
}

async function waitForRetryDelay(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function withSendTimeout<T>(
  delivery: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new WhatsAppSendTimeoutError()),
      timeoutMs
    );
  });

  try {
    return await Promise.race([delivery, timeoutResult]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
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

export function resolveWhatsAppSessionKey(
  conversationJid: string,
  channelUserId: string
): string {
  const conversationKey = chatKey(conversationJid);
  if (!isWhatsAppGroupChat(conversationKey)) {
    return conversationKey;
  }

  const senderKey = chatKey(channelUserId);
  return `group:${encodeURIComponent(conversationKey)}:sender:${encodeURIComponent(senderKey)}`;
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

function isMissingChannelPrincipalError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:canonical (?:user )?(?:mapping|principal)|re-pair the channel)/i.test(
      error.message
    )
  );
}

function formatSessionOpenError(jid: string, error: unknown): string {
  if (isWhatsAppGroupChat(jid)) {
    return GROUP_SESSION_ERROR_REPLY;
  }
  if (isMissingChannelPrincipalError(error)) {
    return IDENTITY_LINK_REQUIRED_REPLY;
  }
  return formatError(error);
}

export function resetChatLocksForTests(): void {
  chatLocks.clear();
  rateLimiter.reset();
}

export async function withChatLock(
  jid: string,
  fn: () => Promise<void>,
  timeoutMs = LOCK_TIMEOUT_MS
): Promise<void> {
  if (!(Number.isSafeInteger(timeoutMs) && timeoutMs > 0)) {
    throw new RangeError("WhatsApp chat lock timeout must be positive.");
  }

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
  void chain.then(() => {
    if (chatLocks.get(jid) === chain) {
      chatLocks.delete(jid);
    }
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new WhatsAppChatBusyError()),
      timeoutMs
    );
  });

  try {
    await Promise.race([previous.catch(() => undefined), timeoutPromise]);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    await fn();
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    release();
  }
}

export function seedChatLockForTests(
  jid: string,
  promise: Promise<void>
): void {
  chatLocks.set(jid, promise);
}
