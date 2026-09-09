import type { Transform } from "node:stream";
import {
  CHANNEL_DOCUMENT_OVERSIZED_REPLY,
  CHANNEL_DOCUMENT_SAVE_FAILED_REPLY,
  CHANNEL_DOCUMENT_UNREADABLE_REPLY,
  CHANNEL_DOCUMENT_UNSUPPORTED_REPLY,
  formatSavedChannelDocumentMessage,
  prepareChannelDocument,
  prepareChannelImage,
  type SavedInboundDocument,
  type SaveInboundDocument,
} from "@atlas/core/attachments/inbound-document";

export { savedWorkspaceDocumentHint } from "@atlas/core/attachments/inbound-document";

import type { SendMessageInput } from "@atlas/core/contract";
import {
  createDownloadDeadline,
  EmptyDownloadError,
  throwIfSignalAborted,
  waitForAbortable,
} from "@atlas/core/download-deadline";
import {
  type extractInboundDocumentText,
  isSupportedDocumentMediaType,
  isSupportedImageMediaType,
  MAX_DOCUMENT_INGEST_BYTES,
  MAX_IMAGE_BYTES,
  normalizeDocumentMediaType,
  normalizeImageMediaType,
  SUPPORTED_DOCUMENT_TYPE_LABEL,
} from "@atlas/core/message-content";
import {
  downloadMediaMessage,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { inspectInboundWhatsAppMedia } from "./inbound-message";
import { BoundedWorkQueue } from "./inbound-work-queue";
import {
  decodeWhatsAppVisual,
  extractWhatsAppVideoAudio,
} from "./native-media";

export const WHATSAPP_DOCUMENT_INGEST_MAX_BYTES = MAX_DOCUMENT_INGEST_BYTES;
export const WHATSAPP_IMAGE_MAX_BYTES = MAX_IMAGE_BYTES;

export const UNSUPPORTED_DOCUMENT_TYPES_REPLY =
  CHANNEL_DOCUMENT_UNSUPPORTED_REPLY;

export const OVERSIZED_FILE_REPLY = CHANNEL_DOCUMENT_OVERSIZED_REPLY;

export const OVERSIZED_IMAGE_REPLY =
  "That image is too large (max 5 MB). Send a smaller image.";

export const UNREADABLE_DOCUMENT_REPLY = CHANNEL_DOCUMENT_UNREADABLE_REPLY;
export const SAVE_FAILED_DOCUMENT_REPLY = CHANNEL_DOCUMENT_SAVE_FAILED_REPLY;

export const UNSUPPORTED_MEDIA_REPLY = `Send text, a photo or WebP sticker (max 5 MB), a voice note, an MP4 video, or a supported document (${SUPPORTED_DOCUMENT_TYPE_LABEL} — max 25 MB).`;

export const DOWNLOAD_FAILED_REPLY =
  "The file did not arrive. Please send the attachment again.";

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

export type WhatsAppSavedInboundDocument = SavedInboundDocument;

export interface WhatsAppMediaInputOptions {
  downloadOverallTimeoutMs?: number;
  extractDocumentText?: typeof extractInboundDocumentText;
  imageMaxBytes?: number;
  ingestMaxBytes?: number;
  inlineMaxBytes?: number;
  saveInboundDocument?: SaveInboundDocument;
  signal?: AbortSignal;
  transcribeVideoAudio?: (input: {
    data: string;
    filename: string;
    mediaType: string;
  }) => Promise<{ text: string }>;
}

export function resolveWhatsAppDocumentHandling(
  byteLength: number,
  limits: { ingestMaxBytes: number }
): "save" | "reject" {
  if (byteLength > limits.ingestMaxBytes) {
    return "reject";
  }

  return "save";
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
  const ingestMaxBytes =
    options.ingestMaxBytes ?? WHATSAPP_DOCUMENT_INGEST_MAX_BYTES;

  if (media.kind === "video" || media.kind === "sticker") {
    return buildWhatsAppVisualInput(inbound, download, media, options);
  }

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
    return prepareChannelImage({
      bytes,
      caption: media.caption,
      channel: "WhatsApp",
      filename: media.filename,
      mediaType,
      saveInboundDocument: options.saveInboundDocument,
      signal: options.signal,
    });
  }

  const handling = resolveWhatsAppDocumentHandling(bytes.byteLength, {
    ingestMaxBytes,
  });

  if (handling === "reject") {
    return { kind: "reject", message: OVERSIZED_FILE_REPLY };
  }

  const mediaType = normalizeDocumentMediaType(media.mimetype, media.filename);

  return prepareChannelDocument({
    bytes,
    caption: media.caption,
    channel: "WhatsApp",
    filename: media.filename,
    ingestMaxBytes,
    mediaType,
    saveInboundDocument: options.saveInboundDocument,
    signal: options.signal,
  });
}

