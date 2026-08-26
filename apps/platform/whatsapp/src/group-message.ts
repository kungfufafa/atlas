import { areJidsSameUser, isJidGroup } from "@whiskeysockets/baileys";

export interface WhatsAppAccount {
  id: string;
  lid?: string | null;
}

export type WhatsAppGroupMessageReason =
  | "slash-command"
  | "unsupported-command"
  | "missing-bot-info"
  | "reply-to-bot"
  | "bot-mention"
  | "no-text"
  | "no-trigger";

export interface GroupMessageHandlingDecision {
  reason: WhatsAppGroupMessageReason;
  shouldHandle: boolean;
}

const SUPPORTED_GROUP_COMMANDS = new Set([
  "/attach",
  "/clear",
  "/compact",
  "/help",
  "/new",
  "/org",
  "/start",
  "/status",
  "/stop",
]);

const WHATSAPP_MENTION_PATTERN = /@\S+/g;

export function isWhatsAppGroupChat(jid: string): boolean {
  return Boolean(isJidGroup(jid));
}

export function resolveWhatsAppChannelOrgKey(
  jid: string,
  isGroup: boolean
): string {
  return isGroup ? `g:${jid}` : jid;
}

export function isWhatsAppBotAddress(
  jid: string | null | undefined,
  me: WhatsAppAccount | undefined
): boolean {
  if (!(jid && me?.id)) {
    return false;
  }

  if (areJidsSameUser(jid, me.id)) {
    return true;
  }

  return Boolean(me.lid && areJidsSameUser(jid, me.lid));
}

export function parseSupportedWhatsAppGroupCommand(
  text: string
): string | null {
  const command = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return SUPPORTED_GROUP_COMMANDS.has(command) ? command : null;
}

export function explainWhatsAppGroupMessageHandling(input: {
  mentionedJids: string[];
  quotedParticipant: string | null;
  text: string;
  me?: WhatsAppAccount;
}): GroupMessageHandlingDecision {
  const text = input.text.trim();
  const startsWithSlash = text.startsWith("/");

  if (startsWithSlash && parseSupportedWhatsAppGroupCommand(text)) {
    return { reason: "slash-command", shouldHandle: true };
  }

  if (!input.me) {
    return {
      reason: startsWithSlash ? "unsupported-command" : "missing-bot-info",
      shouldHandle: false,
    };
  }

  if (isWhatsAppBotAddress(input.quotedParticipant, input.me)) {
    return { reason: "reply-to-bot", shouldHandle: true };
  }

  if (input.mentionedJids.some((jid) => isWhatsAppBotAddress(jid, input.me))) {
    return { reason: "bot-mention", shouldHandle: true };
  }

  if (startsWithSlash) {
    return { reason: "unsupported-command", shouldHandle: false };
  }

  return {
    reason: text ? "no-trigger" : "no-text",
    shouldHandle: false,
  };
}

/**
 * WhatsApp exposes mention JIDs in the same order as textual mention tokens.
 * Remove only tokens whose corresponding JID is the connected account so
 * mentions of other group members remain intact.
 */
export function stripWhatsAppBotMention(input: {
  me?: WhatsAppAccount;
  mentionedJids: string[];
  text: string;
}): string {
  let mentionIndex = 0;
  const stripped = input.text.replace(WHATSAPP_MENTION_PATTERN, (token) => {
    const mentionedJid = input.mentionedJids[mentionIndex];
    mentionIndex += 1;
    return isWhatsAppBotAddress(mentionedJid, input.me) ? "" : token;
  });

  return stripped.replace(/\s+/g, " ").trim();
}
