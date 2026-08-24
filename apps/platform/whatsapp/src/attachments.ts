import type { SendMessageInput } from "@atlas/core/contract";
import {
  extractInboundDocumentText,
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

export const WHATSAPP_DOCUMENT_INGEST_MAX_BYTES = 25 * 1024 * 1024;
export const WHATSAPP_IMAGE_MAX_BYTES = MAX_IMAGE_BYTES;
export const WHATSAPP_DOCUMENT_INLINE_MAX_BYTES = MAX_DOCUMENT_BYTES;

export const UNSUPPORTED_DOCUMENT_TYPES_REPLY = `Unsupported file type. Send ${SUPPORTED_DOCUMENT_TYPE_LABEL} (max 25 MB).`;

export const OVERSIZED_FILE_REPLY =
  "That file is too large to process here (max 25 MB). Send a smaller file, or a link.";

export const OVERSIZED_IMAGE_REPLY =
  "That photo is too large (max 5 MB). Send a compressed photo, or attach it as a document.";

export const UNREADABLE_DOCUMENT_REPLY =
  "Could not read text from that file. Try a text-based PDF, Word, or Excel file. Scanned/image-only PDFs are not supported.";

export const UNSUPPORTED_MEDIA_REPLY = `Send text, a photo (max 5 MB), a voice note, or a supported document (${SUPPORTED_DOCUMENT_TYPE_LABEL} — max 25 MB).`;

export const DOWNLOAD_FAILED_REPLY = "Could not download that file. Try again.";

export const PAIRING_MEDIA_REPLY =
  "Send the chat access code as text to authorize this chat.";

export type WhatsAppMediaDownload = (message: WAMessage) => Promise<Buffer>;

export type WhatsAppMediaBuildResult =
  | { kind: "input"; input: SendMessageInput }
  | { kind: "reject"; message: string }
  | null;

export interface WhatsAppMediaInputOptions {
  extractDocumentText?: typeof extractInboundDocumentText;
  imageMaxBytes?: number;
  ingestMaxBytes?: number;
  inlineMaxBytes?: number;
}

export function resolveWhatsAppDocumentHandling(
  byteLength: number,
  limits: { ingestMaxBytes: number; inlineMaxBytes: number }
): "inline" | "extract" | "reject" {
  if (byteLength > limits.ingestMaxBytes) {
    return "reject";
  }

  if (byteLength > limits.inlineMaxBytes) {
    return "extract";
  }

  return "inline";
}

export async function buildWhatsAppMediaInput(
  inbound: WAMessage,
  download: WhatsAppMediaDownload,
  options: WhatsAppMediaInputOptions = {}
): Promise<WhatsAppMediaBuildResult> {
  const media = inspectInboundWhatsAppMedia(inbound.message);
  if (!media || media.kind === "unsupported" || media.kind === "audio") {
    return null;
  }

  const imageMaxBytes = options.imageMaxBytes ?? WHATSAPP_IMAGE_MAX_BYTES;
  const inlineMaxBytes =
    options.inlineMaxBytes ?? WHATSAPP_DOCUMENT_INLINE_MAX_BYTES;
  const ingestMaxBytes =
    options.ingestMaxBytes ?? WHATSAPP_DOCUMENT_INGEST_MAX_BYTES;
  const extractDocumentText =
    options.extractDocumentText ?? extractInboundDocumentText;

  if (media.kind === "image") {
    const mediaType = inferImageMediaType(media.mimetype, media.filename);
    if (!isSupportedImageMediaType(mediaType)) {
      return { kind: "reject", message: UNSUPPORTED_MEDIA_REPLY };
    }

    if (media.fileLength !== null && media.fileLength > imageMaxBytes) {
      return { kind: "reject", message: OVERSIZED_IMAGE_REPLY };
    }
  } else if (!isSupportedDocumentMediaType(media.mimetype, media.filename)) {
    return { kind: "reject", message: UNSUPPORTED_DOCUMENT_TYPES_REPLY };
  } else if (
    media.fileLength !== null &&
    resolveWhatsAppDocumentHandling(media.fileLength, {
      ingestMaxBytes,
      inlineMaxBytes,
    }) === "reject"
  ) {
    return { kind: "reject", message: OVERSIZED_FILE_REPLY };
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

  if (media.kind === "image") {
    if (bytes.byteLength > imageMaxBytes) {
      return { kind: "reject", message: OVERSIZED_IMAGE_REPLY };
    }

    const mediaType = inferImageMediaType(media.mimetype, media.filename);
    const images = [{ data: bytes.toString("base64"), mediaType }];

    try {
      validateImageAttachments(images);
    } catch {
      return { kind: "reject", message: UNSUPPORTED_MEDIA_REPLY };
    }

    return { input: { images, message: media.caption }, kind: "input" };
  }

  const handling = resolveWhatsAppDocumentHandling(bytes.byteLength, {
    ingestMaxBytes,
    inlineMaxBytes,
  });

  if (handling === "reject") {
    return { kind: "reject", message: OVERSIZED_FILE_REPLY };
  }

  const mediaType = normalizeDocumentMediaType(media.mimetype, media.filename);

  if (handling === "extract") {
    let extracted: { text: string; truncated: boolean };

    try {
      extracted = await extractDocumentText({
        bytes,
        filename: media.filename,
        mediaType,
      });
    } catch {
      return { kind: "reject", message: UNREADABLE_DOCUMENT_REPLY };
    }

    const text = extracted.text.trim();
    if (!text) {
      return { kind: "reject", message: UNREADABLE_DOCUMENT_REPLY };
    }

    return {
      input: {
        message: formatExtractedWhatsAppDocumentMessage({
          caption: media.caption,
          filename: media.filename,
          text,
          truncated: extracted.truncated,
        }),
      },
      kind: "input",
    };
  }

  const documents = [
    { data: bytes.toString("base64"), filename: media.filename, mediaType },
  ];

  try {
    validateDocumentAttachments(documents);
  } catch {
    return { kind: "reject", message: UNSUPPORTED_DOCUMENT_TYPES_REPLY };
  }

  return { input: { documents, message: media.caption }, kind: "input" };
}

export function formatExtractedWhatsAppDocumentMessage(input: {
  caption: string;
  filename: string;
  text: string;
  truncated: boolean;
}): string {
  const body = `[File: ${input.filename}]\n${input.text}${
    input.truncated ? "\n\n[Extracted text was truncated.]" : ""
  }`;

  return input.caption ? `${input.caption}\n\n${body}` : body;
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
