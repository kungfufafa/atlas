import type {
  ChannelActionReceipt,
  ChannelNativeActionRequest,
} from "@atlas/core/channel-native-actions";
import { normalizeWhatsAppUserJid } from "@atlas/core/whatsapp-config";
import type {
  AnyMessageContent,
  WAMessageKey,
  WASocket,
} from "@whiskeysockets/baileys";
import type { WhatsAppNativeBinding } from "./native-controls";
import { encodeWhatsAppAudio, prepareWhatsAppVideo } from "./native-media";

interface BoundKey {
  binding: WhatsAppNativeBinding;
  expiresAt: number;
  key: WAMessageKey;
}

export class WhatsAppMessageRegistry {
  private readonly messages = new Map<string, BoundKey>();
  constructor(private readonly now: () => number = Date.now) {}

  remember(binding: WhatsAppNativeBinding, key: WAMessageKey): void {
    if (
      !key.id ||
      normalizeWhatsAppUserJid(key.remoteJid ?? "") !==
        normalizeWhatsAppUserJid(binding.destination)
    ) {
      return;
    }
    for (const [id, record] of this.messages) {
      if (record.expiresAt <= this.now()) {
        this.messages.delete(id);
      }
    }
    if (this.messages.size >= 2000) {
      return;
    }
    const id = this.id(binding, key.id);
    // A colliding provider id must never change who owns an already seen key.
    const previous = this.messages.get(id);
    if (
      previous &&
      (previous.key.fromMe !== key.fromMe ||
        previous.key.participant !== key.participant)
    ) {
      return;
    }
    this.messages.set(id, {
      binding: structuredClone(binding),
      expiresAt: this.now() + 24 * 60 * 60_000,
      key: { ...key },
    });
  }

  resolve(
    binding: WhatsAppNativeBinding,
    messageId: string,
    ownOnly: boolean
  ): WAMessageKey {
    const record = this.messages.get(this.id(binding, messageId));
    if (
      !record ||
      record.expiresAt <= this.now() ||
      (ownOnly && record.key.fromMe !== true)
    ) {
      throw new Error(
        "WhatsApp action target is not an eligible message in this conversation."
      );
    }
    return { ...record.key };
  }

  private id(binding: WhatsAppNativeBinding, messageId: string): string {
    return JSON.stringify([
      binding.orgId,
      binding.profileId,
      binding.sessionId,
      binding.userId,
      normalizeWhatsAppUserJid(binding.destination),
      messageId,
    ]);
  }
}

export async function executeWhatsAppNativeAction(input: {
  binding: WhatsAppNativeBinding;
  request: ChannelNativeActionRequest;
  currentMessageId?: string;
  registry: WhatsAppMessageRegistry;
  socket: WASocket | null;
  signal?: AbortSignal;
  beforeSend?: () => Promise<void>;
  readMedia: (
    path: string
  ) => Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
}): Promise<ChannelActionReceipt> {
  const { binding, request, socket } = input;
  if (
    request.channel !== "whatsapp" ||
    request.orgId !== binding.orgId ||
    request.profileId !== binding.profileId ||
    request.sessionId !== binding.sessionId ||
    request.channelChatId !== binding.destination ||
    request.channelThreadId !== undefined ||
    !(Date.parse(request.expiresAt) > Date.now())
  ) {
    return {
      error: "WhatsApp action scope is invalid or expired.",
      status: "failed",
    };
  }
  if (!socket) {
    return { error: "WhatsApp is disconnected.", status: "failed" };
  }
  let content: AnyMessageContent;
  try {
    input.signal?.throwIfAborted();
    const action = request.action;
    switch (action.kind) {
      case "react": {
        const messageId = action.messageId ?? input.currentMessageId;
        if (!messageId) {
          throw new Error("WhatsApp reaction needs a bound message.");
        }
        content = {
          react: {
            key: input.registry.resolve(binding, messageId, false),
            text: action.emoji,
          },
        };
        break;
      }
      case "edit":
        content = {
          edit: input.registry.resolve(binding, action.messageId, true),
          text: action.text,
        };
        break;
      case "delete":
        content = {
          delete: input.registry.resolve(binding, action.messageId, true),
        };
        break;
      case "poll":
        if (
          action.anonymous ||
          action.durationHours !== undefined ||
          action.openPeriodSeconds !== undefined
        ) {
          throw new Error(
            "WhatsApp polls do not support anonymous votes or an automatic duration through this transport."
          );
        }
        if (new Set(action.options).size !== action.options.length) {
          throw new Error("WhatsApp poll choices must be distinct.");
        }
        content = {
          poll: {
            name: action.question,
            selectableCount: action.allowMultiple ? action.options.length : 1,
            values: action.options,
          },
        };
        break;
      case "send_media": {
        const media = await input.readMedia(action.path);
        if (
          !media.bytes.byteLength ||
          media.bytes.byteLength > 25 * 1024 * 1024
        ) {
          throw new Error("WhatsApp media exceeds the 25 MB delivery limit.");
        }
        if (action.mode === "document") {
          content = {
            document: Buffer.from(media.bytes),
            fileName: media.filename,
            mimetype: media.mimeType,
          };
        } else if (action.mode === "video") {
          if (media.mimeType !== "video/mp4") {
            throw new Error(
              "WhatsApp video delivery requires an MP4 artifact."
            );
          }
          content = {
            mimetype: "video/mp4",
            ...(await prepareWhatsAppVideo(media.bytes, {
              signal: input.signal,
            })),
          };
        } else {
          const voiceNote = action.mode === "voice";
          content = {
            audio: await encodeWhatsAppAudio(
              media.bytes,
              media.mimeType,
              voiceNote,
              { signal: input.signal }
            ),
            mimetype: voiceNote ? "audio/ogg; codecs=opus" : "audio/mpeg",
            ptt: voiceNote,
          };
        }
        break;
      }
      default:
        throw new Error(`WhatsApp does not support the ${action.kind} action.`);
    }
    await input.beforeSend?.();
    input.signal?.throwIfAborted();
    if (!(Date.parse(request.expiresAt) > Date.now())) {
      throw new Error("WhatsApp action expired before delivery.");
    }
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "WhatsApp action preparation failed.",
      status: "failed",
    };
  }
  try {
    // No retry: a rejected or lost transport response can follow acceptance.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      socket.sendMessage(binding.destination, content),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("WhatsApp action timed out.")),
          30_000
        );
      }),
    ]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
    if (result?.key) {
      input.registry.remember(binding, result.key);
    }
    return result?.key.id &&
      result.key.fromMe === true &&
      normalizeWhatsAppUserJid(result.key.remoteJid ?? "") ===
        normalizeWhatsAppUserJid(binding.destination)
      ? { messageId: result.key.id, status: "accepted" }
      : {
          error: "WhatsApp returned no message acknowledgement.",
          status: "unknown",
        };
  } catch {
    return {
      error:
        "WhatsApp action delivery could not be confirmed; it was not retried.",
      status: "unknown",
    };
  }
}
