import { createHash } from "node:crypto";
import { join } from "node:path";
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
import { WhatsAppProtocolCache } from "./baileys-cache";
import {
  createBaileysLogger,
  getSafeWhatsAppErrorType,
} from "./baileys-logger";
import { isWhatsAppInboundReplaySafeError } from "./delivery-error";
import { stripWhatsAppBotMention } from "./group-message";
import { InboundDeliveryLedger } from "./inbound-delivery-ledger";
import { WhatsAppInboundDispatcher } from "./inbound-dispatch";
import {
  extractInboundText,
  inspectInboundWhatsAppMedia,
  isPrivateWhatsAppChat,
  parseInboundWhatsAppMessage,
  type WhatsAppInboundChat,
} from "./inbound-message";
import {
  BoundedWorkQueue,
  InboundQueueSaturatedError,
} from "./inbound-work-queue";
import {
  parseWhatsAppNativeReaction,
  type WhatsAppNativeReaction,
} from "./native-controls";

import {
  extractDisconnectStatusCode,
  WhatsAppReconnectPolicy,
} from "./reconnect-policy";

export {
  extractDisconnectStatusCode,
  whatsAppReconnectDelayMs,
} from "./reconnect-policy";

export interface WhatsAppSocketDeps {
  allowUnaddressedGroup?: (inbound: WhatsAppInboundChat) => Promise<boolean>;
  onConnected?: (me: { id: string; lid?: string | null }) => void;
  onDevicePairingCode?: (code: string) => void;
  onDisconnected?: () => void;
  onMessage: (
    data: WhatsAppInboundChat & {
      inbound?: WAMessage | null;
      receivedAt?: number;
    }
  ) => Promise<void>;
  onPhoneNumberShare?: (lid: string, phoneJid: string) => void;
  onQr?: (qr: string) => void;
  onReaction?: (reaction: WhatsAppNativeReaction) => Promise<void>;
  phoneNumber?: string;
}

export interface WhatsAppSocketHandle {
  socket: WASocket | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

const BUSY_REPLY_COOLDOWN_MS = 60_000;
const BUSY_REPLY_GLOBAL_WINDOW_MS = 60_000;
const BUSY_REPLY_GLOBAL_LIMIT = 20;
const INBOUND_RETRY_ATTEMPTS = 3;
const INBOUND_RETRY_BASE_DELAY_MS = 500;

interface BusyReplyLimiterOptions {
  cooldownMs?: number;
  globalLimit?: number;
  now?: () => number;
  windowMs?: number;
}

/**
 * Prevents queue overload from turning into an outbound reply amplifier. The
 * per-chat cooldown also keeps one noisy sender from consuming the global
 * allowance reserved for other users.
 */
export class BusyReplyLimiter {
  private readonly cooldownMs: number;
  private globalCount = 0;
  private readonly globalLimit: number;
  private readonly lastReplyByChat = new Map<string, number>();
  private readonly now: () => number;
  private readonly windowMs: number;
  private windowStartedAt: number;

  constructor(options: BusyReplyLimiterOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? BUSY_REPLY_COOLDOWN_MS;
    this.globalLimit = options.globalLimit ?? BUSY_REPLY_GLOBAL_LIMIT;
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? BUSY_REPLY_GLOBAL_WINDOW_MS;
    this.windowStartedAt = this.now();
  }

  allow(chatId: string): boolean {
    const now = this.now();
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.globalCount = 0;
      this.prune(now);
    }

    const lastReplyAt = this.lastReplyByChat.get(chatId);
    if (
      this.globalCount >= this.globalLimit ||
      (lastReplyAt !== undefined && now - lastReplyAt < this.cooldownMs)
    ) {
      return false;
    }

    this.lastReplyByChat.set(chatId, now);
    this.globalCount += 1;
    return true;
  }

