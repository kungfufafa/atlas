import type {
  Message,
  MessageCreateOptions,
  TextBasedChannel,
} from "discord.js";
import { splitDiscordMessage } from "./format";

export interface DiscordMessenger {
  edit(messageId: string, text: string): Promise<void>;
  editComponents?(
    messageId: string,
    payload: DiscordComponentMessage
  ): Promise<void>;
  send(text: string): Promise<{ id: string } | null>;
  sendComponents?(payload: DiscordComponentMessage): Promise<{ id: string }>;
  sendTyping(): Promise<void>;
}

export interface DiscordComponentMessage {
  components: MessageCreateOptions["components"];
  content: string;
}

export function trackDiscordMessages(
  messenger: DiscordMessenger,
  onSent: (messageId: string) => void
): DiscordMessenger {
  return {
    ...messenger,
    async send(text) {
      const message = await messenger.send(text);
      if (message) {
        onSent(message.id);
      }
      return message;
    },
    sendComponents: messenger.sendComponents
      ? async (payload) => {
          const message = await messenger.sendComponents!(payload);
          onSent(message.id);
          return message;
        }
      : undefined,
  };
}

export function createDiscordMessenger(
  channel: TextBasedChannel
): DiscordMessenger {
  return {
    async edit(messageId: string, text: string) {
      const message = await channel.messages.fetch(messageId);
      await message.edit(text.slice(0, 2000));
    },
    async editComponents(messageId, payload) {
      const message = await channel.messages.fetch(messageId);
      await message.edit({ ...payload, allowedMentions: { parse: [] } });
    },
    async send(text: string) {
      const chunks = splitDiscordMessage(text);
      let last: { id: string } | null = null;

      for (const chunk of chunks) {
        // discord.js's TextBasedChannel union omits `send` on some members,
        // but every channel this messenger is used with supports it.
        const message = await (
          channel as { send: (content: string) => Promise<{ id: string }> }
        ).send(chunk);
        last = { id: message.id };
      }

      return last;
    },
    async sendComponents(payload) {
      return await (
        channel as {
          send: (options: MessageCreateOptions) => Promise<{ id: string }>;
        }
      ).send({
        ...payload,
        allowedMentions: { parse: [] },
      });
    },
    async sendTyping() {
      if ("sendTyping" in channel && typeof channel.sendTyping === "function") {
        await channel.sendTyping();
      }
    },
  };
}

export async function replyAsChat(
  messenger: DiscordMessenger,
  text: string
): Promise<void> {
  await messenger.send(text);
}

export function createInteractionMessenger(
  reply: (content: string) => Promise<unknown>,
  followUp: (content: string) => Promise<unknown>,
  editReply: (content: string) => Promise<unknown>,
  deferred: boolean
): DiscordMessenger {
  let answered = false;

  return {
    async edit(_messageId: string, text: string) {
      await editReply(text.slice(0, 2000));
    },
    async send(text: string) {
      const chunks = splitDiscordMessage(text);

      for (const chunk of chunks) {
        if (!answered) {
          if (deferred) {
            await editReply(chunk);
          } else {
            await reply(chunk);
          }
          answered = true;
          continue;
        }

        await followUp(chunk);
      }

      return { id: "interaction" };
    },
    async sendTyping() {},
  };
}

export function getMessageChannel(message: Message): TextBasedChannel {
  if (!message.channel.isTextBased()) {
    throw new Error("Unsupported channel type");
  }

  return message.channel;
}
