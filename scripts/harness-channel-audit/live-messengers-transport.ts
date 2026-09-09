import { sendDiscordArtifactAttachment } from "../../apps/platform/discord/src/send-artifact-attachment";
import { sendTelegramArtifact } from "../../apps/platform/telegram/src/send-artifact-document";
import {
  type LiveManifest,
  type LiveTransport,
  MAX_FILE_BYTES,
  type Receipt,
  type RunState,
  requireProof,
  type SentFile,
} from "./live-messengers";

type JsonRecord = Record<string, unknown>;
function object(value: unknown): JsonRecord {
  requireProof(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "INVALID_PLATFORM_RESPONSE"
  );
  return value as JsonRecord;
}
function string(value: unknown): string {
  requireProof(
    typeof value === "string" && value.length > 0,
    "INVALID_PLATFORM_IDENTIFIER"
  );
  return value;
}
async function request(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  requireProof(response.ok, "PLATFORM_HTTP_FAILED");
  return response.json();
}

export async function downloadBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  requireProof(response.ok && response.body, "FILE_DOWNLOAD_FAILED");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      size += part.value.length;
      requireProof(size <= MAX_FILE_BYTES, "FILE_DOWNLOAD_TOO_LARGE");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, size);
}

class TelegramTransport implements LiveTransport {
  constructor(
    private readonly manifest: LiveManifest,
    private readonly token: string,
    private readonly workerAlive: boolean
  ) {}

  private async call(
    method: string,
    body: FormData | JsonRecord = {}
  ): Promise<unknown> {
    const multipart = body instanceof FormData;
    const response = object(
      await request(`https://api.telegram.org/bot${this.token}/${method}`, {
        body: multipart ? body : JSON.stringify(body),
        headers: multipart ? undefined : { "Content-Type": "application/json" },
        method: "POST",
      })
    );
    requireProof(response.ok === true, "TELEGRAM_API_REJECTED");
    return response.result;
  }

  async probe(): Promise<void> {
    const me = object(await this.call("getMe"));
    requireProof(me.is_bot === true, "TELEGRAM_BOT_REQUIRED");
    // This checks the exact authorized chat without enumerating other chats.
    const chat = object(
      await this.call("getChat", { chat_id: this.manifest.destination })
    );
    requireProof(
      String(chat.id) === this.manifest.destination,
      "TELEGRAM_CHAT_MISMATCH"
    );
  }

  async send(bytes: Uint8Array, filename: string): Promise<SentFile> {
    let result: unknown;
    const api = {
      sendDocument: async (
        chatId: number,
        file: { filename?: string; toRaw: () => Promise<unknown> },
        options?: { message_thread_id?: number }
      ) => {
        requireProof(
          String(chatId) === this.manifest.destination &&
            options?.message_thread_id === this.manifest.topicId,
          "TELEGRAM_SEND_SCOPE_MISMATCH"
        );
        const raw = await file.toRaw();
        requireProof(
          raw instanceof Uint8Array,
          "UNEXPECTED_PRODUCTION_FILE_TYPE"
        );
        const form = new FormData();
        form.set("chat_id", this.manifest.destination);
        if (this.manifest.topicId !== undefined) {
          form.set("message_thread_id", String(this.manifest.topicId));
        }
        form.set(
          "document",
          new Blob([Buffer.from(raw)], { type: "text/plain" }),
          filename
        );
        result = await this.call("sendDocument", form);
        return result;
      },
    };
    const context = {
      api,
      chat: { id: Number(this.manifest.destination) },
      message: { message_thread_id: this.manifest.topicId },
    } as unknown as Parameters<typeof sendTelegramArtifact>[0];
    const delivered = await sendTelegramArtifact(context, {
      bytes,
      filename,
      mimeType: "text/plain",
    });
    requireProof(delivered.ok, "TELEGRAM_PRODUCTION_UPLOAD_FAILED");
    const sent = object(result);
    requireProof(
      String(object(sent.chat).id) === this.manifest.destination,
      "TELEGRAM_RESPONSE_SCOPE_MISMATCH"
    );
    requireProof(
      object(sent.document).file_name === filename,
      "TELEGRAM_RESPONSE_FILENAME_MISMATCH"
    );
    return {
      fileId: string(object(sent.document).file_id),
      messageId: String(sent.message_id),
      sentAt: Number(sent.date) * 1000,
    };
  }

  private async download(fileId: string): Promise<Uint8Array> {
    const file = object(await this.call("getFile", { file_id: fileId }));
    const path = string(file.file_path);
    requireProof(
      /^[a-zA-Z0-9_./-]+$/.test(path) && !path.includes(".."),
      "INVALID_TELEGRAM_FILE_PATH"
    );
    return downloadBytes(
      `https://api.telegram.org/file/bot${this.token}/${path}`
    );
  }

  downloadSent(sent: SentFile): Promise<Uint8Array> {
    return this.download(sent.fileId);
  }