  private prune(now: number): void {
    for (const [chatId, lastReplyAt] of this.lastReplyByChat) {
      if (now - lastReplyAt >= this.cooldownMs) {
        this.lastReplyByChat.delete(chatId);
      }
    }
  }
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
  const reconnectPolicy = new WhatsAppReconnectPolicy();
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const maxMsgRetryCount = 5;
  const msgRetryCounterCache = new WhatsAppProtocolCache({
    retainAtRetryLimit: maxMsgRetryCount,
    ttlMs: 60 * 60_000,
  });
  const placeholderResendCache = new WhatsAppProtocolCache({
    ttlMs: 60 * 60_000,
  });
  let loggedMissingTextPayload = false;
  const baileysLogger = createBaileysLogger();
  const inboundDeliveryLedger = new InboundDeliveryLedger(
    join(getWhatsAppConfigDir(), "inbound-deliveries.jsonl")
  );
  await inboundDeliveryLedger.load();
  const inboundDispatcher = new WhatsAppInboundDispatcher();
  const busyReplyQueue = new BoundedWorkQueue({
    maxConcurrent: 2,
    maxQueued: 20,
    maxWaitMs: 10_000,
  });
  const busyReplyLimiter = new BusyReplyLimiter();

  const scheduleReconnect = (waitMs: number, expectedGeneration: number) => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (stopped || generation !== expectedGeneration) {
        return;
      }
      const starting = handle.start();
      const attemptedGeneration = generation;
      void starting.catch((error) => {
        if (stopped || generation !== attemptedGeneration) {
          return;
        }
        const retryDelay = reconnectPolicy.closed(
          extractDisconnectStatusCode(error)
        );
        console.error("WhatsApp socket reconnect failed.", {
          errorType: getSafeWhatsAppErrorType(error),
          retryDelayMs: retryDelay,
        });
        if (retryDelay !== null) {
          scheduleReconnect(retryDelay, attemptedGeneration);
        }
      });
    }, waitMs);
  };

  const handle = {
    get socket() {
      return socket;
    },
    async start() {
      if (stopped || reconnectPolicy.isHalted) {
        return;
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;

      const myGen = ++generation;
      const previous = socket;
      socket = null;
      await disposeWhatsAppSocket(previous);
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
        maxMsgRetryCount,
        msgRetryCounterCache,
        placeholderResendCache,
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
          reconnectPolicy.opened();
          const me = state.creds.me;
          if (me?.id) {
            deps.onConnected?.({ id: me.id, lid: me.lid ?? null });
          }
        }

        if (connection === "close") {
          const closedGeneration = ++generation;
          socket = null;
          detachWhatsAppSocketListeners(current);
          deps.onDisconnected?.();
          const statusCode = extractDisconnectStatusCode(lastDisconnect);
          const waitMs = stopped ? null : reconnectPolicy.closed(statusCode);
          await disposeWhatsAppSocket(current);
          const isRestartRequired =
            statusCode === DisconnectReason.restartRequired;
          const statusText = isRestartRequired
            ? "515 - restart required"
            : String(statusCode ?? "unknown");
          if (waitMs === null) {
            console.warn(
              `WhatsApp disconnected (code: ${statusText}). Automatic reconnect stopped; check Linked Devices and reconnect in Integrations → WhatsApp.`
            );
            return;
          }
          console.log(
            `WhatsApp disconnected (code: ${statusText}). Reconnecting in ${waitMs / 1000}s.`
          );
          if (stopped || generation !== closedGeneration) {
            return;
          }
          scheduleReconnect(waitMs, closedGeneration);
        }
      });

      next.ev.on("creds.update", saveCreds);

      next.ev.on("messages.reaction", async (events) => {
        if (myGen !== generation || socket !== current || !deps.onReaction) {
          return;
        }
        await dispatchWhatsAppMessagesConcurrently(events, async (event) => {
          const reaction = parseWhatsAppNativeReaction(event, state.creds.me);
          if (!reaction) {
            return;
          }
          try {
            await inboundDispatcher.runReaction(
              reaction.destination,
              reaction.emoji,
              async () => {
                if (myGen === generation && socket === current) {
                  await deps.onReaction?.(reaction);
                }
              }
            );
          } catch (error) {
            console.error("WhatsApp reaction handling failed.", {
              errorType: getSafeWhatsAppErrorType(error),
            });
          }
        });
      });

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

        await dispatchWhatsAppMessagesConcurrently(m.messages, async (msg) => {
          const receivedAt = performance.timeOrigin + performance.now();
          try {
            const candidate = parseInboundWhatsAppMessage(msg, me, {
              allowUnaddressedGroup: true,
            });
            const routingText = candidate?.isGroup
              ? stripWhatsAppBotMention({
                  me,
                  mentionedJids: candidate.mentionedJids,
                  text: candidate.text,
                })
              : extractInboundText(msg.message);
            await inboundDispatcher.runMessage(
              msg.key.remoteJid ?? "",
              routingText,
              async () => {
                if (myGen !== generation || socket !== current) {
                  return;
                }

                const remoteJid = msg.key.remoteJid ?? null;
                const messageId = msg.key.id?.trim();
                const text = extractInboundText(msg.message);
                const mediaKind = inspectInboundWhatsAppMedia(
                  msg.message
                )?.kind;
                const allowUnaddressedGroup = Boolean(
                  candidate?.isGroup &&
                    (await deps.allowUnaddressedGroup?.(candidate))
                );
                const inbound = parseInboundWhatsAppMessage(msg, me, {
                  allowUnaddressedGroup,
                });

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

                if (!(remoteJid && inbound)) {
                  return;
                }

                const deliveryId = buildInboundDeliveryId({
                  messageId,
                  participant: msg.key.participant,
                  remoteJid,
                });
                if (deliveryId && !inboundDeliveryLedger.claim(deliveryId)) {
                  return;
                }

                console.log("WhatsApp message received.", {
                  group: inbound.isGroup,
                  hasMedia: Boolean(mediaKind),
                  hasText: Boolean(text),
                });

                const deliveryResult = await runClaimedInboundDelivery({
                  deliver: () =>
                    deps.onMessage({
                      ...inbound,
                      inbound: msg,
                      receivedAt,
                    }),
                  deliveryId,
                  isCurrent: () =>
                    !stopped && myGen === generation && socket === current,
                  ledger: inboundDeliveryLedger,
                });
                if (deliveryResult.error) {
                  console.error("WhatsApp inbound message handling failed.", {
                    attempts: deliveryResult.attempts,
                    deliveryDisposition: deliveryResult.disposition,
                    errorType: getSafeWhatsAppErrorType(deliveryResult.error),
                  });
                  return;
                }
                if (deliveryResult.attempts > 1) {
                  console.warn("WhatsApp inbound message retry recovered.", {
                    attempts: deliveryResult.attempts,
                  });
                }
              }
            );
          } catch (error) {
            const queue = inboundDispatcher.snapshot();
            console.error("WhatsApp inbound queue rejected a message.", {
              controls: queue.controls,
              errorType: getSafeWhatsAppErrorType(error),
              messages: queue.messages,
            });
            if (!(error instanceof InboundQueueSaturatedError)) {
              return;
            }

            const jid = msg.key.remoteJid?.trim();
            if (
              !(
                jid &&
                parseInboundWhatsAppMessage(msg, me) &&
                busyReplyLimiter.allow(jid)
              )
            ) {
              return;
            }

            void busyReplyQueue
              .run(async () => {
                if (myGen !== generation || socket !== current) {
                  return;
                }
                await current.sendMessage(jid, {
                  text: "Atlas is busy. Please try again shortly.",
                });
              })
              .catch(() => undefined);
          }
        });
      });
    },
    async stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      generation += 1;
      const current = socket;
      socket = null;
      await disposeWhatsAppSocket(current);
    },
  };

  return handle;
}

