import { normalizeWhatsAppUserJid } from "@atlas/core/whatsapp-config";
import {
  areJidsSameUser,
  extractMessageContent,
  isJidGroup,
  isJidUser,
  isLidUser,
  type proto,
} from "@whiskeysockets/baileys";
import {
  explainWhatsAppGroupMessageHandling,
  type WhatsAppAccount,
} from "./group-message";

const IMAGE_FILENAME_PATTERN = /\.(?:jpe?g|png|webp|gif)$/i;

interface WhatsAppInboundKey {
  fromMe?: boolean | null;
  participant?: string | null;
  participantLid?: string | null;
  participantPn?: string | null;
  remoteJid?: string | null;
  senderLid?: string | null;
  senderPn?: string | null;
}

export interface WhatsAppInboundChat {
  fromMe: boolean;
  isGroup: boolean;
  jid: string;
  me?: WhatsAppAccount;
  mentionedJids: string[];
  quotedMessageId?: string | null;
  quotedParticipant: string | null;
  quotedText: string | null;
  senderJid: string;
  senderJids: string[];
  senderPn: string | null;
  text: string;
}

export function isPrivateWhatsAppChat(jid: string): boolean {
  return Boolean(isJidUser(jid) || isLidUser(jid));
}

export function isSelfWhatsAppChat(
  remoteJid: string,
  me: WhatsAppAccount | undefined
): boolean {
  if (!me) {
    return false;
  }

  if (areJidsSameUser(remoteJid, me.id)) {
    return true;
  }

  return Boolean(me.lid && areJidsSameUser(remoteJid, me.lid));
}

export type InboundWhatsAppMediaKind =
  | "image"
  | "document"
  | "audio"
  | "video"
  | "sticker"
  | "unsupported";

export interface InboundWhatsAppMediaMeta {
  caption: string;
  fileLength: number | null;
  filename: string;
  kind: InboundWhatsAppMediaKind;
  mimetype: string;
}

export function unwrapInboundWhatsAppMessage(
  message: proto.IMessage | null | undefined
): Partial<proto.IMessage> | null {
  if (!message) {
    return null;
  }

  const extracted = extractMessageContent(message) ?? message;
  return materializeMessage(extracted) ?? extracted;
}

export function extractInboundText(
  message: proto.IMessage | null | undefined
): string {
  return readTextContent(unwrapInboundWhatsAppMessage(message));
}

export function inspectInboundWhatsAppMedia(
  message: proto.IMessage | null | undefined
): InboundWhatsAppMediaMeta | null {
  const content = unwrapInboundWhatsAppMessage(message);
  if (!content) {
    return null;
  }

  if (content.imageMessage) {
    return {
      caption: content.imageMessage.caption?.trim() ?? "",
      fileLength: asFiniteByteLength(content.imageMessage.fileLength),
      filename: inferImageFilename(content.imageMessage.mimetype),
      kind: "image",
      mimetype: content.imageMessage.mimetype?.trim() || "image/jpeg",
    };
  }

  if (content.documentMessage) {
    const mimetype = content.documentMessage.mimetype?.trim() || "";
    const filename =
      content.documentMessage.fileName?.trim() ||
      content.documentMessage.title?.trim() ||
      "document";
    const caption = content.documentMessage.caption?.trim() ?? "";
    const fileLength = asFiniteByteLength(content.documentMessage.fileLength);
    const normalizedMimetype = mimetype.toLowerCase().split(";")[0]?.trim();
    const kind =
      normalizedMimetype?.startsWith("image/") ||
      ((!normalizedMimetype ||
        normalizedMimetype === "application/octet-stream") &&
        IMAGE_FILENAME_PATTERN.test(filename))
        ? "image"
        : "document";

    return { caption, fileLength, filename, kind, mimetype };
  }

  if (content.audioMessage) {
    const isVoice = Boolean(content.audioMessage.ptt);
    return {
      caption: "",
      fileLength: asFiniteByteLength(content.audioMessage.fileLength),
      filename: isVoice ? "voice.ogg" : "audio.ogg",
      kind: "audio",
      mimetype:
        content.audioMessage.mimetype?.trim() ||
        (isVoice ? "audio/ogg" : "audio/mpeg"),
    };
  }

  if (content.videoMessage) {
    return {
      caption: content.videoMessage?.caption?.trim() || "",
      fileLength: asFiniteByteLength(content.videoMessage.fileLength),
      filename: "video.mp4",
      kind: "video",
      mimetype: content.videoMessage.mimetype?.trim() || "video/mp4",
    };
  }

  if (content.stickerMessage) {
    return {
      caption: "",
      fileLength: asFiniteByteLength(content.stickerMessage.fileLength),
      filename: "sticker.webp",
      kind: "sticker",
      mimetype: content.stickerMessage.mimetype?.trim() || "image/webp",
    };
  }

  return null;
}

function readTextContent(
  message: Partial<proto.IMessage> | null | undefined
): string {
  return (
    message?.conversation ??
    message?.extendedTextMessage?.text ??
    message?.imageMessage?.caption ??
    message?.videoMessage?.caption ??
    message?.documentMessage?.caption ??
    ""
  ).trim();
}

function inferImageFilename(mimetype: string | null | undefined): string {
  const subtype = mimetype?.split("/")[1]?.split(";")[0]?.trim().toLowerCase();

  if (subtype === "png") {
    return "image.png";
  }

  if (subtype === "gif") {
    return "image.gif";
  }

  if (subtype === "webp") {
    return "image.webp";
  }

  return "image.jpg";
}

