import { inspect } from "node:util";
import { Bot, type Context } from "grammy";
import { type ChatHandlerDeps, createChatHandler } from "./chat-handler";
import type { TelegramBridgeConfig } from "./config";
import type { TelegramBotInfo } from "./group-message";

/** grammY errors can contain the token-bearing Bot API request URL. */
export function redactBotToken(text: string, botToken: string): string {
  return botToken ? text.replaceAll(botToken, "<redacted>") : text;
}

export function dispatchTelegramUpdate(
  handler: (ctx: Context) => Promise<void>,
  ctx: Context,
  onError: (error: unknown) => void
): void {
  void handler(ctx).catch(onError);
}

export async function createBot(
  config: TelegramBridgeConfig,
  deps: Omit<ChatHandlerDeps, "config" | "getBotInfo"> & {
    getBotInfo?: () => TelegramBotInfo | undefined;
  }
): Promise<Bot> {
  const bot = new Bot(config.botToken);
  await bot.init();

  const initializedBotInfo: TelegramBotInfo = {
    id: bot.botInfo.id,
    username: bot.botInfo.username,
  };

  const handleMessage = createChatHandler({
    ...deps,
    config,
    getBotInfo: () => deps.getBotInfo?.() ?? initializedBotInfo,
  });

  const reportError = (error: unknown): void => {
    console.error(
      "Telegram bot error:",
      redactBotToken(inspect(error), config.botToken)
    );
  };

  // grammY's default long-polling loop awaits middleware for each update.
  // Detach message work here; per-conversation locks in the handler retain
  // ordering while unrelated chats can download and run concurrently.
  registerTelegramBotHandlers(bot, handleMessage, reportError);

  bot.catch(reportError);

  return bot;
}

export function registerTelegramBotHandlers(
  bot: Bot,
  handler: ReturnType<typeof createChatHandler>,
  onError: (error: unknown) => void
): void {
  bot.on("message", (ctx) => {
    dispatchTelegramUpdate(handler, ctx, onError);
  });
  bot.on("callback_query:data", (ctx) => {
    dispatchTelegramUpdate(handler.handleCallback, ctx, onError);
  });
}