export async function dispatchWhatsAppMessagesConcurrently<T>(
  messages: readonly T[],
  handleMessage: (message: T) => Promise<void>
): Promise<void> {
  await Promise.allSettled(messages.map((message) => handleMessage(message)));
}

export type FailedInboundDeliveryDisposition =
  | "delivery-error-recorded"
  | "delivery-error-recording-failed"
  | "released-for-provider-replay"
  | "untracked";

interface FailedInboundDeliveryLedger {
  complete: (id: string) => Promise<void>;
  release: (id: string) => void;
}

type ClaimedInboundDeliveryDisposition =
  | FailedInboundDeliveryDisposition
  | "completed"
  | "completion-recording-failed"
  | "released-stale";

export interface ClaimedInboundDeliveryResult {
  attempts: number;
  disposition: ClaimedInboundDeliveryDisposition;
  error?: unknown;
}

interface RunClaimedInboundDeliveryInput {
  deliver: () => Promise<void>;
  deliveryId: string | null;
  isCurrent?: () => boolean;
  ledger: FailedInboundDeliveryLedger;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}

/**
 * Retries failures that the handler contract considers safe to replay while
 * retaining the in-flight ledger claim. Delivery failures are never replayed:
 * the agent may already have run and the outbound result can be unknown.
 */
