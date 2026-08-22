import { getWhatsAppConfigDir } from "@atlas/core/whatsapp-config";
import {
  DisconnectReason,
  extractMessageContent,
  fetchLatestBaileysVersion,
  getContentType,
  makeWASocket,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import {
  extractInboundPhoneHint,
  extractInboundText,
  inspectInboundWhatsAppMedia,
  isPrivateWhatsAppChat,
  shouldHandleInboundMessage,
} from "./inbound-message";

export interface WhatsAppSocketDeps {
  onConnected?: (me: { id: string; lid?: string | null }) => void;
  onDisconnected?: () => void;
  onMessage: (data: {
    fromMe?: boolean;
    inbound?: WAMessage | null;
    jid: string;
    senderPn?: string | null;
    text: string;
  }) => Promise<void>;
  onPhoneNumberShare?: (lid: string, phoneJid: string) => void;
  onQr?: (qr: string) => void;
}

export interface WhatsAppSocketHandle {
  socket: WASocket | null;
  start: () => Promise<void>;
  stop: () => void;
}

export async function createWhatsAppSocket(
  deps: WhatsAppSocketDeps
): Promise<WhatsAppSocketHandle> {
  const authDir = getWhatsAppConfigDir() + "/auth";
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  let socket: WASocket | null = null;
  let stopped = false;
  let loggedMissingTextPayload = false;
  const baileysLogger = createBaileysLogger();
  const inboundDedupe = createInboundMessageDedupe();

  const handle = {
    get socket() {
      return socket;
    },
    async start() {
      if (stopped) {
        return;
      }

      await disposeWhatsAppSocket(socket);
      socket = makeWASocket({
        auth: state,
        browser: ["Atlas", "Chrome", "4.0.0"] as [string, string, string],
        connectTimeoutMs: 30_000,
        logger: baileysLogger,
        markOnlineOnConnect: false,
        printQRInTerminal: false,
        retryRequestDelayMs: 2000,
        // Keep history sync disabled, but allow Baileys init queries so the
        // socket fully subscribes after reconnect/restart.
        shouldSyncHistoryMessage: () => false,
        version,
      });

      const current = socket;

      socket.ev.on("connection.update", async (update) => {
        if (socket !== current) {
          return;
        }

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          deps.onQr?.(qr);
        }

        if (connection === "open") {
          const me = state.creds.me;
          if (me?.id) {
            deps.onConnected?.({ id: me.id, lid: me.lid ?? null });
          }
        }

        if (connection === "close") {
          deps.onDisconnected?.();
          const statusCode = extractDisconnectStatusCode(lastDisconnect);
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          const shouldReconnect = !(loggedOut || stopped);

          if (loggedOut) {
            await disposeWhatsAppSocket(socket);
            if (socket === current) {
              socket = null;
            }
          }

          const isRestartRequired =
            statusCode === DisconnectReason.restartRequired ||
            statusCode === 515;
          const statusText = isRestartRequired
            ? "515 - restart required"
            : String(statusCode ?? "unknown");

          console.log(
            `WhatsApp disconnected (code: ${statusText}).${shouldReconnect ? " Reconnecting..." : ""}`
          );

          if (shouldReconnect) {
            await handle.start();
          }
        }
      });

      socket.ev.on("creds.update", saveCreds);

      socket.ev.on("chats.phoneNumberShare", (share) => {
        if (share.lid && share.jid) {
          deps.onPhoneNumberShare?.(share.lid, share.jid);
        }
      });

      socket.ev.on("messages.upsert", async (m) => {
        if (socket !== current) {
          return;
        }

        const isVerbose = isVerboseLoggingEnabled(
          process.env.WHATSAPP_VERBOSE_LOGS
        );

        if (isVerbose) {
          console.log(
            `WhatsApp messages.upsert type=${m.type} count=${m.messages.length}`
          );
        }

        if (!isSupportedUpsertType(m.type)) {
          return;
        }

        const me = state.creds.me;

        for (const msg of m.messages) {
          const remoteJid = msg.key.remoteJid ?? null;
          const messageId = msg.key.id?.trim();
          const text = extractInboundText(msg.message);
          const senderPn = extractInboundPhoneHint(msg);
          const mediaKind = inspectInboundWhatsAppMedia(msg.message)?.kind;
          const shouldHandle = shouldHandleInboundMessage(msg, me);

          if (isVerbose && remoteJid) {
            console.log(
              `WhatsApp upsert item jid=${remoteJid} fromMe=${msg.key.fromMe ? "yes" : "no"} participant=${msg.key.participant ?? "-"} senderPn=${senderPn ?? "-"} text=${text ? "yes" : "no"} media=${mediaKind ?? "-"} handle=${shouldHandle ? "yes" : "no"}`
            );
          }

          const isProtocolOrSync = Boolean(
            msg.message?.protocolMessage ||
              msg.message?.senderKeyDistributionMessage ||
              msg.message?.messageContextInfo
          );

          if (
            isVerbose &&
            remoteJid &&
            !text &&
            !isProtocolOrSync &&
            !loggedMissingTextPayload &&
            isPrivateWhatsAppChat(remoteJid)
          ) {
            loggedMissingTextPayload = true;
            console.log(
              "WhatsApp missing-text payload:",
              summarizeMissingTextPayload(
                msg as Parameters<typeof summarizeMissingTextPayload>[0]
              )
            );
          }

          if (
            !claimInboundDelivery(inboundDedupe, {
              messageId,
              remoteJid,
              shouldHandle,
            })
          ) {
            continue;
          }
          if (!remoteJid) {
            continue;
          }

          const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
          console.log(
            `WhatsApp message received from ${remoteJid}: ${preview}`
          );

          try {
            await deps.onMessage({
              fromMe: Boolean(msg.key.fromMe),
              inbound: msg,
              jid: remoteJid,
              senderPn,
              text,
            });
          } catch (error) {
            console.error("WhatsApp inbound message handling failed.", {
              error: error instanceof Error ? error.message : String(error),
              jid: remoteJid,
            });
          }
        }
      });
    },
    stop() {
      stopped = true;
      const current = socket;
      socket = null;
      void disposeWhatsAppSocket(current);
    },
  };

  return handle;
}

function isVerboseLoggingEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isSupportedUpsertType(type: string): boolean {
  return type === "notify" || type === "append";
}

export function extractDisconnectStatusCode(
  lastDisconnect: unknown
): number | undefined {
  if (!lastDisconnect || typeof lastDisconnect !== "object") {
    return;
  }

  const record = lastDisconnect as {
    error?: { output?: { statusCode?: unknown }; message?: unknown };
    statusCode?: unknown;
  };
  const fromError = record.error?.output?.statusCode;
  if (typeof fromError === "number") {
    return fromError;
  }

  if (typeof record.statusCode === "number") {
    return record.statusCode;
  }
}

const INBOUND_DEDUPE_TTL_MS = 5 * 60 * 1000;

export function createInboundMessageDedupe(ttlMs = INBOUND_DEDUPE_TTL_MS) {
  const seen = new Map<string, number>();

  return {
    remember(id: string): boolean {
      const now = Date.now();
      for (const [key, seenAt] of seen) {
        if (now - seenAt > ttlMs) {
          seen.delete(key);
        }
      }

      if (seen.has(id)) {
        return false;
      }

      seen.set(id, now);
      return true;
    },
  };
}

export function claimInboundDelivery(
  dedupe: { remember: (id: string) => boolean },
  input: {
    messageId?: string | null;
    remoteJid: string | null;
    shouldHandle: boolean;
  }
): boolean {
  if (!(input.shouldHandle && input.remoteJid)) {
    return false;
  }

  const messageId = input.messageId?.trim();
  if (!messageId) {
    return true;
  }

  return dedupe.remember(`${input.remoteJid}:${messageId}`);
}

async function disposeWhatsAppSocket(target: WASocket | null): Promise<void> {
  if (!target) {
    return;
  }

  try {
    target.ev.removeAllListeners();
  } catch {
    // Best-effort: Baileys versions differ on listener APIs.
  }

  try {
    target.end(undefined);
  } catch {
    // Socket may already be closed.
  }
}

function summarizeMissingTextPayload(msg: {
  key: {
    remoteJid?: string | null;
    fromMe?: boolean | null;
    participant?: string | null;
    id?: string | null;
  };
  message?: Record<string, unknown> | null;
  messageStubType?: unknown;
}): string {
  const extracted = extractMessageContent(msg.message as any);
  const summary = {
    extractedKeys: extracted ? Object.keys(extracted).slice(0, 10) : [],
    extractedType: getContentType(extracted as any) ?? null,
    key: {
      fromMe: msg.key.fromMe ?? null,
      id: msg.key.id ?? null,
      participant: msg.key.participant ?? null,
      remoteJid: msg.key.remoteJid ?? null,
    },
    message: msg.message ?? null,
    messageStubType: msg.messageStubType ?? null,
    topLevelKeys: msg.message ? Object.keys(msg.message).slice(0, 10) : [],
    topLevelType: getContentType(msg.message as any) ?? null,
  };

  return JSON.stringify(summary);
}

// ponytail: keep Baileys on silent; worker logs what matters itself
function createBaileysLogger() {
  const noop = () => {};
  const logger = {
    child: () => logger,
    debug: noop,
    error: console.error.bind(console),
    fatal: console.error.bind(console),
    info: noop,
    level: "silent",
    trace: noop,
    warn: console.warn.bind(console),
  };

  return logger;
}
