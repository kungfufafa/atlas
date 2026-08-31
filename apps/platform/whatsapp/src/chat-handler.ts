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
import { pickProfileForOrg } from "@atlas/core/profiles";
import {
  isWhatsAppPairingCodeActive,
  normalizePairingCode,
  normalizeWhatsAppUserJid,
  syncWhatsAppOwnerPairing,
} from "@atlas/core/whatsapp-config";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
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
  channelUserAliases: string[];
  channelUserId: string;
}

interface InboundReplayBoundary {
  replayUnsafe: boolean;
}

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

      const mayPersistInboundDocument =
        fromMe ||
        senderJids.some((senderJid) =>
          authStore.isPairedIdentity(senderJid, { senderPn })
        );
      if (mayPersistInboundDocument && media) {
        replayBoundary.replayUnsafe = true;
      }
      const mediaInput = await tryBuildMediaInput(
        jid,
        channelOrgKey,
        inbound,
        mayPersistInboundDocument
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
          messageText
        );
        return;
      }

      if (media?.kind === "audio") {
        try {
          await resolveSession(sessionKey, sessionPrincipal);
        } catch (error) {
          await sendText(
            jid,
            isGroup ? GROUP_SESSION_ERROR_REPLY : formatError(error)
          );
          return;
        }
        const sessionId = sessionStore.get(sessionKey)?.sessionId;
        if (!sessionId) {
          await sendText(
            jid,
            isGroup
              ? GROUP_SESSION_ERROR_REPLY
              : "Could not start a WhatsApp session. Try again."
          );
          return;
        }

        replayBoundary.replayUnsafe = true;
        const audioInput = await tryBuildAudioInput(jid, inbound, sessionId);
        if (audioInput === "reject") {
          return;
        }

        if (audioInput) {
          await handleChatMessage(
            sessionKey,
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
            sessionPrincipal,
            messageText
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
        messageText
      );
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
        await replyStatus(sendJid);
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
    try {
      await resolveSession(sessionKey, principal);
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

  async function tryBuildMediaInput(
    jid: string,
    channelOrgKey: string,
    inbound: WAMessage | null | undefined,
    mayPersistInboundDocument: boolean
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
      (message) =>
        downloadMedia
          ? downloadMedia(message)
          : downloadWhatsAppMedia(message, getSocket()),
      mayPersistInboundDocument
        ? {
            saveInboundDocument: async (file) => {
              const orgId =
                fixedWorkspaceId ?? orgStore.get(channelOrgKey)?.orgId;
              if (!orgId) {
                throw new Error("WhatsApp workspace is not selected.");
              }

              const profileId = await resolveProfileId();
              return saveInboundWorkspaceDocument({
                bytes: file.bytes,
                filename: file.filename,
                orgId,
                profileId,
              });
            },
          }
        : {}
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
    sessionId: string
  ): Promise<SendMessageInput | "reject" | null> {
    if (!inbound?.message) {
      return null;
    }

    const result = await buildWhatsAppAudioInput(
      inbound,
      (message) =>
        downloadMedia
          ? downloadMedia(message)
          : downloadWhatsAppMedia(message, getSocket()),
      (input) => client.transcribeAudio({ ...input, sessionId })
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
    artifactIntentText: string
  ): Promise<void> {
    let session: RemoteChatSession;
    try {
      session = await resolveSession(sessionKey, principal);
    } catch (error) {
      await sendText(jid, formatSessionOpenError(jid, error));
      return;
    }
    const profileId = sessionStore.get(sessionKey)?.profileId;

    const typingLoop = createTypingLoop(getSocket(), jid);
    const todoStatus = new WhatsAppTodoStatusMessage(getSocket(), jid);
    const signal = registerActiveStream(sessionKey);
    let reply = "";
    const streamedArtifacts = new Map<string, ChannelArtifactRef>();

    try {
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
          },
          onThinking: () => {
            typingLoop.ping();
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
          },
        },
        { signal }
      );

      await todoStatus.complete();

      if (signal.aborted) {
        if (reply.trim()) {
          await sendText(jid, reply.trim(), { quoted: inbound });
        }

        await sendText(jid, "Stopped.");
        return;
      }
    } catch (error) {
      if (isAbortError(error)) {
        await todoStatus.stop();
        if (reply.trim()) {
          await sendText(jid, reply.trim(), { quoted: inbound });
        }

        await sendText(jid, "Stopped.");
        return;
      }

      await todoStatus.fail();
      await sendText(jid, formatError(error));
      return;
    } finally {
      clearActiveStream(sessionKey);
      typingLoop.stop();
    }

    if (reply.trim()) {
      await sendText(jid, reply.trim(), { quoted: inbound });
    } else {
      await sendText(jid, "(empty reply)");
    }

    if (profileId) {
      await deliverWhatsAppTurnArtifactShares({
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

  async function replyStatus(jid: string): Promise<void> {
    try {
      const health = await client.health();
      const lines = [
        `Server: ${health.ok ? "ok" : "degraded"}`,
        `Provider configured: ${health.providerConfigured ? "yes" : "no"}`,
      ];

      if (health.providerConfigured) {
        const models = await client.getModels();
        const profileId = await resolveProfileId();
        const profiles = await client.listProfiles();
        const profile = profiles.profiles.find(
          (entry) => entry.id === profileId
        );
        const modelLabel = profile?.model?.includes("::")
          ? profile.model.slice(profile.model.indexOf("::") + 2)
          : (profile?.model ?? "none");
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

  async function resolveProfileId(): Promise<string> {
    const fileConfig = authStore.getConfig();
    const preferredProfileId =
      fileConfig?.profileId?.trim() || config.profileId;
    const profiles = await client.listProfiles();
    return pickProfileForOrg(profiles.profiles, preferredProfileId).id;
  }

  async function resolveSession(
    sessionKey: string,
    principal: WhatsAppSessionPrincipal
  ): Promise<RemoteChatSession> {
    const profileId = await resolveProfileId();
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

    return createAndBindSession(sessionKey, profileId, principal);
  }

  async function createAndBindSession(
    sessionKey: string,
    profileId: string | undefined,
    principal: WhatsAppSessionPrincipal
  ): Promise<RemoteChatSession> {
    const resolvedProfileId = profileId ?? (await resolveProfileId());
    const principalUserId = principal.channelUserId.trim();
    const session = await client.createSession("whatsapp", {
      externalPrincipal: {
        channelUserAliases: principal.channelUserAliases,
        channelUserId: principalUserId,
      },
      profileId: resolvedProfileId,
    });

    sessionStore.set(sessionKey, {
      channelUserId: principalUserId,
      profileId: resolvedProfileId,
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
    options?: { quoted?: WAMessage | null; raw?: boolean }
  ): Promise<void> {
    const prepared = options?.raw ? text.trim() : prepareWhatsAppReply(text);
    if (!prepared) {
      return;
    }

    const chunks = splitWhatsAppMessage(prepared);
    for (const [index, chunk] of chunks.entries()) {
      await sendChunkWithRetry({
        chunk,
        getSocket,
        jid,
        quoted: index === 0 ? options?.quoted : undefined,
        retryAttempts: sendRetryAttempts,
        retryBaseDelayMs: sendRetryBaseDelayMs,
        timeoutMs: sendTimeoutMs,
      });
    }
  }

  return (data: WhatsAppHandlerInput) =>
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
): Promise<void> {
  let lastError: unknown = new WhatsAppSocketUnavailableError();

  for (let attempt = 1; attempt <= input.retryAttempts; attempt += 1) {
    const socket = input.getSocket();

    try {
      if (!socket) {
        throw new WhatsAppSocketUnavailableError();
      }

      await withSendTimeout(
        socket.sendMessage(
          input.jid,
          { text: input.chunk },
          input.quoted ? { quoted: input.quoted } : undefined
        ),
        input.timeoutMs
      );
      return;
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
    await Promise.race([previous, timeoutPromise]);
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