export async function runClaimedInboundDelivery(
  input: RunClaimedInboundDeliveryInput
): Promise<ClaimedInboundDeliveryResult> {
  const maxAttempts = input.maxAttempts ?? INBOUND_RETRY_ATTEMPTS;
  const retryBaseDelayMs =
    input.retryBaseDelayMs ?? INBOUND_RETRY_BASE_DELAY_MS;
  const wait = input.wait ?? waitForInboundRetryDelay;

  if (!(Number.isSafeInteger(maxAttempts) && maxAttempts > 0)) {
    throw new RangeError("WhatsApp inbound retry attempts must be positive.");
  }
  if (!(Number.isFinite(retryBaseDelayMs) && retryBaseDelayMs >= 0)) {
    throw new RangeError("WhatsApp inbound retry delay cannot be negative.");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (input.isCurrent?.() === false) {
      if (input.deliveryId) {
        input.ledger.release(input.deliveryId);
      }
      return { attempts: attempt - 1, disposition: "released-stale" };
    }

    try {
      await input.deliver();
    } catch (error) {
      const replaySafe = isWhatsAppInboundReplaySafeError(error);
      if (!replaySafe || attempt === maxAttempts) {
        return {
          attempts: attempt,
          disposition: await settleFailedInboundDelivery({
            deliveryId: input.deliveryId,
            error,
            ledger: input.ledger,
          }),
          error,
        };
      }

      try {
        await wait(calculateInboundRetryDelayMs(retryBaseDelayMs, attempt));
      } catch (error) {
        if (input.deliveryId) {
          input.ledger.release(input.deliveryId);
        }
        return {
          attempts: attempt,
          disposition: "released-stale",
          error,
        };
      }
      continue;
    }

    if (!input.deliveryId) {
      return { attempts: attempt, disposition: "untracked" };
    }

    try {
      await input.ledger.complete(input.deliveryId);
      return { attempts: attempt, disposition: "completed" };
    } catch (error) {
      // InboundDeliveryLedger keeps the id completed in memory even if its
      // durable append fails. Releasing here could duplicate the agent turn.
      return {
        attempts: attempt,
        disposition: "completion-recording-failed",
        error,
      };
    }
  }

  throw new Error("WhatsApp inbound retry loop exited unexpectedly.");
}

function calculateInboundRetryDelayMs(
  baseDelayMs: number,
  failedAttempt: number
): number {
  return baseDelayMs * 2 ** Math.max(0, failedAttempt - 1);
}

async function waitForInboundRetryDelay(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Outbound delivery errors happen after the handler may already have invoked
 * the agent. Persist those inbound ids as consumed so a Baileys replay cannot
 * repeat the turn and its side effects. Other handler failures release their
 * claim because they remain safe for a provider replay.
 */
export async function settleFailedInboundDelivery(input: {
  deliveryId: string | null;
  error: unknown;
  ledger: FailedInboundDeliveryLedger;
}): Promise<FailedInboundDeliveryDisposition> {
  if (!input.deliveryId) {
    return "untracked";
  }

  if (isWhatsAppInboundReplaySafeError(input.error)) {
    input.ledger.release(input.deliveryId);
    return "released-for-provider-replay";
  }

  try {
    await input.ledger.complete(input.deliveryId);
    return "delivery-error-recorded";
  } catch {
    // InboundDeliveryLedger marks the id completed in memory before writing.
    // Do not release it and risk duplicating the agent turn in this process.
    return "delivery-error-recording-failed";
  }
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

export function buildInboundDeliveryId(input: {
  messageId?: string | null;
  participant?: string | null;
  remoteJid: string;
}): string | null {
  const messageId = input.messageId?.trim();
  if (!messageId) {
    return null;
  }

  const participant = input.participant?.trim() || "direct";
  return createHash("sha256")
    .update(`${input.remoteJid}:${participant}:${messageId}`)
    .digest("hex");
}

const WHATSAPP_SOCKET_EVENTS = [
  "chats.phoneNumberShare",
  "connection.update",
  "creds.update",
  "messages.upsert",
  "messages.reaction",
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
