import type { SendMessageInput } from "@atlas/core/contract";
import {
  extractInboundDocumentText,
  isSpreadsheetDocumentMediaType,
  isSupportedDocumentMediaType,
  isSupportedImageMediaType,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_INGEST_BYTES,
  MAX_IMAGE_BYTES,
  normalizeDocumentMediaType,
  normalizeImageMediaType,
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

export const WHATSAPP_DOCUMENT_INGEST_MAX_BYTES = MAX_DOCUMENT_INGEST_BYTES;
export const WHATSAPP_IMAGE_MAX_BYTES = MAX_IMAGE_BYTES;
export const WHATSAPP_DOCUMENT_INLINE_MAX_BYTES = MAX_DOCUMENT_BYTES;

export const UNSUPPORTED_DOCUMENT_TYPES_REPLY = `Unsupported file type. Send ${SUPPORTED_DOCUMENT_TYPE_LABEL} (max 25 MB).`;

export const OVERSIZED_FILE_REPLY =
  "That file is too large to process here (max 25 MB). Send a smaller file, or a link.";

export const OVERSIZED_IMAGE_REPLY =
  "That photo is too large (max 5 MB). Send a compressed photo, or attach it as a document.";

export const UNREADABLE_DOCUMENT_REPLY =
  "Could not read text from that file. Try a text-based PDF, Word, or Excel file. Scanned/image-only PDFs are not supported.";

export const SAVE_FAILED_DOCUMENT_REPLY =
  "Could not save that file. Try sending it again.";

export const UNSUPPORTED_MEDIA_REPLY = `Send text, a photo (max 5 MB), a voice note, or a supported document (${SUPPORTED_DOCUMENT_TYPE_LABEL} — max 25 MB).`;

export const DOWNLOAD_FAILED_REPLY = "Could not download that file. Try again.";

export const PAIRING_MEDIA_REPLY =
  "Send the chat access code as text to authorize this chat.";

export type WhatsAppMediaDownload = (message: WAMessage) => Promise<Buffer>;

export type WhatsAppMediaBuildResult =
  | { kind: "input"; input: SendMessageInput }
  | { kind: "reject"; message: string }
  | null;

export interface WhatsAppSavedInboundDocument {
  relativePath: string;
  sizeBytes: number;
}

export interface WhatsAppMediaInputOptions {
  extractDocumentText?: typeof extractInboundDocumentText;
  imageMaxBytes?: number;
  ingestMaxBytes?: number;
  inlineMaxBytes?: number;
  saveInboundDocument?: (input: {
    bytes: Buffer;
    filename: string;
    mediaType: string;
  }) => Promise<WhatsAppSavedInboundDocument>;
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
    return buildExtractedWhatsAppDocumentInput({
      bytes,
      caption: media.caption,
      extractDocumentText,
      filename: media.filename,
      mediaType,
      saveInboundDocument: options.saveInboundDocument,
    });
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

export function formatSavedWhatsAppDocumentMessage(input: {
  caption: string;
  filename: string;
  mediaType: string;
  relativePath: string;
  sizeBytes: number;
}): string {
  const header = `[Saved WhatsApp file: ${input.relativePath} (${formatMegabytes(input.sizeBytes)})]`;
  const body = `${header}\n${savedWorkspaceDocumentHint({
    filename: input.filename,
    mediaType: input.mediaType,
    relativePath: input.relativePath,
  })}`;

  return input.caption ? `${input.caption}\n\n${body}` : body;
}

export function savedWorkspaceDocumentHint(input: {
  filename: string;
  mediaType: string;
  relativePath: string;
}): string {
  const mediaType = normalizeDocumentMediaType(input.mediaType, input.filename);
  const finish =
    "Finish the user's request in this turn: use tools on that path, write the complete deliverable under artifacts/, and reply with a short summary. Do not dump the source file into chat. If a tool truncates or times out, continue from what you have and still finish.";

  if (
    isSpreadsheetDocumentMediaType(mediaType, input.filename) ||
    mediaType === "text/csv"
  ) {
    return `This spreadsheet is saved at ${input.relativePath}. Use the spreadsheet tool to inspect and process the full workbook, then write the result to a new artifacts/ file. ${finish}`;
  }

  if (mediaType === "text/plain" || mediaType === "text/markdown") {
    return `This file is saved at ${input.relativePath}. Read it from the profile workspace. ${finish}`;
  }

  return `This file is saved at ${input.relativePath}. Use extract_document_text with documentRef ${input.relativePath}. ${finish}`;
}

export function mergeWhatsAppUserMessage(
  userText: string,
  mediaMessage: string
): string {
  const trimmed = userText.trim();
  const media = mediaMessage.trim();

  if (!trimmed) {
    return media;
  }

  if (!media) {
    return trimmed;
  }

  if (media === trimmed || media.startsWith(`${trimmed}\n`)) {
    return media;
  }

  return `${trimmed}\n\n${media}`;
}

async function buildExtractedWhatsAppDocumentInput(input: {
  bytes: Buffer;
  caption: string;
  extractDocumentText: typeof extractInboundDocumentText;
  filename: string;
  mediaType: string;
  saveInboundDocument?: WhatsAppMediaInputOptions["saveInboundDocument"];
}): Promise<WhatsAppMediaBuildResult> {
  const saveInboundDocument = input.saveInboundDocument;
  if (saveInboundDocument) {
    return buildSavedWhatsAppDocumentInput({
      ...input,
      saveInboundDocument,
    });
  }

  let extracted: { text: string; truncated: boolean } | null = null;

  try {
    extracted = await input.extractDocumentText({
      bytes: input.bytes,
      filename: input.filename,
      mediaType: input.mediaType,
    });
  } catch {
    extracted = null;
  }

  if (!extracted?.text.trim()) {
    return { kind: "reject", message: UNREADABLE_DOCUMENT_REPLY };
  }

  return {
    input: {
      message: formatExtractedWhatsAppDocumentMessage({
        caption: input.caption,
        filename: input.filename,
        text: extracted.text,
        truncated: extracted.truncated,
      }),
    },
    kind: "input",
  };
}

async function buildSavedWhatsAppDocumentInput(input: {
  bytes: Buffer;
  caption: string;
  filename: string;
  mediaType: string;
  saveInboundDocument: NonNullable<
    WhatsAppMediaInputOptions["saveInboundDocument"]
  >;
}): Promise<WhatsAppMediaBuildResult> {
  let saved: WhatsAppSavedInboundDocument;

  try {
    saved = await input.saveInboundDocument({
      bytes: input.bytes,
      filename: input.filename,
      mediaType: input.mediaType,
    });
  } catch {
    return { kind: "reject", message: SAVE_FAILED_DOCUMENT_REPLY };
  }

  if (!isSafeSavedRelativePath(saved.relativePath)) {
    return { kind: "reject", message: SAVE_FAILED_DOCUMENT_REPLY };
  }

  const sizeBytes =
    Number.isFinite(saved.sizeBytes) && saved.sizeBytes >= 0
      ? saved.sizeBytes
      : input.bytes.byteLength;

  return {
    input: {
      message: formatSavedWhatsAppDocumentMessage({
        caption: input.caption,
        filename: input.filename,
        mediaType: input.mediaType,
        relativePath: saved.relativePath,
        sizeBytes,
      }),
    },
    kind: "input",
  };
}

function isSafeSavedRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").trim();
  const [folder, filename, ...rest] = normalized.split("/");

  return (
    rest.length === 0 &&
    folder === "artifacts" &&
    typeof filename === "string" &&
    filename.length > 0 &&
    filename !== "." &&
    filename !== ".."
  );
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const trimmed = normalizeImageMediaType(mimetype);

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