function asFiniteByteLength(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (
    value &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof value.toNumber === "function"
  ) {
    const parsed = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function materializeMessage(
  message: Partial<proto.IMessage> | null | undefined
): Partial<proto.IMessage> | null {
  if (!message) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(message)) as Partial<proto.IMessage>;
  } catch {
    return null;
  }
}

export function extractInboundPhoneHint(msg: {
  key: {
    participantPn?: string | null;
    senderPn?: string | null;
  };
}): string | null {
  const senderPn = msg.key.senderPn?.trim();
  if (senderPn) {
    return senderPn;
  }

  const participantPn = msg.key.participantPn?.trim();
  return participantPn || null;
}

function extractContextInfo(
  message: proto.IMessage | null | undefined
): proto.IContextInfo | undefined {
  const content = unwrapInboundWhatsAppMessage(message);
  if (!content) {
    return;
  }

  return (
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.documentMessage?.contextInfo ??
    content.audioMessage?.contextInfo ??
    undefined
  );
}

function extractMentionedJids(
  message: proto.IMessage | null | undefined
): string[] {
  const mentionedJids = extractContextInfo(message)?.mentionedJid ?? [];
  return mentionedJids
    .filter((jid): jid is string => Boolean(jid?.trim()))
    .map((jid) => normalizeWhatsAppUserJid(jid));
}

function quotedContextBelongsToChat(
  context: proto.IContextInfo | undefined,
  remoteJid: string
): boolean {
  const quotedRemoteJid = context?.remoteJid?.trim();
  if (!quotedRemoteJid) {
    return true;
  }

  return (
    normalizeWhatsAppUserJid(quotedRemoteJid) ===
    normalizeWhatsAppUserJid(remoteJid)
  );
}

function collectSenderJids(
  key: WhatsAppInboundKey,
  remoteJid: string,
  isGroup: boolean,
  me: WhatsAppAccount | undefined
): string[] {
  const candidates = isGroup
    ? [
        key.participantPn,
        key.senderPn,
        key.participant,
        key.participantLid,
        key.senderLid,
        key.fromMe ? me?.id : null,
        key.fromMe ? me?.lid : null,
      ]
    : [
        remoteJid,
        key.senderPn,
        key.senderLid,
        key.participant,
        key.participantPn,
        key.participantLid,
      ];
  const result: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const jid = candidate?.trim();
    if (!(jid && isPrivateWhatsAppChat(jid))) {
      continue;
    }

    const normalized = normalizeWhatsAppUserJid(jid);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

export function parseInboundWhatsAppMessage(
  msg: {
    key: WhatsAppInboundKey;
    message?: proto.IMessage | null;
  },
  me: WhatsAppAccount | undefined,
  options?: { allowUnaddressedGroup?: boolean }
): WhatsAppInboundChat | null {
  const remoteJid = msg.key.remoteJid?.trim();
  if (!remoteJid) {
    return null;
  }

  const text = extractInboundText(msg.message);
  const media = inspectInboundWhatsAppMedia(msg.message);
  if (!(text || media)) {
    return null;
  }

  const normalizedRemoteJid = normalizeWhatsAppUserJid(remoteJid);
  const isGroup = Boolean(isJidGroup(normalizedRemoteJid));
  const fromMe = Boolean(msg.key.fromMe);
  const context = extractContextInfo(msg.message);
  const contextIsLocal = quotedContextBelongsToChat(
    context,
    normalizedRemoteJid
  );
  const mentionedJids = extractMentionedJids(msg.message);
  const quotedParticipant =
    contextIsLocal && context?.participant?.trim()
      ? normalizeWhatsAppUserJid(context.participant)
      : null;
  const quotedText = contextIsLocal
    ? extractInboundText(context?.quotedMessage).trim() || null
    : null;

  if (isGroup) {
    // A group reply sent by Atlas can be echoed back by linked-device sync.
    // Never let that outbound content re-enter command handling.
    if (fromMe) {
      return null;
    }
    const decision = explainWhatsAppGroupMessageHandling({
      me,
      mentionedJids,
      quotedParticipant,
      text,
    });
    // Media must reach authorization before the handler can explain a mention
    // requirement. Dropping it here makes an uploaded file disappear silently.
    if (!(decision.shouldHandle || options?.allowUnaddressedGroup || media)) {
      return null;
    }
  } else if (!isPrivateWhatsAppChat(normalizedRemoteJid)) {
    return null;
  } else if (fromMe && !isSelfWhatsAppChat(normalizedRemoteJid, me)) {
    return null;
  }

  const senderJids = collectSenderJids(
    msg.key,
    normalizedRemoteJid,
    isGroup,
    me
  );
  const senderJid = senderJids[0] ?? "";
  if (isGroup && !senderJid) {
    return null;
  }

  return {
    fromMe,
    isGroup,
    jid: normalizedRemoteJid,
    me,
    mentionedJids,
    quotedMessageId: contextIsLocal ? context?.stanzaId?.trim() || null : null,
    quotedParticipant,
    quotedText,
    senderJid,
    senderJids,
    senderPn: extractInboundPhoneHint(msg),
    text,
  };
}

export function shouldHandleInboundMessage(
  msg: {
    key: WhatsAppInboundKey;
    message?: proto.IMessage | null;
  },
  me: WhatsAppAccount | undefined
): boolean {
  return parseInboundWhatsAppMessage(msg, me) !== null;
}
