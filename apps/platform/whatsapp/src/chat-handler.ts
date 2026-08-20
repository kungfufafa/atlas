import type { AtlasClient, RemoteChatSession } from "@atlas/client";
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
  normalizePairingCode,
  syncWhatsAppOwnerPairing,
} from "@atlas/core/whatsapp-config";
import type { WASocket } from "@whiskeysockets/baileys";
import {
  clearActiveStream,
  isAbortError,
  registerActiveStream,
  stopActiveStream,
} from "./active-stream";
import type { WhatsAppAuthStore } from "./auth-store";
import type { WhatsAppBridgeConfig } from "./config";
import {
  formatError,
  formatHelpText,
  prepareWhatsAppReply,
  splitWhatsAppMessage,
} from "./format";
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
  } = deps;
  const helpText = formatHelpText({
    workspaceLocked: Boolean(fixedWorkspaceId),
  });

  async function handleMessage(data: {
    fromMe?: boolean;
    jid: string;
    text: string;
  }): Promise<void> {
    const { jid, text, fromMe } = data;

    if (!(text && text.trim())) {
      return;
    }

    const trimmed = text.trim();

    if (isStopCommand(trimmed)) {
      if (!stopActiveStream(jid)) {
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

    if (!rateLimiter.isAllowed(jid)) {
      if (rateLimiter.shouldSendCooldownNotice(jid)) {
        await sendText(
          jid,
          "You are sending messages too quickly. Please wait a moment before trying again."
        );
      }
      return;
    }

    await withChatLock(jid, async () => {
      await authStore.reload();
      const fileConfig = authStore.getConfig();
      let authorized = authStore.isAuthorized(jid);

      if (!authorized && fromMe && fileConfig?.pairedJid) {
        await syncWhatsAppOwnerPairing({
          forceLidUpdate: true,
          orgId: fixedWorkspaceId,
          ownerJid: fileConfig.pairedJid,
          ownerLid: jid,
        });
        await authStore.reload();
        authorized = authStore.isAuthorized(jid);
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

        await handlePairing(jid, trimmed);
        return;
      }

      const command = trimmed.startsWith("/") ? parseCommand(trimmed) : null;
      const bypassOrgGate =
        command === "/help" || command === "/start" || command === "/org";

      if (!bypassOrgGate) {
        const orgReady = await ensureOrgReady(jid, trimmed);
        if (!orgReady) {
          return;
        }
      }

      if (trimmed.startsWith("/")) {
        await handleCommand(jid, trimmed);
        return;
      }

      await handleChatMessage(jid, { message: trimmed });
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

    const result = await authStore.tryPair(text, jid);
    await sendText(jid, result.message);
  }

  async function handleCommand(jid: string, text: string): Promise<void> {
    const command = parseCommand(text);

    switch (command) {
      case "/start":
      case "/help":
        await sendText(jid, helpText);
        return;

      case "/clear": {
        const session = await resolveSession(jid);
        await session.clear();
        await sendText(jid, "History cleared.");
        return;
      }

      case "/compact": {
        const session = await resolveSession(jid);
        const result = await session.compact({ force: true });
        await sendText(
          jid,
          `Compacted (${result.action}). Messages: ${result.messagesAfter}.`
        );
        return;
      }

      case "/new": {
        await createAndBindSession(jid);
        await sendText(jid, "Started a new conversation.");
        return;
      }

      case "/status":
        await replyStatus(jid);
        return;

      case "/org":
        await handleOrgCommand(jid, text);
        return;

      default:
        await sendText(jid, "Unknown command. Try /help");
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

  async function handleOrgCommand(jid: string, text: string): Promise<void> {
    if (fixedWorkspaceId) {
      await sendText(
        jid,
        "This WhatsApp integration belongs to one workspace and cannot switch workspaces."
      );
      return;
    }

    const { orgs } = await client.listUserOrgs();

    if (orgs.length === 0) {
      await sendText(jid, "No organizations are configured yet.");
      return;
    }

    const arg = text.trim().split(/\s+/).slice(1).join(" ");
    if (!arg) {
      await sendText(
        jid,
        formatOrgSelectionPrompt(orgs, orgStore.get(jid)?.orgId)
      );
      return;
    }

    const picked = findOrgBySelectionInput(arg, orgs);
    if (!picked) {
      await sendText(jid, "Unknown organization. Send /org to see the list.");
      return;
    }

    const previousOrgId = orgStore.get(jid)?.orgId;
    orgStore.set(jid, picked.id);
    await orgStore.save();
    client.setOrgId(picked.id);

    if (previousOrgId && previousOrgId !== picked.id) {
      sessionStore.delete(jid);
      await sessionStore.save();
    }

    await sendText(jid, formatOrgSwitchConfirmation(picked.name));
  }

  async function handleChatMessage(
    jid: string,
    input: SendMessageInput
  ): Promise<void> {
    const session = await resolveSession(jid);
    const typingLoop = createTypingLoop(getSocket(), jid);
    const todoStatus = new WhatsAppTodoStatusMessage(getSocket(), jid);
    const signal = registerActiveStream(jid);
    let reply = "";

    typingLoop.start();

    try {
      reply = await session.sendStream(
        input,
        {
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
          await sendText(jid, reply.trim());
        }

        await sendText(jid, "Stopped.");
        return;
      }
    } catch (error) {
      if (isAbortError(error)) {
        await todoStatus.stop();
        if (reply.trim()) {
          await sendText(jid, reply.trim());
        }

        await sendText(jid, "Stopped.");
        return;
      }

      await todoStatus.fail();
      await sendText(jid, formatError(error));
      return;
    } finally {
      clearActiveStream(jid);
      typingLoop.stop();
    }

    if (reply.trim()) {
      await sendText(jid, reply.trim());
      return;
    }

    await sendText(jid, "(empty reply)");
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

  async function sendText(jid: string, text: string): Promise<void> {
    const socket = getSocket();
    if (!socket) {
      return;
    }

    const prepared = prepareWhatsAppReply(text);
    if (!prepared) {
      return;
    }

    for (const chunk of splitWhatsAppMessage(prepared)) {
      await socket.sendMessage(jid, { text: chunk });
    }
  }

  return (data: { fromMe?: boolean; jid: string; text: string }) =>
    client.isolateOrgId(() => handleMessage(data));
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
