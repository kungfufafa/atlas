import type { SendMessageInput } from "@atlas/core/contract";
import {
  isSupportedDocumentMediaType,
  isSupportedImageMediaType,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  normalizeDocumentMediaType,
  SUPPORTED_DOCUMENT_TYPE_LABEL,
  validateDocumentAttachments,
  validateImageAttachments,
} from "@atlas/core/message-content";
import {
  downloadMediaMessage,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { inspectInboundWhatsAppMedia } from "./inbound-message";

export const UNSUPPORTED_DOCUMENT_TYPES_REPLY = `Unsupported file type. Send ${SUPPORTED_DOCUMENT_TYPE_LABEL} (max 5 MB).`;

export const OVERSIZED_FILE_REPLY = "File is too large. Maximum size is 5 MB.";

export const UNSUPPORTED_MEDIA_REPLY = `Send text, a photo, a voice note, or a supported document (${SUPPORTED_DOCUMENT_TYPE_LABEL} — max 5 MB).`;

export const DOWNLOAD_FAILED_REPLY = "Could not download that file. Try again.";

export const PAIRING_MEDIA_REPLY =
  "Send the chat access code as text to authorize this chat.";

export type WhatsAppMediaDownload = (message: WAMessage) => Promise<Buffer>;

export type WhatsAppMediaBuildResult =
  | { kind: "input"; input: SendMessageInput }
  | { kind: "reject"; message: string }
  | null;

export async function buildWhatsAppMediaInput(
  inbound: WAMessage,
  download: WhatsAppMediaDownload
): Promise<WhatsAppMediaBuildResult> {
  const media = inspectInboundWhatsAppMedia(inbound.message);
  if (!media || media.kind === "unsupported" || media.kind === "audio") {
    return null;
  }

  const maxBytes =
    media.kind === "image" ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;

  if (media.fileLength !== null && media.fileLength > maxBytes) {
    return { kind: "reject", message: OVERSIZED_FILE_REPLY };
  }

  if (media.kind === "image") {
    const mediaType = inferImageMediaType(media.mimetype, media.filename);
    if (!isSupportedImageMediaType(mediaType)) {
      return { kind: "reject", message: UNSUPPORTED_MEDIA_REPLY };
    }
  } else if (!isSupportedDocumentMediaType(media.mimetype, media.filename)) {
    return { kind: "reject", message: UNSUPPORTED_DOCUMENT_TYPES_REPLY };
  }

  let bytes: Buffer;

  try {
    bytes = await download(inbound);
  } catch {
    return { kind: "reject", message: DOWNLOAD_FAILED_REPLY };
  }

  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
    return { kind: "reject", message: DOWNLOAD_FAILED_REPLY };
  }

  if (bytes.byteLength > maxBytes) {
    return { kind: "reject", message: OVERSIZED_FILE_REPLY };
  }

  const data = bytes.toString("base64");
  const caption = media.caption;

  if (media.kind === "image") {
    const mediaType = inferImageMediaType(media.mimetype, media.filename);
    const images = [{ data, mediaType }];

    try {
      validateImageAttachments(images);
    } catch {
      return { kind: "reject", message: UNSUPPORTED_MEDIA_REPLY };
    }

    return { input: { images, message: caption }, kind: "input" };
  }

  const mediaType = normalizeDocumentMediaType(media.mimetype, media.filename);
  const documents = [{ data, filename: media.filename, mediaType }];

  try {
    validateDocumentAttachments(documents);
  } catch {
    return { kind: "reject", message: UNSUPPORTED_DOCUMENT_TYPES_REPLY };
  }

  return { input: { documents, message: caption }, kind: "input" };
}

export async function downloadWhatsAppMedia(
  inbound: WAMessage,
  socket: WASocket | null
): Promise<Buffer> {
  if (!socket) {
    throw new Error("WhatsApp is not connected.");
  }

  const buffer = await downloadMediaMessage(
    inbound,
    "buffer",
    {},
    {
      logger: createSilentBaileysLogger(),
      reuploadRequest: (message) => socket.updateMediaMessage(message),
    }
  );

  if (!Buffer.isBuffer(buffer)) {
    throw new Error("Could not download that file.");
  }

  return buffer;
}

function inferImageMediaType(mimetype: string, filename: string): string {
  const trimmed = mimetype.split(";")[0]?.trim().toLowerCase() ?? "";

  if (trimmed === "image/jpg") {
    return "image/jpeg";
  }

  if (isSupportedImageMediaType(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("image/")) {
    return trimmed;
  }

  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();

  switch (extension) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return trimmed || "application/octet-stream";
  }
}

function createSilentBaileysLogger() {
  const logger = {
    child: () => logger,
    debug: () => {},
    error: () => {},
    info: () => {},
    level: "silent",
    trace: () => {},
    warn: () => {},
  };

  return logger;
}
