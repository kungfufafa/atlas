import { loadTelegramConfigFile } from "../telegram-config";
import { splitTelegramChunks } from "./message-format";
import {
  assertOutboundEnvelope,
  revalidateOutboundAllowlist,
} from "./outbound-envelope";
import { renderTelegramRichText } from "./telegram-rich-text";
import type { ChannelSendResult, TelegramOutboundAdapter } from "./types";

export interface TelegramOutboundOptions {
  fetchImpl?: typeof fetch;
}

export function createTelegramOutboundAdapter(
  options: TelegramOutboundOptions = {}
): TelegramOutboundAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async send(input): Promise<ChannelSendResult> {
      try {
        const orgId = input.orgId?.trim();
        if (!orgId) {
          return { error: "Outbound envelope orgId is required.", ok: false };
        }

        const config = await loadTelegramConfigFile(orgId);
        const token = config?.botToken.trim();

        if (!token) {
          return { error: "Telegram bot token is not configured.", ok: false };
        }

        const chatIds =
          input.chatIds && input.chatIds.length > 0
            ? input.chatIds
            : (config?.pairedUserIds ?? []);

        if (chatIds.length === 0) {
          return { error: "No Telegram chat is paired.", ok: false };
        }

        for (const chatId of chatIds) {
          const envelope = assertOutboundEnvelope({
            orgId,
            replyTarget: {
              channel: "telegram",
              telegram: { chatId, topicId: input.topicId },
            },
            text: input.text,
          });
          revalidateOutboundAllowlist(envelope, {
            accessMode: config?.accessMode,
            allowedUserIds: config?.allowedUserIds,
            blockedUserIds: config?.blockedUserIds,
            pairedUserIds: config?.pairedUserIds,
          });
        }

        const chunks = splitTelegramChunks(
          assertOutboundEnvelope({
            orgId,
            replyTarget: {
              channel: "telegram",
              telegram: { chatId: chatIds[0]! },
            },
            text: input.text,
          }).text
        );

        if (chunks.length === 0) {
          return { error: "Message text is empty.", ok: false };
        }

        for (const chatId of chatIds) {
          for (const chunk of chunks) {
            const text =
              input.parseMode === "HTML"
                ? renderTelegramRichText(chunk)
                : chunk;
            const response = await fetchImpl(
              `https://api.telegram.org/bot${token}/sendMessage`,
              {
                body: JSON.stringify({
                  chat_id: chatId,
                  text,
                  ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
                  ...(input.topicId
                    ? { message_thread_id: input.topicId }
                    : {}),
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
              }
            );

            if (!response.ok) {
              const body = await response.text();
              return {
                error: `Telegram API error (${response.status}): ${body.slice(0, 200)}`,
                ok: false,
              };
            }
          }
        }

        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: message, ok: false };
      }
    },
  };
}
