export interface ChannelSendResult {
  error?: string;
  ok: boolean;
}

export interface EmailOutboundAdapter {
  send(input: {
    to: string;
    subject: string;
    text: string;
    profileId?: string;
    orgId?: string | null;
  }): Promise<ChannelSendResult>;
}

export interface TelegramOutboundAdapter {
  send(input: {
    text: string;
    orgId?: string | null;
    chatIds?: number[];
    topicId?: number;
    parseMode?: "HTML";
  }): Promise<ChannelSendResult>;
}

export interface WhatsAppOutboundAdapter {
  send(input: {
    orgId?: string | null;
    text: string;
    /** Destination phone or JID. Omitting sends to the workspace paired chat. */
    to?: string;
  }): Promise<ChannelSendResult>;
}

export interface DiscordOutboundAdapter {
  send(input: { text: string; channelId?: string }): Promise<ChannelSendResult>;
}
