import {
  getWhatsAppConfigDir,
  normalizePhoneNumberDigits,
} from "@atlas/core/whatsapp-config";
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { usePrivateMultiFileAuthState } from "./auth-state";
import {
  createBaileysLogger,
  getSafeWhatsAppErrorType,
} from "./baileys-logger";
import {
  extractInboundText,
  inspectInboundWhatsAppMedia,
  isPrivateWhatsAppChat,
  parseInboundWhatsAppMessage,
  type WhatsAppInboundChat,
} from "./inbound-message";

export interface WhatsAppSocketDeps {
  onConnected?: (me: { id: string; lid?: string | null }) => void;
  onDevicePairingCode?: (code: string) => void;
  onDisconnected?: () => void;
  onMessage: (
    data: WhatsAppInboundChat & {
      inbound?: WAMessage | null;
    }
  ) => Promise<void>;
  onPhoneNumberShare?: (lid: string, phoneJid: string) => void;
  onQr?: (qr: string) => void;
  phoneNumber?: string;
}

export interface WhatsAppSocketHandle {
  socket: WASocket | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function createWhatsAppSocket(
  deps: WhatsAppSocketDeps
): Promise<WhatsAppSocketHandle> {
  const authDir = getWhatsAppConfigDir() + "/auth";
  const { state, saveCreds } = await usePrivateMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  let socket: WASocket | null = null;
  let stopped = false;
  let generation = 0;
  let reconnectAttempt = 0;
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

      const myGen = ++generation;
      await disposeWhatsAppSocket(socket);
      if (myGen !== generation || stopped) {
        return;
      }

      const next = makeWASocket({
        auth: state,
        browser: ["Atlas", "Chrome", "4.0.0"] as [string, string, string],
        connectTimeoutMs: 30_000,
        emitOwnEvents: false,
        logger: baileysLogger,
        markOnlineOnConnect: false,
        printQRInTerminal: false,
        retryRequestDelayMs: 2000,
        // Keep history sync disabled, but allow Baileys init queries so the
        // socket fully subscribes after reconnect/restart.
        shouldSyncHistoryMessage: () => false,
        version,
      });

      if (myGen !== generation || stopped) {
        await disposeWhatsAppSocket(next);
        return;
      }

      socket = next;
      const current = next;
      let pairingRequested = false;

      next.ev.on("connection.update", async (update) => {
        if (myGen !== generation || socket !== current) {
          return;
        }

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          deps.onQr?.(qr);
          const phoneDigits = normalizePhoneNumberDigits(
            deps.phoneNumber ?? ""
          );
          if (
            shouldRequestDevicePairingCode({
              alreadyRequested: pairingRequested,
              phoneDigits,
              registered: Boolean(state.creds.registered),
            })
          ) {
            pairingRequested = true;
            try {
              const code = await current.requestPairingCode(phoneDigits);
              if (socket !== current || stopped) {
                return;
              }

              const trimmed = code?.trim();
              if (trimmed) {
                deps.onDevicePairingCode?.(trimmed);
              }
            } catch (error) {
              pairingRequested = false;
              console.error("WhatsApp pairing code request failed.", {
                errorType: getSafeWhatsAppErrorType(error),
              });
            }
          }
        }

        if (connection === "open") {
          reconnectAttempt = 0;
          const me = state.creds.me;
          if (me?.id) {
            deps.onConnected?.({ id: me.id, lid: me.lid ?? null });
          }
        }

        if (connection === "close") {
          generation += 1;
          detachWhatsAppSocketListeners(current);
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

          if (!shouldReconnect) {
            return;
          }

          const waitMs = whatsAppReconnectDelayMs(reconnectAttempt);
          reconnectAttempt += 1;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, waitMs);
          });
          if (stopped) {
            return;
          }

          await handle.start();
        }
      });

      next.ev.on("creds.update", saveCreds);

      next.ev.on("chats.phoneNumberShare", (share) => {
        if (share.lid && share.jid) {
          deps.onPhoneNumberShare?.(share.lid, share.jid);
        }
      });

      next.ev.on("messages.upsert", async (m) => {
        if (myGen !== generation || socket !== current) {
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
          const mediaKind = inspectInboundWhatsAppMedia(msg.message)?.kind;
          const inbound = parseInboundWhatsAppMessage(msg, me);

          if (isVerbose) {
            const chatKind = remoteJid
              ? isPrivateWhatsAppChat(remoteJid)
                ? "private"
                : "group-or-other"
              : "unknown";
            console.log(
              `WhatsApp upsert item chat=${chatKind} fromMe=${msg.key.fromMe ? "yes" : "no"} text=${text ? "yes" : "no"} media=${mediaKind ?? "-"} handle=${inbound ? "yes" : "no"}`
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
              shouldHandle: Boolean(inbound),
            })
          ) {
            continue;
          }
          if (!(remoteJid && inbound)) {
            continue;
          }

          console.log("WhatsApp message received.", {
            group: inbound.isGroup,
            hasMedia: Boolean(mediaKind),
            hasText: Boolean(text),
          });

          try {
            await deps.onMessage({
              ...inbound,
              inbound: msg,
            });
          } catch (error) {
            console.error("WhatsApp inbound message handling failed.", {
              errorType: getSafeWhatsAppErrorType(error),
            });
          }
        }
      });
    },
    async stop() {
      stopped = true;
      generation += 1;
      const current = socket;
      socket = null;
      await disposeWhatsAppSocket(current);
    },
  };

  return handle;
}

export function whatsAppReconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
}

function isVerboseLoggingEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isSupportedUpsertType(type: string): boolean {
  return type === "notify" || type === "append";
}

export function shouldRequestDevicePairingCode(input: {
  alreadyRequested: boolean;
  phoneDigits: string;
  registered: boolean;
}): boolean {
  return (
    !(input.registered || input.alreadyRequested) &&
    input.phoneDigits.length >= 8
  );
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

const WHATSAPP_SOCKET_EVENTS = [
  "chats.phoneNumberShare",
  "connection.update",
  "creds.update",
  "messages.upsert",
] as const;

export function detachWhatsAppSocketListeners(target: {
  ev: {
    removeAllListeners: (
      event: (typeof WHATSAPP_SOCKET_EVENTS)[number]
    ) => unknown;
  };
}): void {
  for (const event of WHATSAPP_SOCKET_EVENTS) {
    target.ev.removeAllListeners(event);
  }
}

async function disposeWhatsAppSocket(target: WASocket | null): Promise<void> {
  if (!target) {
    return;
  }

  try {
    detachWhatsAppSocketListeners(target);
  } catch {
    // Best-effort: Baileys versions differ on listener APIs.
  }

  try {
    await Promise.resolve(target.end(undefined));
  } catch {
    // Socket may already be closed.
  }
}

export function summarizeMissingTextPayload(msg: {
  key: {
    remoteJid?: string | null;
    fromMe?: boolean | null;
    participant?: string | null;
    id?: string | null;
  };
  message?: Record<string, unknown> | null;
  messageStubType?: unknown;
}): string {
  const summary = {
    hasContent: Boolean(msg.message),
    key: {
      fromMe: msg.key.fromMe ?? null,
      hasId: Boolean(msg.key.id),
      hasParticipant: Boolean(msg.key.participant),
      isPrivate: msg.key.remoteJid
        ? isPrivateWhatsAppChat(msg.key.remoteJid)
        : null,
    },
    messageStubType:
      typeof msg.messageStubType === "number" ? msg.messageStubType : null,
  };

  return JSON.stringify(summary);
}