async function buildWhatsAppVisualInput(
  inbound: WAMessage,
  download: WhatsAppMediaDownload,
  media: NonNullable<ReturnType<typeof inspectInboundWhatsAppMedia>>,
  options: WhatsAppMediaInputOptions
): Promise<WhatsAppMediaBuildResult> {
  const kind = media.kind === "sticker" ? "sticker" : "video";
  const maxBytes =
    kind === "sticker"
      ? (options.imageMaxBytes ?? WHATSAPP_IMAGE_MAX_BYTES)
      : (options.ingestMaxBytes ?? WHATSAPP_DOCUMENT_INGEST_MAX_BYTES);
  if (media.fileLength !== null && media.fileLength > maxBytes) {
    return { kind: "reject", message: OVERSIZED_FILE_REPLY };
  }
  if (
    media.mimetype.split(";")[0]?.trim() !==
    (kind === "sticker" ? "image/webp" : "video/mp4")
  ) {
    return { kind: "reject", message: UNSUPPORTED_MEDIA_REPLY };
  }
  try {
    const bytes = await downloadWhatsAppMediaWithinDeadline(download, inbound, {
      maxBytes,
      overallTimeoutMs: options.downloadOverallTimeoutMs,
      signal: options.signal,
    });
    if (bytes.byteLength > maxBytes) {
      return { kind: "reject", message: OVERSIZED_FILE_REPLY };
    }
    const image = await decodeWhatsAppVisual(bytes, kind, {
      signal: options.signal,
    });
    const parts = [
      media.caption,
      kind === "sticker"
        ? "[WhatsApp sticker: first frame shown; animation is not represented.]"
        : "[WhatsApp video: first frame shown; this image does not represent the complete video.]",
    ].filter(Boolean);
    if (kind === "video") {
      let audio: Buffer | undefined;
      try {
        audio = await extractWhatsAppVideoAudio(bytes, {
          signal: options.signal,
        });
      } catch {
        if (options.signal) {
          throwIfSignalAborted(options.signal);
        }
        parts.push(
          "[Audio transcription is unavailable: extraction failed or the video has no audio track.]"
        );
      }
      if (audio && options.transcribeVideoAudio) {
        const pending = options.transcribeVideoAudio({
          data: audio.toString("base64"),
          filename: "video-audio.wav",
          mediaType: "audio/wav",
        });
        const result = options.signal
          ? await waitForAbortable(pending, options.signal)
          : await pending;
        parts.push(
          result.text.trim()
            ? `Video audio transcript:\n${result.text.trim()}`
            : "[The video audio transcription was empty.]"
        );
      } else if (audio) {
        parts.push("[Audio is present, but transcription is unavailable.]");
      }
    }
    return {
      input: {
        images: [{ data: image.toString("base64"), mediaType: "image/png" }],
        message: parts.join("\n\n"),
      },
      kind: "input",
    };
  } catch (error) {
    if (options.signal) {
      throwIfSignalAborted(options.signal);
    }
    return {
      kind: "reject",
      message:
        error instanceof OversizedWhatsAppMediaError
          ? OVERSIZED_FILE_REPLY
          : "Could not process that video or sticker. Try another file or send text.",
    };
  }
}

export function formatSavedWhatsAppDocumentMessage(input: {
  caption: string;
  filename: string;
  mediaType: string;
  relativePath: string;
  sizeBytes: number;
}): string {
  return formatSavedChannelDocumentMessage({ ...input, channel: "WhatsApp" });
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
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
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
