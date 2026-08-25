import type { ChannelType } from "../contract";
import { applyRedactionBoundary } from "../redaction-boundary";

export interface TelegramReplyTarget {
  chatId: number;
  topicId?: number;
}

export interface WhatsAppReplyTarget {
  to: string;
}

export interface DiscordReplyTarget {
  channelId?: string;
  userId?: string;
}

export interface EmailReplyTarget {
  to: string;
}

export type ChannelReplyTarget =
  | { channel: "telegram"; telegram: TelegramReplyTarget }
  | { channel: "whatsapp"; whatsapp: WhatsAppReplyTarget }
  | { channel: "discord"; discord: DiscordReplyTarget }
  | { channel: "email"; email: EmailReplyTarget };

export interface OutboundEnvelope {
  orgId: string;
  replyTarget: ChannelReplyTarget;
  text: string;
}

export class OutboundEnvelopeError extends Error {
  readonly code = "OUTBOUND_ENVELOPE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "OutboundEnvelopeError";
  }
}

export function assertOutboundEnvelope(
  value: Partial<OutboundEnvelope> | null | undefined
): OutboundEnvelope {
  const orgId = value?.orgId?.trim();
  if (!orgId) {
    throw new OutboundEnvelopeError("Outbound envelope orgId is required.");
  }

  const replyTarget = value?.replyTarget;
  if (!replyTarget) {
    throw new OutboundEnvelopeError(
      "Outbound envelope replyTarget is required."
    );
  }

  assertReplyTarget(replyTarget);

  const text = value?.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new OutboundEnvelopeError("Outbound envelope text is required.");
  }

  return {
    orgId,
    replyTarget,
    text: applyRedactionBoundary(text, "outbound"),
  };
}

function assertReplyTarget(target: ChannelReplyTarget): void {
  if (target.channel === "telegram") {
    if (
      !Number.isInteger(target.telegram.chatId) ||
      target.telegram.chatId === 0
    ) {
      throw new OutboundEnvelopeError(
        "Telegram replyTarget.chatId is required."
      );
    }
    return;
  }

  if (target.channel === "whatsapp") {
    if (!target.whatsapp.to.trim()) {
      throw new OutboundEnvelopeError("WhatsApp replyTarget.to is required.");
    }
    return;
  }

  if (target.channel === "discord") {
    const channelId = target.discord.channelId?.trim();
    const userId = target.discord.userId?.trim();
    if (!(channelId || userId)) {
      throw new OutboundEnvelopeError(
        "Discord replyTarget requires channelId or userId."
      );
    }
    return;
  }

  if (target.channel === "email" && !target.email.to.trim()) {
    throw new OutboundEnvelopeError("Email replyTarget.to is required.");
  }
}

export interface ChannelAllowlist {
  accessMode?: "pairing" | "open" | "allowlist" | "denylist";
  allowedUserIds?: Array<string | number>;
  blockedUserIds?: Array<string | number>;
  pairedJid?: string | null;
  pairedUserIds?: Array<string | number>;
}

export function revalidateOutboundAllowlist(
  envelope: OutboundEnvelope,
  allowlist: ChannelAllowlist
): void {
  const target = envelope.replyTarget;
  const blocked = new Set(
    (allowlist.blockedUserIds ?? []).map((id) => String(id))
  );
  const paired = new Set(
    (allowlist.pairedUserIds ?? []).map((id) => String(id))
  );
  const allowed = new Set(
    (allowlist.allowedUserIds ?? []).map((id) => String(id))
  );
  const mode = allowlist.accessMode ?? "pairing";

  const assertId = (id: string, channel: ChannelType): void => {
    if (blocked.has(id)) {
      throw new OutboundEnvelopeError(
        `${channel} replyTarget is blocked by the workspace denylist.`
      );
    }

    if (mode === "open") {
      return;
    }

    if (mode === "denylist") {
      return;
    }

    if (mode === "allowlist") {
      if (!allowed.has(id)) {
        throw new OutboundEnvelopeError(
          `${channel} replyTarget is not on the workspace allowlist.`
        );
      }
      return;
    }

    if (!(paired.has(id) || allowed.has(id))) {
      throw new OutboundEnvelopeError(
        `${channel} replyTarget is not paired for this workspace.`
      );
    }
  };

  if (target.channel === "telegram") {
    assertId(String(target.telegram.chatId), "telegram");
    return;
  }

  if (target.channel === "discord") {
    const id =
      target.discord.userId?.trim() || target.discord.channelId?.trim();
    if (!id) {
      throw new OutboundEnvelopeError("Discord replyTarget is empty.");
    }
    if (target.discord.userId?.trim()) {
      assertId(target.discord.userId.trim(), "discord");
    }
    return;
  }

  if (target.channel === "whatsapp") {
    const to = target.whatsapp.to.trim();
    const pairedJid = allowlist.pairedJid?.trim();
    if (pairedJid && to !== pairedJid && !paired.has(to) && !allowed.has(to)) {
      throw new OutboundEnvelopeError(
        "WhatsApp replyTarget is not paired for this workspace."
      );
    }
  }
}
