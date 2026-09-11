import type { WAMessage } from "@whiskeysockets/baileys";

const MAX_METADATA_BYTES = 256 * 1024;

interface DeferredGroupMediaScope {
  jid: string;
  orgId: string;
  senderJid: string;
}

interface DeferredGroupMedia extends DeferredGroupMediaScope {
  expiresAt: number;
  inbound: WAMessage;
  messageIds: Set<string>;
}

/** Private, bounded metadata only. Download and file authorization happen on reply. */
export class DeferredWhatsAppGroupMedia {
  private readonly entries: DeferredGroupMedia[] = [];

  constructor(
    private readonly options = { maxEntries: 100, ttlMs: 15 * 60 * 1000 },
    private readonly now = Date.now
  ) {}

  remember(scope: DeferredGroupMediaScope, inbound: WAMessage): boolean {
    this.prune();
    const messageId = inbound.key.id?.trim();
    if (
      !(messageId && inbound.message) ||
      inbound.key.remoteJid !== scope.jid
    ) {
      return false;
    }
    try {
      if (
        Buffer.byteLength(JSON.stringify(inbound), "utf8") > MAX_METADATA_BYTES
      ) {
        return false;
      }
    } catch {
      return false;
    }
    this.entries.push({
      ...scope,
      expiresAt: this.now() + this.options.ttlMs,
      inbound,
      messageIds: new Set([messageId]),
    });
    while (this.entries.length > this.options.maxEntries) {
      this.entries.shift();
    }
    return true;
  }

  bindWarning(
    scope: DeferredGroupMediaScope,
    originalId: string,
    warningId: string
  ): void {
    const entry = this.find(scope, originalId);
    entry?.messageIds.add(warningId);
  }

  get(
    scope: DeferredGroupMediaScope,
    quotedMessageId: string | null | undefined
  ): WAMessage | undefined {
    return quotedMessageId
      ? this.find(scope, quotedMessageId)?.inbound
      : undefined;
  }

  private find(
    scope: DeferredGroupMediaScope,
    messageId: string
  ): DeferredGroupMedia | undefined {
    this.prune();
    return this.entries.find(
      (entry) =>
        entry.jid === scope.jid &&
        entry.orgId === scope.orgId &&
        entry.senderJid === scope.senderJid &&
        entry.messageIds.has(messageId)
    );
  }

  private prune(): void {
    const now = this.now();
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (this.entries[index]!.expiresAt <= now) {
        this.entries.splice(index, 1);
      }
    }
  }
}
