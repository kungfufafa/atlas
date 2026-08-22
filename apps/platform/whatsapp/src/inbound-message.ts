import {
  areJidsSameUser,
  extractMessageContent,
  isJidGroup,
  isJidUser,
  isLidUser,
  type proto,
} from "@whiskeysockets/baileys";

export function isPrivateWhatsAppChat(jid: string): boolean {
  return Boolean(isJidUser(jid) || isLidUser(jid));
}

export function isSelfWhatsAppChat(
  remoteJid: string,
  me: { id: string; lid?: string | null } | undefined
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
    const kind = mimetype.toLowerCase().startsWith("image/")
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

  if (content.videoMessage || content.stickerMessage) {
    return {
      caption: content.videoMessage?.caption?.trim() || "",
      fileLength: null,
      filename: "",
      kind: "unsupported",
      mimetype: "",
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

export function shouldHandleInboundMessage(
  msg: {
    key: { fromMe?: boolean | null; remoteJid?: string | null };
    message?: proto.IMessage | null;
  },
  me: { id: string; lid?: string | null } | undefined
): boolean {
  const remoteJid = msg.key.remoteJid;

  if (
    !remoteJid ||
    isJidGroup(remoteJid) ||
    !isPrivateWhatsAppChat(remoteJid)
  ) {
    return false;
  }

  if (msg.key.fromMe && !isSelfWhatsAppChat(remoteJid, me)) {
    return false;
  }

  return Boolean(
    extractInboundText(msg.message) || inspectInboundWhatsAppMedia(msg.message)
  );
}
