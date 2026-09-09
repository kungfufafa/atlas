import type { Context } from "grammy";

export interface TelegramBotInfo {
  id: number;
  username?: string;
}

export interface GroupMessageHandlingDecision {
  reason:
    | "slash-command"
    | "foreign-bot"
    | "missing-bot-info"
    | "reply-to-bot"
    | "bot-mention"
    | "no-text"
    | "no-trigger";
  shouldHandle: boolean;
}

export function hasTelegramFileAttachment(ctx: Context): boolean {
  return Boolean(
    ctx.message?.document ||
      ctx.message?.photo?.length ||
      ctx.message?.sticker ||
      ctx.message?.voice ||
      ctx.message?.audio ||
      ctx.message?.video ||
      ctx.message?.video_note
  );
}

export function formatIgnoredTelegramFileMessage(
  reason: GroupMessageHandlingDecision["reason"],
  botUsername?: string
): string {
  if (reason === "missing-bot-info") {
    return "This file was ignored because the bot's group identity is unavailable. Send it in a private chat with the bot.";
  }
  if (reason === "foreign-bot") {
    return "This file was ignored because the message addresses another bot. Send it again addressed to this bot.";
  }
  const mention = botUsername ? `@${botUsername}` : "the bot";
  return `This file was ignored because this group requires a mention or reply to the bot. Attach it again with ${mention} in the caption, or send it in a private chat.`;
}

export function isTelegramGroupChat(ctx: Context): boolean {
  const type = ctx.chat?.type;

  return type === "group" || type === "supergroup";
}

export function resolveChannelOrgKey(
  chatId: string,
  userId: number,
  isGroup: boolean
): string {
  return isGroup ? `g:${chatId}` : `u:${userId}`;
}

export function resolveConversationKey(
  ctx: Context,
  chatId: string,
  isGroup: boolean
): string {
  if (!isGroup) {
    return chatId;
  }

  const topicId = getTelegramTopicId(ctx);
  return topicId === undefined ? chatId : `g:${chatId}:t:${topicId}`;
}

export function isTelegramTopicMessage(ctx: Context): boolean {
  return getTelegramTopicId(ctx) !== undefined;
}

function getTelegramTopicId(ctx: Context): number | undefined {
  const value = (ctx.message as { message_thread_id?: unknown } | undefined)
    ?.message_thread_id;

  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function resolveBotInfo(
  ctx: Context,
  storedBotInfo?: TelegramBotInfo | undefined
): TelegramBotInfo | undefined {
  if (ctx.me?.id) {
    return { id: ctx.me.id, username: ctx.me.username };
  }

  if (storedBotInfo?.id) {
    return storedBotInfo;
  }
}

export function shouldHandleGroupMessage(
  ctx: Context,
  storedBotInfo?: TelegramBotInfo | undefined
): boolean {
  return explainGroupMessageHandling(ctx, storedBotInfo).shouldHandle;
}

export function explainGroupMessageHandling(
  ctx: Context,
  storedBotInfo?: TelegramBotInfo | undefined
): GroupMessageHandlingDecision {
  const text = (ctx.message?.text ?? ctx.message?.caption)?.trim() ?? "";
  const botInfo = resolveBotInfo(ctx, storedBotInfo);

  if (ctx.message?.text?.trim().startsWith("/")) {
    if (
      parseTelegramSlashCommand(text, {
        botUsername: botInfo?.username,
        requireBotTarget: true,
      }) === null
    ) {
      return { reason: "foreign-bot", shouldHandle: false };
    }

    return { reason: "slash-command", shouldHandle: true };
  }

  if (!botInfo) {
    return { reason: "missing-bot-info", shouldHandle: false };
  }

  if (isReplyToBot(ctx, botInfo.id)) {
    return { reason: "reply-to-bot", shouldHandle: true };
  }

  if (hasBotMention(ctx, botInfo)) {
    return { reason: "bot-mention", shouldHandle: true };
  }

  return {
    reason: text ? "no-trigger" : "no-text",
    shouldHandle: false,
  };
}

/**
 * First slash token. `/cmd@otherbot` is ignored when `requireBotTarget` is set
 * and the suffix is missing or not this bot's username. Private chats omit
 * `requireBotTarget` so `/start@AnyName` still works.
 */
export function parseTelegramSlashCommand(
  text: string,
  options?: { botUsername?: string; requireBotTarget?: boolean }
): string | null {
  const token = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const at = token.indexOf("@");
  if (at === -1) {
    return token;
  }

  const command = token.slice(0, at);
  if (!options?.requireBotTarget) {
    return command;
  }

  const username = options.botUsername?.trim().toLowerCase();
  const target = token.slice(at + 1);
  if (!username || target !== username) {
    return null;
  }

  return command;
}

export function stripBotMention(
  text: string,
  username: string | undefined
): string {
  if (!username?.trim()) {
    return text.trim();
  }

  const mention = `@${username.trim()}`;
  const pattern = new RegExp(
    mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "gi"
  );

  return text.replace(pattern, "").replace(/\s+/g, " ").trim();
}

function isReplyToBot(ctx: Context, botId: number): boolean {
  const from = ctx.message?.reply_to_message?.from;

  return from?.id === botId;
}

function hasBotMention(ctx: Context, botInfo: TelegramBotInfo): boolean {
  const entities = ctx.message?.text
    ? (ctx.message.entities ?? [])
    : (ctx.message?.caption_entities ?? []);
  const text = ctx.message?.text ?? ctx.message?.caption ?? "";
  const username = botInfo.username?.trim();

  if (username) {
    const mention = `@${username}`;
    const mentionPattern = new RegExp(
      `@${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\b|$)`,
      "i"
    );

    if (mentionPattern.test(text)) {
      return true;
    }

    for (const entity of entities) {
      if (entity.type === "mention") {
        const slice = text.slice(entity.offset, entity.offset + entity.length);

        if (slice.toLowerCase() === mention.toLowerCase()) {
          return true;
        }
      }
    }
  }

  for (const entity of entities) {
    if (entity.type === "text_mention" && entity.user?.id === botInfo.id) {
      return true;
    }
  }

  return false;
}
