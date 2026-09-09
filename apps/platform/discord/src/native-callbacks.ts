import { randomBytes } from "node:crypto";

export interface DiscordCallbackBinding {
  channelAddressed: boolean;
  channelChatId: string;
  channelId: string;
  channelOrgKey: string;
  channelThreadId?: string;
  channelUserId: string;
  conversationKey: string;
  guildId: string | null;
  orgId: string;
  profileId: string;
  sessionId: string;
}

export interface DiscordCallbackOrigin {
  channelId: string;
  channelUserId: string;
  guildId: string | null;
  messageId: string | null;
}

interface CallbackEntry<T> {
  binding: DiscordCallbackBinding;
  expiresAt: number;
  messageId: string | null;
  value: T;
}

export interface DiscordCallbackTicket {
  bindMessage(messageId: string): void;
  customId: string;
  revoke(): void;
}

/** Opaque, process-local tickets fail closed after restart, expiry, or first use. */
export class DiscordCallbackRegistry<T> {
  private readonly entries = new Map<string, CallbackEntry<T>>();

  constructor(
    private readonly options: {
      capacity?: number;
      now?: () => number;
      ttlMs?: number;
    } = {}
  ) {}

  issue(binding: DiscordCallbackBinding, value: T): DiscordCallbackTicket {
    this.prune();
    if (
      Object.values(binding).some(
        (item) => typeof item === "string" && !item.trim()
      ) ||
      this.entries.size >= (this.options.capacity ?? 1000)
    ) {
      throw new Error("Discord callback cannot be registered");
    }
    const customId = `atlas:${randomBytes(24).toString("base64url")}`;
    const entry: CallbackEntry<T> = {
      binding: { ...binding },
      expiresAt: this.now() + (this.options.ttlMs ?? 15 * 60 * 1000),
      messageId: null,
      value,
    };
    this.entries.set(customId, entry);
    return {
      bindMessage: (messageId) => {
        if (
          !messageId.trim() ||
          entry.messageId !== null ||
          this.entries.get(customId) !== entry
        ) {
          throw new Error("Discord callback message binding is invalid");
        }
        entry.messageId = messageId;
      },
      customId,
      revoke: () => this.entries.delete(customId),
    };
  }

  /** Claim synchronously before awaiting authorization, preventing concurrent replay. */
  claim(
    customId: string,
    origin: DiscordCallbackOrigin
  ): { binding: DiscordCallbackBinding; messageId: string; value: T } | null {
    this.prune();
    const entry = this.entries.get(customId);
    if (
      !entry?.messageId ||
      entry.messageId !== origin.messageId ||
      entry.binding.channelId !== origin.channelId ||
      entry.binding.channelUserId !== origin.channelUserId ||
      entry.binding.guildId !== origin.guildId
    ) {
      return null;
    }
    this.entries.delete(customId);
    return {
      binding: { ...entry.binding },
      messageId: entry.messageId,
      value: entry.value,
    };
  }

  revokeSession(sessionId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.binding.sessionId === sessionId) {
        this.entries.delete(id);
      }
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
      }
    }
  }
}
