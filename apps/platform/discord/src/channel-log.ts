/** Optional verbose channel logging for local diagnostics. */
export function isChannelDebugEnabled(): boolean {
  return process.env.ATLAS_CH_DEBUG === "1";
}

/** Default Discord inbound log line contains no user, channel, or message text. */
export function formatDiscordInboundMessageLog(message: {
  author: { id: string };
  channelId: string;
  content?: string | null;
  id: string;
}): string {
  return [
    "[discord] message",
    `messageId=${message.id}`,
    ...(isChannelDebugEnabled()
      ? [`authorId=${message.author.id}`, `channelId=${message.channelId}`]
      : []),
    `textBytes=${Buffer.byteLength(message.content ?? "", "utf8")}`,
  ].join(" ");
}
