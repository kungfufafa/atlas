import type { Transform } from "node:stream";
import type { SendMessageInput } from "@atlas/core/contract";
import {
  createDownloadDeadline,
  EmptyDownloadError,
  throwIfSignalAborted,
  waitForAbortable,
} from "@atlas/core/download-deadline";
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
import { BoundedWorkQueue } from "./inbound-work-queue";

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

export class OversizedWhatsAppMediaError extends Error {
  constructor() {
    super("File is too large.");
    this.name = "OversizedWhatsAppMediaError";
  }
}

export interface WhatsAppMediaDownloadOptions {
  idleTimeoutMs?: number;
  maxBytes: number;
  overallTimeoutMs?: number;
  signal?: AbortSignal;
}

export type WhatsAppMediaDownload = (
  message: WAMessage,
  options?: WhatsAppMediaDownloadOptions
) => Promise<Buffer>;

const MAX_CONCURRENT_MEDIA_DOWNLOADS = 2;
const MAX_QUEUED_MEDIA_DOWNLOADS = 20;
const MEDIA_DOWNLOAD_QUEUE_WAIT_MS = 30_000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;
const mediaDownloadQueue = new BoundedWorkQueue({
  maxConcurrent: MAX_CONCURRENT_MEDIA_DOWNLOADS,
  maxQueued: MAX_QUEUED_MEDIA_DOWNLOADS,
  maxWaitMs: MEDIA_DOWNLOAD_QUEUE_WAIT_MS,
});

class MediaDownloadTimeoutError extends Error {
  constructor() {
    super("WhatsApp media download timed out.");
    this.name = "MediaDownloadTimeoutError";
  }
}

export type WhatsAppMediaBuildResult =
  | { kind: "input"; input: SendMessageInput }
  | { kind: "reject"; message: string }
  | null;

export interface WhatsAppSavedInboundDocument {
  relativePath: string;
  sizeBytes: number;
}