  async receive(state: RunState): Promise<Receipt | null> {
    requireProof(
      this.manifest.dedicatedTelegramPolling === true && !this.workerAlive,
      "DEDICATED_IDLE_TELEGRAM_RECEIVER_REQUIRED"
    );
    const webhook = object(await this.call("getWebhookInfo"));
    requireProof(webhook.url === "", "TELEGRAM_WEBHOOK_ACTIVE");
    // No positive offset: do not acknowledge or consume unrelated updates.
    const updates = await this.call("getUpdates", { limit: 100, timeout: 0 });
    requireProof(Array.isArray(updates), "INVALID_TELEGRAM_UPDATES");
    for (const update of updates) {
      const value = object(update).message;
      if (!value) {
        continue;
      }
      const m = object(value);
      if (!(m.chat && m.from && m.reply_to_message && m.document)) {
        continue;
      }
      if (
        String(object(m.chat).id) !== this.manifest.destination ||
        String(object(m.from).id) !== this.manifest.receiverUserId ||
        object(m.from).is_bot === true ||
        String(object(m.reply_to_message).message_id) !==
          state.sent.messageId ||
        object(m.document).file_name !== state.filename ||
        m.message_thread_id !== this.manifest.topicId
      ) {
        continue;
      }
      return {
        bytes: await this.download(string(object(m.document).file_id)),
        destination: String(object(m.chat).id),
        filename: state.filename,
        messageId: String(m.message_id),
        receivedAt: Number(m.date) * 1000,
        receiverUserId: String(object(m.from).id),
        replyToMessageId: String(object(m.reply_to_message).message_id),
        topicId: this.manifest.topicId,
      };
    }
    return null;
  }
}

class DiscordTransport implements LiveTransport {
  constructor(
    private readonly manifest: LiveManifest,
    private readonly token: string
  ) {}

  private call(path: string, init?: RequestInit): Promise<unknown> {
    return request(`https://discord.com/api/v10${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bot ${this.token}` },
    });
  }
  async probe(): Promise<void> {
    requireProof(
      object(await this.call("/users/@me")).bot === true,
      "DISCORD_BOT_REQUIRED"
    );
    const chat = object(
      await this.call(`/channels/${this.manifest.destination}`)
    );
    requireProof(
      chat.id === this.manifest.destination,
      "DISCORD_CHAT_MISMATCH"
    );
  }
  async send(bytes: Uint8Array, filename: string): Promise<SentFile> {
    let result: unknown;
    const channel = {
      send: async (options: {
        files: Array<{ attachment: unknown; name: string }>;
      }) => {
        const attachment = options.files[0];
        requireProof(
          options.files.length === 1 &&
            attachment?.attachment instanceof Uint8Array &&
            attachment.name === filename,
          "UNEXPECTED_PRODUCTION_ATTACHMENT"
        );
        const form = new FormData();
        form.set(
          "payload_json",
          JSON.stringify({ attachments: [{ filename, id: 0 }] })
        );
        form.set(
          "files[0]",
          new Blob([Buffer.from(attachment.attachment)], {
            type: "text/plain",
          }),
          filename
        );
        result = await this.call(
          `/channels/${this.manifest.destination}/messages`,
          { body: form, method: "POST" }
        );
        return result;
      },
    } as unknown as Parameters<typeof sendDiscordArtifactAttachment>[0];
    const delivered = await sendDiscordArtifactAttachment(channel, {
      bytes,
      filename,
      mimeType: "text/plain",
    });
    requireProof(delivered.ok, "DISCORD_PRODUCTION_UPLOAD_FAILED");
    const sent = object(result);
    requireProof(
      sent.channel_id === this.manifest.destination,
      "DISCORD_RESPONSE_SCOPE_MISMATCH"
    );
    return {
      fileId: filename,
      messageId: string(sent.id),
      sentAt: Date.parse(string(sent.timestamp)),
    };
  }

  private async downloadAttachment(
    message: JsonRecord,
    filename: string
  ): Promise<Uint8Array> {
    requireProof(
      Array.isArray(message.attachments),
      "DISCORD_ATTACHMENT_MISSING"
    );
    const attachment = message.attachments
      .map(object)
      .find((item) => item.filename === filename);
    requireProof(attachment, "DISCORD_FILENAME_MISMATCH");
    const url = new URL(string(attachment.url));
    requireProof(
      url.protocol === "https:" &&
        ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.port,
      "UNTRUSTED_DISCORD_ATTACHMENT_URL"
    );
    return downloadBytes(url.toString());
  }

  async downloadSent(sent: SentFile): Promise<Uint8Array> {
    const message = object(
      await this.call(
        `/channels/${this.manifest.destination}/messages/${sent.messageId}`
      )
    );
    requireProof(
      message.channel_id === this.manifest.destination &&
        message.id === sent.messageId,
      "DISCORD_STORED_MESSAGE_MISMATCH"
    );
    return this.downloadAttachment(message, sent.fileId);
  }

  async receive(state: RunState): Promise<Receipt | null> {
    const messages = await this.call(
      `/channels/${this.manifest.destination}/messages?after=${encodeURIComponent(state.sent.messageId)}&limit=100`
    );
    requireProof(Array.isArray(messages), "INVALID_DISCORD_MESSAGES");
    for (const value of messages) {
      const m = object(value);
      if (!(m.author && m.message_reference && Array.isArray(m.attachments))) {
        continue;
      }
      if (
        m.channel_id !== this.manifest.destination ||
        object(m.author).id !== this.manifest.receiverUserId ||
        object(m.author).bot === true ||
        object(m.message_reference).message_id !== state.sent.messageId ||
        !m.attachments.some((a) => object(a).filename === state.filename)
      ) {
        continue;
      }
      return {
        bytes: await this.downloadAttachment(m, state.filename),
        destination: string(m.channel_id),
        filename: state.filename,
        messageId: string(m.id),
        receivedAt: Date.parse(string(m.timestamp)),
        receiverUserId: string(object(m.author).id),
        replyToMessageId: string(object(m.message_reference).message_id),
      };
    }
    return null;
  }
}

export function makeLiveTransport(
  manifest: LiveManifest,
  token: string,
  workerAlive: boolean
): LiveTransport {
  requireProof(
    manifest.channel !== "whatsapp",
    "DEDICATED_WHATSAPP_FILE_SOCKET_REQUIRED"
  );
  return manifest.channel === "telegram"
    ? new TelegramTransport(manifest, token, workerAlive)
    : new DiscordTransport(manifest, token);
}
