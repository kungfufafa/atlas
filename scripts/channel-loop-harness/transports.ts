import type { WAMessage } from "@whiskeysockets/baileys";
import type { Message } from "discord.js";
import type { Context } from "grammy";

export interface OutboundFile {
  bytes?: Uint8Array;
  filename: string;
}

export interface WhatsAppProbe {
  handle: (input: {
    inbound?: WAMessage | null;
    jid: string;
    senderPn?: string | null;
    text: string;
  }) => Promise<void>;
  sent: Array<{
    document?: unknown;
    fileName?: string;
    jid: string;
    mimetype?: string;
    text?: string;
  }>;
  setDownload: (bytes: Buffer) => void;
}

export interface TelegramProbe {
  ctx: Context;
  documents: OutboundFile[];
  replies: string[];
}

export interface DiscordProbe {
  documents: OutboundFile[];
  fileSendCalls: number;
  message: Message;
  sentMessages: string[];
}

export function createWhatsAppSocketProbe(): {
  probe: Omit<WhatsAppProbe, "handle" | "setDownload"> & {
    download: (message: WAMessage) => Promise<Buffer>;
    socket: {
      sendMessage: (
        jid: string,
        content: {
          document?: unknown;
          fileName?: string;
          image?: unknown;
          mimetype?: string;
          text?: string;
        }
      ) => Promise<void>;
      sendPresenceUpdate: () => Promise<void>;
    };
  };
  setDownload: (bytes: Buffer) => void;
} {
  const sent: WhatsAppProbe["sent"] = [];
  let downloadBytes = Buffer.from([]);

  return {
    probe: {
      download: async () => downloadBytes,
      sent,
      socket: {
        sendMessage: async (jid, content) => {
          sent.push({
            document: content.document,
            fileName: content.fileName,
            jid,
            mimetype: content.mimetype,
            text: content.text,
          });
        },
        sendPresenceUpdate: async () => {},
      },
    },
    setDownload: (bytes) => {
      downloadBytes = bytes;
    },
  };
}

export function createWhatsAppDocumentMessage(options: {
  caption?: string;
  fileLength: number;
  fileName: string;
  mimeType: string;
  remoteJid: string;
}): WAMessage {
  return {
    key: {
      fromMe: false,
      id: `wa-${Date.now()}`,
      remoteJid: options.remoteJid,
    },
    message: {
      documentMessage: {
        caption: options.caption,
        fileLength: options.fileLength,
        fileName: options.fileName,
        mimetype: options.mimeType,
      },
    },
  };
}

export function createTelegramDocumentProbe(options: {
  caption?: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  userId: number;
}): TelegramProbe {
  const replies: string[] = [];
  const documents: OutboundFile[] = [];
  let nextMessageId = 1;

  const ctx = {
    api: {
      getFile: async () => ({
        file_path: `documents/${options.fileName}`,
        file_size: options.fileSize,
      }),
      sendDocument: async (_chatId: number, file: unknown) => {
        documents.push({
          bytes: attachmentBytes(file, "fileData"),
          filename: telegramFilename(file),
        });
        return { message_id: nextMessageId++ };
      },
      token: "channel-loop-token",
    },
    chat: { id: options.userId, type: "private" as const },
    from: { id: options.userId },
    message: {
      caption: options.caption,
      document: {
        file_id: `file-${options.fileName}`,
        file_name: options.fileName,
        file_size: options.fileSize,
        mime_type: options.mimeType,
      },
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: nextMessageId++ };
    },
    replyWithChatAction: async () => {},
  } as unknown as Context;

  return { ctx, documents, replies };
}

export function createDiscordDocumentProbe(options: {
  caption?: string;
  channelId: string;
  contentType: string;
  fileName: string;
  fileSize: number;
  url: string;
  userId: string;
}): DiscordProbe {
  const sentMessages: string[] = [];
  const documents: OutboundFile[] = [];
  let fileSendCalls = 0;

  const channel = {
    id: options.channelId,
    isDMBased: () => true,
    isTextBased: () => true,
    isThread: () => false,
    messages: {
      fetch: async () => ({
        edit: async () => {},
      }),
    },
    parentId: null,
    send: async (payload: string | { files?: unknown[] }) => {
      if (typeof payload === "string") {
        sentMessages.push(payload);
        return { id: String(sentMessages.length) };
      }

      fileSendCalls += 1;
      for (const file of payload.files ?? []) {
        documents.push({
          bytes: attachmentBytes(file, "attachment"),
          filename: discordFilename(file),
        });
      }
      return { id: String(sentMessages.length) };
    },
    sendTyping: async () => {},
  };

  const attachments = new Map([
    [
      options.url,
      {
        contentType: options.contentType,
        name: options.fileName,
        size: options.fileSize,
        url: options.url,
      },
    ],
  ]);

  const message = {
    attachments: {
      size: attachments.size,
      values: () => attachments.values(),
    },
    author: { bot: false, id: options.userId },
    channel,
    client: { user: { id: "bot_id", username: "atlasbot" } },
    content: options.caption ?? "",
  } as unknown as Message;

  return {
    get documents() {
      return documents;
    },
    get fileSendCalls() {
      return fileSendCalls;
    },
    message,
    sentMessages,
  };
}

export function installFileFetchInterceptor(
  files: Map<string, { bytes: Uint8Array; contentType: string }>
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    for (const [key, file] of files) {
      if (url.includes(key)) {
        return new Response(file.bytes, {
          headers: { "content-type": file.contentType },
        });
      }
    }

    return originalFetch(input, init);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function telegramFilename(file: unknown): string {
  if (file && typeof file === "object") {
    const record = file as { filename?: string; fileName?: string };
    if (typeof record.filename === "string" && record.filename.trim()) {
      return record.filename;
    }
    if (typeof record.fileName === "string" && record.fileName.trim()) {
      return record.fileName;
    }
  }

  return "unknown";
}

function attachmentBytes(file: unknown, key: string): Uint8Array | undefined {
  if (!file || typeof file !== "object") {
    return;
  }
  const bytes: unknown = Reflect.get(file, key);
  return bytes instanceof Uint8Array ? new Uint8Array(bytes) : undefined;
}

function discordFilename(file: unknown): string {
  if (file && typeof file === "object") {
    const record = file as { filename?: string; name?: string };
    if (typeof record.name === "string" && record.name.trim()) {
      return record.name;
    }
    if (typeof record.filename === "string" && record.filename.trim()) {
      return record.filename;
    }
  }

  return "unknown";
}
