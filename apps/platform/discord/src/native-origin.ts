import type { TextBasedChannel } from "discord.js";

/** Preserve the admitted turn's trigger state, including unmentioned files. */
export async function resolveDiscordNativeOrigin(
  channel: TextBasedChannel,
  channelAddressed = true
): Promise<{
  channelAddressed: boolean;
  channelChatId: string;
  channelIsGroup: boolean;
  channelThreadId?: string;
}> {
  let parentId = channel.isThread() ? channel.parentId : null;
  if (channel.isThread() && !parentId) {
    const full = await channel.fetch();
    parentId = full?.isThread() ? full.parentId : null;
    if (!parentId) {
      throw new Error("Discord thread parent context is unavailable");
    }
  }
  return {
    channelAddressed,
    channelChatId: parentId ?? channel.id,
    channelIsGroup: !channel.isDMBased(),
    channelThreadId: channel.isThread() ? channel.id : undefined,
  };
}