export interface WhatsAppMediaInputOptions {
  downloadOverallTimeoutMs?: number;
  extractDocumentText?: typeof extractInboundDocumentText;
  imageMaxBytes?: number;
  ingestMaxBytes?: number;
  inlineMaxBytes?: number;
  saveInboundDocument?: (input: {
    bytes: Buffer;
    filename: string;
    mediaType: string;
  }) => Promise<WhatsAppSavedInboundDocument>;
  signal?: AbortSignal;
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
    bytes = await downloadWhatsAppMediaWithinDeadline(download, inbound, {
      maxBytes: media.kind === "image" ? imageMaxBytes : ingestMaxBytes,
      overallTimeoutMs: options.downloadOverallTimeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throwIfSignalAborted(options.signal);
    }
    if (error instanceof OversizedWhatsAppMediaError) {
      return {
        kind: "reject",
        message:
          media.kind === "image" ? OVERSIZED_IMAGE_REPLY : OVERSIZED_FILE_REPLY,
      };
    }
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
      signal: options.signal,
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
  signal?: AbortSignal;
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
    const extraction = input.extractDocumentText({
      bytes: input.bytes,
      filename: input.filename,
      mediaType: input.mediaType,
    });
    extracted = input.signal
      ? await waitForAbortable(extraction, input.signal)
      : await extraction;
  } catch {
    if (input.signal?.aborted) {
      throwIfSignalAborted(input.signal);
    }
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
  signal?: AbortSignal;
}): Promise<WhatsAppMediaBuildResult> {
  let saved: WhatsAppSavedInboundDocument;

  try {
    const saving = input.saveInboundDocument({
      bytes: input.bytes,
      filename: input.filename,
      mediaType: input.mediaType,
    });
    saved = input.signal
      ? await waitForAbortable(saving, input.signal)
      : await saving;
  } catch {
    if (input.signal?.aborted) {
      throwIfSignalAborted(input.signal);
    }
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
  socket: WASocket | null,
  options: WhatsAppMediaDownloadOptions = {
    maxBytes: WHATSAPP_DOCUMENT_INGEST_MAX_BYTES,
  }
): Promise<Buffer> {
  if (!socket) {
    throw new Error("WhatsApp is not connected.");
  }

  return mediaDownloadQueue.run(async () => {
    const deadline = createDownloadDeadline(options);
    let stream: Transform | null = null;

    try {
      deadline.resetIdle();
      stream = await waitForAbortable(
        downloadMediaMessage(
          inbound,
          "stream",
          { options: { signal: deadline.signal } },
          {
            logger: createSilentBaileysLogger(),
            reuploadRequest: (message) => socket.updateMediaMessage(message),
          }
        ),
        deadline.signal
      );

      return await collectWhatsAppMediaStream(
        stream,
        options.maxBytes,
        deadline
      );
    } finally {
      deadline.dispose();
    }
  });
}

export async function readWhatsAppMediaStream(
  stream: Transform,
  options: WhatsAppMediaDownloadOptions
): Promise<Buffer> {
  const deadline = createDownloadDeadline(options);
  try {
    deadline.resetIdle();
    return await collectWhatsAppMediaStream(stream, options.maxBytes, deadline);
  } finally {
    deadline.dispose();
  }
}

async function collectWhatsAppMediaStream(
  stream: Transform,
  maxBytes: number,
  deadline: ReturnType<typeof createDownloadDeadline>
): Promise<Buffer> {
  const destroyOnAbort = (): void => {
    stream.destroy(deadline.signal.reason);
  };
  deadline.signal.addEventListener("abort", destroyOnAbort, { once: true });

  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const value of stream) {
      deadline.throwIfAborted();
      deadline.resetIdle();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (chunk.byteLength === 0) {
        continue;
      }

      total += chunk.byteLength;
      if (total > maxBytes) {
        const error = new OversizedWhatsAppMediaError();
        stream.destroy(error);
        throw error;
      }
      chunks.push(chunk);
    }

    deadline.throwIfAborted();
    if (total === 0) {
      throw new EmptyDownloadError();
    }

    return Buffer.concat(chunks, total);
  } finally {
    deadline.signal.removeEventListener("abort", destroyOnAbort);
  }
}

export async function downloadWhatsAppMediaWithinDeadline(
  download: WhatsAppMediaDownload,
  inbound: WAMessage,
  options: Omit<WhatsAppMediaDownloadOptions, "idleTimeoutMs">
): Promise<Buffer> {
  const deadline = createDownloadDeadline({
    idleTimeoutMs: 0,
    overallTimeoutMs: options.overallTimeoutMs,
    signal: options.signal,
  });

  try {
    return await waitForAbortable(
      download(inbound, { ...options, signal: deadline.signal }),
      deadline.signal
    );
  } finally {
    deadline.dispose();
  }
}

export async function collectBoundedMediaStream(
  stream: AsyncIterable<unknown>,
  maxBytes: number,
  timeoutMs = MEDIA_DOWNLOAD_TIMEOUT_MS
): Promise<Buffer> {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error("WhatsApp media timeout must be greater than zero.");
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const collect = collectMediaStream(stream, maxBytes);
  const timeoutResult = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      destroyMediaStream(stream);
      reject(new MediaDownloadTimeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([collect, timeoutResult]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function collectMediaStream(
  stream: AsyncIterable<unknown>,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of stream) {
    if (!(Buffer.isBuffer(chunk) || typeof chunk === "string")) {
      throw new Error("WhatsApp returned an invalid media chunk.");
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error("WhatsApp media exceeds the download limit.");
    }
    chunks.push(bytes);
  }

  if (totalBytes === 0) {
    throw new Error("Could not download that file.");
  }
  return Buffer.concat(chunks, totalBytes);
}

function destroyMediaStream(stream: AsyncIterable<unknown>): void {
  const destroy = (stream as { destroy?: (error?: Error) => void }).destroy;
  if (typeof destroy === "function") {
    destroy.call(stream, new MediaDownloadTimeoutError());
  }
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
