import type { AtlasClient, RemoteChatSession } from "@atlas/client";
import {
  type ChannelArtifactRef,
  channelArtifactRefFromArtifact,
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
  clearWhatsAppPairingAssertion,
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
  PAIRING_MEDIA_REPLY,
  UNSUPPORTED_MEDIA_REPLY,
  type WhatsAppMediaDownload,
} from "./attachments";
import { buildWhatsAppAudioInput } from "./audio";
import type { WhatsAppAuthStore } from "./auth-store";
import {
  deliverWhatsAppTurnArtifactShares,
  maybeSendRequestedWhatsAppArtifactAttachment,
} from "./channel-artifact-flow";
import type { WhatsAppBridgeConfig } from "./config";
import {
  formatError,
  formatHelpText,
  prepareWhatsAppReply,
  splitWhatsAppMessage,
} from "./format";
import { inspectInboundWhatsAppMedia } from "./inbound-message";
import type { SessionStore } from "./session-store";
import { WhatsAppTodoStatusMessage } from "./todo-status-message";
import { createTypingLoop } from "./typing-indicator";

const chatLocks = new Map<string, Promise<void>>();
const rateLimiter = new ChannelRateLimiter();
const MAX_MESSAGE_LENGTH = 2000;
const LOCK_TIMEOUT_MS = 120_000;

const PAIRING_PROMPT =
  "Atlas has not authorized this chat yet.\n\n" +
  "Send the chat access code shown in Integrations \u2192 WhatsApp. " +
  "You only need to authorize this chat once.";

const NO_CODE_PROMPT =
  "Atlas has not authorized this chat yet.\n\n" +
  "Open Integrations \u2192 WhatsApp in Atlas and generate a chat access code. " +
  "Send the code here to authorize this chat.";

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

  async function handleMessage(data: {
    fromMe?: boolean;
    inbound?: WAMessage | null;
    jid: string;
    senderPn?: string | null;
    text: string;
  }): Promise<void> {
    const { jid, text, fromMe, senderPn, inbound } = data;
    const trimmed = text.trim();
    const media = inspectInboundWhatsAppMedia(inbound?.message);

    if (!(trimmed || media)) {
      return;
    }

    if (trimmed && isStopCommand(trimmed)) {
      if (!stopActiveStream(chatKey(jid))) {
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

    if (!rateLimiter.isAllowed(chatKey(jid))) {
      if (rateLimiter.shouldSendCooldownNotice(chatKey(jid))) {
        await sendText(
          jid,
          "You are sending messages too quickly. Please wait a moment before trying again."
        );
      }
      return;
    }

    await withChatLock(chatKey(jid), async () => {
      await authStore.reload();
      const fileConfig = authStore.getConfig();
      await authStore.rememberSenderPn(jid, senderPn);
      let authorized = authStore.isAuthorized(jid, { senderPn });

      if (!authorized && fromMe && fileConfig?.pairedJid) {
        await syncWhatsAppOwnerPairing({
          forceLidUpdate: true,
          orgId: fixedWorkspaceId,
          ownerJid: fileConfig.pairedJid,
          ownerLid: jid,
        });
        await authStore.reload();
        authorized = authStore.isAuthorized(jid, { senderPn });
      }

      if (authorized) {
        await bindPendingChannelPrincipal(chatKey(jid));
      }

      if (!authorized) {
        if (
          fileConfig?.accessMode === "allowlist" ||
          fileConfig?.accessMode === "denylist"
        ) {
          const command = parseCommand(trimmed);
          if (command === "/start" || command === "/help") {
            await sendText(
              jid,
              "This assistant is restricted and not authorized for this chat."
            );
          }
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

      const command = trimmed.startsWith("/") ? parseCommand(trimmed) : null;
      const bypassOrgGate =
        command === "/help" || command === "/start" || command === "/org";

      if (!bypassOrgGate) {
        const orgReady = await ensureOrgReady(chatKey(jid), trimmed);
        if (!orgReady) {
          return;
        }
      }

      if (trimmed.startsWith("/")) {
        await handleCommand(chatKey(jid), jid, trimmed);
        return;
      }

      const mediaInput = await tryBuildMediaInput(jid, inbound);
      if (mediaInput === "reject") {
        return;
      }

      if (mediaInput) {
        await handleChatMessage(
          jid,
          {
            ...mediaInput,
            message: trimmed || mediaInput.message,
          },
          inbound
        );
        return;
      }

      if (media?.kind === "audio") {
        const audioInput = await tryBuildAudioInput(jid, inbound);
        if (audioInput === "reject") {
          return;
        }

        if (audioInput) {
          await handleChatMessage(
            jid,
            {
              ...audioInput,
              message: trimmed
                ? `${audioInput.message}\n\n${trimmed}`
                : audioInput.message,
            },
            inbound
          );
          return;
        }
      }

      if (media?.kind === "unsupported" && !trimmed) {
        await sendText(jid, UNSUPPORTED_MEDIA_REPLY);
        return;
      }

      if (!trimmed) {
        return;
      }

      await handleChatMessage(jid, { message: trimmed }, inbound);
    });
  }

  async function handlePairing(jid: string, text: string): Promise<void> {
    const command = parseCommand(text);
    const fileConfig = authStore.getConfig();
    const hasPairingCode = Boolean(fileConfig?.pairingCode);

    if (command === "/help") {
      await sendText(jid, `${PAIRING_PROMPT}\n\n${helpText}`);
      return;
    }

    if (command === "/start") {
      await sendText(jid, hasPairingCode ? PAIRING_PROMPT : NO_CODE_PROMPT);
      return;
    }

    if (!hasPairingCode) {
      await sendText(jid, NO_CODE_PROMPT);
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
      console.error("Failed to bind WhatsApp channel principal:", error);
    }
  }

  async function handleCommand(
    conversationKey: string,
    sendJid: string,
    text: string
  ): Promise<void> {
    const command = parseCommand(text);

    switch (command) {
      case "/start":
      case "/help":
        await sendText(sendJid, helpText);
        return;

      case "/clear": {
        const session = await resolveSession(conversationKey);
        await session.clear();
        await sendText(sendJid, "History cleared.");
        return;
      }

      case "/compact": {
        const session = await resolveSession(conversationKey);
        const result = await session.compact({ force: true });
        await sendText(
          sendJid,
          `Compacted (${result.action}). Messages: ${result.messagesAfter}.`
        );
        return;
      }

      case "/new": {
        await createAndBindSession(conversationKey);
        await sendText(sendJid, "Started a new conversation.");
        return;
      }

      case "/status":
        await replyStatus(sendJid);
        return;

      case "/org":
        await handleOrgCommand(conversationKey, sendJid, text);
        return;

      default:
        await sendText(sendJid, "Unknown command. Try /help");
    }
  }

  async function ensureOrgReady(
    jid: string,
    messageText: string
  ): Promise<boolean> {
    if (fixedWorkspaceId) {
      client.setOrgId(fixedWorkspaceId);
      if (orgStore.get(jid)?.orgId !== fixedWorkspaceId) {
        orgStore.set(jid, fixedWorkspaceId);
        await orgStore.save();
      }
      return true;
    }

    const orgContext = await prepareChannelOrgContext({
      getSelectedOrgId: () => orgStore.get(jid)?.orgId,
      listOrgs: () => client.listUserOrgs(),
      saveSelectedOrgId: async (orgId) => {
        orgStore.set(jid, orgId);
        await orgStore.save();
      },
      text: messageText.startsWith("/") ? undefined : messageText,
    });

    if (orgContext.status === "empty") {
      await sendText(jid, "No organizations are configured yet.");
      return false;
    }

    if (orgContext.status === "prompt") {
      await sendText(jid, orgContext.message);
      return false;
    }

    client.setOrgId(orgContext.orgId);

    if (orgContext.justSelected) {
      await sendText(jid, formatOrgSwitchConfirmation(orgContext.orgName));
      return false;
    }

    return true;
  }

  async function handleOrgCommand(
    conversationKey: string,
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
        formatOrgSelectionPrompt(orgs, orgStore.get(conversationKey)?.orgId)
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

    const previousOrgId = orgStore.get(conversationKey)?.orgId;
    orgStore.set(conversationKey, picked.id);
    await orgStore.save();
    client.setOrgId(picked.id);

    if (previousOrgId && previousOrgId !== picked.id) {
      sessionStore.delete(conversationKey);
      await sessionStore.save();
    }

    await sendText(sendJid, formatOrgSwitchConfirmation(picked.name));
  }

  async function tryBuildMediaInput(
    jid: string,
    inbound: WAMessage | null | undefined
  ): Promise<SendMessageInput | "reject" | null> {
    if (!inbound?.message) {
      return null;
    }

    const media = inspectInboundWhatsAppMedia(inbound.message);
    if (!media || media.kind === "unsupported" || media.kind === "audio") {
      return null;
    }

    const result = await buildWhatsAppMediaInput(inbound, (message) =>
      downloadMedia
        ? downloadMedia(message)
        : downloadWhatsAppMedia(message, getSocket())
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
    inbound: WAMessage | null | undefined
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
      (input) => client.transcribeAudio(input)
    );

    if (result.kind === "reject") {
      await sendText(jid, result.message);
      return "reject";
    }

    return result.input;
  }

  async function handleChatMessage(
    jid: string,
    input: SendMessageInput,
    inbound?: WAMessage | null
  ): Promise<void> {
    const conversationKey = chatKey(jid);
    const session = await resolveSession(conversationKey);
    const profileId = sessionStore.get(conversationKey)?.profileId;

    if (profileId) {
      await maybeSendRequestedWhatsAppArtifactAttachment({
        attachUserText: input.message,
        client,
        conversationKey,
        getSocket,
        jid,
        profileId,
        sendText,
        sessionStore,
      });
    }

    const typingLoop = createTypingLoop(getSocket(), jid);
    const todoStatus = new WhatsAppTodoStatusMessage(getSocket(), jid);
    const signal = registerActiveStream(conversationKey);
    let reply = "";
    const streamedArtifacts = new Map<string, ChannelArtifactRef>();

    typingLoop.start();

    try {
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
      clearActiveStream(conversationKey);
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
        conversationKey,
        getSocket,
        jid,
        profileId,
        sendText: (target, text) => sendText(target, text, { raw: true }),
        session,
        sessionStore,
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

  async function resolveSession(jid: string): Promise<RemoteChatSession> {
    const profileId = await resolveProfileId();
    const existing = sessionStore.get(jid);

    if (existing && existing.profileId === profileId) {
      const session = client.createChatSession(existing.sessionId, "whatsapp");

      try {
        await session.getMessages();
        return session;
      } catch {
        // Session missing on server; create a new one below
      }
    }

    return createAndBindSession(jid, profileId);
  }

  async function createAndBindSession(
    jid: string,
    profileId?: string
  ): Promise<RemoteChatSession> {
    const resolvedProfileId = profileId ?? (await resolveProfileId());
    const session = await client.createSession("whatsapp", {
      externalPrincipal: { channelUserId: jid },
      profileId: resolvedProfileId,
    });

    sessionStore.set(jid, {
      profileId: resolvedProfileId,
      sessionId: session.id,
      updatedAt: new Date().toISOString(),
    });
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

  return (data: {
    fromMe?: boolean;
    inbound?: WAMessage | null;
    jid: string;
    senderPn?: string | null;
    text: string;
  }) => client.isolateOrgId(() => handleMessage(data));
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

async function withChatLock(
  jid: string,
  fn: () => Promise<void>
): Promise<void> {
  const previous = chatLocks.get(jid) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
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
