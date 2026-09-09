import {
  CHANNEL_DOCUMENT_OVERSIZED_REPLY,
  CHANNEL_DOCUMENT_UNSUPPORTED_REPLY,
  prepareChannelAudio,
  prepareChannelDocument,
  prepareChannelImage,
  type SaveInboundDocument,
} from "@atlas/core/attachments/inbound-document";
import type { SendMessageInput } from "@atlas/core/contract";
import {
  createDownloadDeadline,
  EmptyDownloadError,
  throwIfSignalAborted,
  waitForAbortable,
} from "@atlas/core/download-deadline";
import {
  isSupportedDocumentMediaType,
  isSupportedImageMediaType,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DOCUMENT_INGEST_BYTES,
  MAX_IMAGE_BYTES,
  normalizeDocumentMediaType,
  normalizeImageMediaType,
  SUPPORTED_DOCUMENT_TYPE_LABEL,
  validateCombinedAttachmentCount,
  validateDocumentAttachments,
  validateImageAttachments,
} from "@atlas/core/message-content";
import type { Attachment, Message } from "discord.js";

export const UNSUPPORTED_DOCUMENT_TYPES_REPLY =
  CHANNEL_DOCUMENT_UNSUPPORTED_REPLY;

export const OVERSIZED_FILE_REPLY = CHANNEL_DOCUMENT_OVERSIZED_REPLY;
export const OVERSIZED_IMAGE_REPLY = "Atlas accepts images up to 5 MB.";

export const UNSUPPORTED_MEDIA_REPLY = `Send text, a photo, a voice note, or a supported document (${SUPPORTED_DOCUMENT_TYPE_LABEL} — Atlas document limit: 25 MB).`;

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export const OVERSIZED_AUDIO_REPLY =
  "Audio is too large. Maximum size is 25 MB.";

export const AUDIO_TRANSCRIBE_FAILED_REPLY =
  "Could not transcribe that voice note. Try again or send text.";

export const DOWNLOAD_FAILED_REPLY = "Could not download that file. Try again.";

export const PAIRING_MEDIA_REPLY =
  "Send your pairing code as text to link this chat.";

export const ATTACH_COMMAND_WITH_FILE_REPLY =
  "Send /attach without a file to get the last saved artifact. To give me a file, send it without /attach.";

export type DiscordAttachmentBuildResult =
  | { kind: "input"; input: SendMessageInput }
  | { kind: "reject"; message: string }
  | null;

export function hasDiscordAttachments(message: Message): boolean {
  return (message.attachments?.size ?? 0) > 0;
}

export async function buildDiscordAttachmentInput(
  message: Message,
  options?: {
    caption?: string;
    idleTimeoutMs?: number;
    overallTimeoutMs?: number;
    signal?: AbortSignal;
    saveInboundDocument?: SaveInboundDocument;
    transcribeAudio?: (input: {
      data: string;
      filename: string;
      mediaType: string;
    }) => Promise<{ text: string }>;
  }
): Promise<DiscordAttachmentBuildResult> {
  const attachmentCount = message.attachments?.size ?? 0;
  if (attachmentCount === 0) {
    return null;
  }

  if (attachmentCount > MAX_ATTACHMENTS_PER_MESSAGE) {
    return {
      kind: "reject",
      message: `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`,
    };
  }

  const images: NonNullable<SendMessageInput["images"]> = [];
  const documents: NonNullable<SendMessageInput["documents"]> = [];
  const transcripts: string[] = [];
  const documentMessages: string[] = [];

  // Reject unsupported or oversized entries before saving any earlier document.
  const entries = Array.from(
    message.attachments?.values() ?? [],
    (attachment) => ({
      attachment,
      classified: classifyDiscordAttachment(attachment),
    })
  );
  for (const { classified } of entries) {
    if (classified.kind === "reject") {
      return classified;
    }
  }

  for (const { attachment, classified } of entries) {
    options?.signal?.throwIfAborted();
    if (classified.kind === "reject") {
      return classified;
    }

    const maxBytes =
      classified.kind === "image"
        ? MAX_IMAGE_BYTES
        : classified.kind === "audio"
          ? MAX_AUDIO_BYTES
          : MAX_DOCUMENT_INGEST_BYTES;

    let bytes: ArrayBuffer;

    try {
      bytes = await downloadDiscordAttachment(attachment, maxBytes, options);
    } catch (error) {
      if (options?.signal?.aborted) {
        throwIfSignalAborted(options.signal);
      }
      if (error instanceof OversizedDiscordFileError) {
        return {
          kind: "reject",
          message:
            classified.kind === "audio"
              ? OVERSIZED_AUDIO_REPLY
              : classified.kind === "image"
                ? OVERSIZED_IMAGE_REPLY
                : OVERSIZED_FILE_REPLY,
        };
      }

      return { kind: "reject", message: DOWNLOAD_FAILED_REPLY };
    }

    if (classified.kind === "image") {
      const prepared = await prepareChannelImage({
        bytes: Buffer.from(bytes),
        caption: "",
        channel: "Discord",
        filename: classified.filename,
        mediaType: classified.mediaType,
        saveInboundDocument: options?.saveInboundDocument,
        signal: options?.signal,
      });
      if (prepared.kind === "reject") {
        return prepared;
      }
      images.push(...(prepared.input.images ?? []));
      if (prepared.input.message) {
        documentMessages.push(prepared.input.message);
      }
      continue;
    }

    if (classified.kind === "audio") {
      const prepared = await prepareChannelAudio({
        bytes: Buffer.from(bytes),
        caption: "",
        channel: "Discord",
        filename: classified.filename,
        mediaType: classified.mediaType,
        saveInboundDocument: options?.saveInboundDocument,
        signal: options?.signal,
      });
      if (prepared.kind === "reject") {
        return prepared;
      }
      if (prepared.input.message) {
        documentMessages.push(prepared.input.message);
      }
      if (!options?.transcribeAudio) {
        return { kind: "reject", message: AUDIO_TRANSCRIBE_FAILED_REPLY };
      }

      try {
        const transcription = options.transcribeAudio({
          data: Buffer.from(bytes).toString("base64"),
          filename: classified.filename,
          mediaType: classified.mediaType,
        });
        const { text } = options.signal
          ? await waitForAbortable(transcription, options.signal)
          : await transcription;
        const transcript = text.trim();
        if (!transcript) {
          return { kind: "reject", message: AUDIO_TRANSCRIBE_FAILED_REPLY };
        }
        transcripts.push(transcript);
      } catch (error) {
        if (options.signal?.aborted) {
          throwIfSignalAborted(options.signal);
        }
        return {
          kind: "reject",
          message:
            error instanceof Error && error.message.trim()
              ? error.message
              : AUDIO_TRANSCRIBE_FAILED_REPLY,
        };
      }
      continue;
    }

    const prepared = await prepareChannelDocument({
      bytes: Buffer.from(bytes),
      caption: "",
      channel: "Discord",
      filename: classified.filename,
      mediaType: classified.mediaType,
      saveInboundDocument: options?.saveInboundDocument,
      signal: options?.signal,
    });
    if (prepared.kind === "reject") {
      return prepared;
    }
    documents.push(...(prepared.input.documents ?? []));
    if (prepared.input.message) {
      documentMessages.push(prepared.input.message);
    }
  }

  try {
    if (images.length > 0) {
      validateImageAttachments(images);
    }

    if (documents.length > 0) {
      validateDocumentAttachments(documents);
    }

    validateCombinedAttachmentCount(images.length, documents.length);
  } catch {
    return { kind: "reject", message: UNSUPPORTED_MEDIA_REPLY };
  }

  const caption = options?.caption?.trim() ?? message.content?.trim() ?? "";
  const messageText = [...transcripts, caption, ...documentMessages]
    .filter(Boolean)
    .join("\n\n");

  return {
    input: {
      documents: documents.length > 0 ? documents : undefined,
      images: images.length > 0 ? images : undefined,
      message: messageText,
    },
    kind: "input",
  };
}

class OversizedDiscordFileError extends Error {
  constructor() {
    super("File is too large.");
    this.name = "OversizedDiscordFileError";
  }
}

function classifyDiscordAttachment(
  attachment: Attachment
):
  | { kind: "image"; filename: string; mediaType: string }
  | { kind: "audio"; filename: string; mediaType: string }
  | { kind: "document"; filename: string; mediaType: string }
  | { kind: "reject"; message: string } {
  const filename = attachment.name?.trim() || "document";
  const rawType = attachment.contentType?.split(";")[0]?.trim() ?? "";
  const normalizedImageType = normalizeImageMediaType(rawType);
  const size = attachment.size;
  const looksLikeAudio =
    rawType.startsWith("audio/") ||
    Boolean(
      "waveform" in attachment &&
        (attachment as { waveform?: string | null }).waveform
    ) ||
    /\.(ogg|opus|mp3|m4a|wav)$/i.test(filename);

  if (looksLikeAudio) {
    const mediaType = rawType.startsWith("audio/")
      ? rawType
      : inferAudioMediaTypeFromName(filename);

    if (size > MAX_AUDIO_BYTES) {
      return { kind: "reject", message: OVERSIZED_AUDIO_REPLY };
    }

    return {
      filename: filename === "document" ? "voice.ogg" : filename,
      kind: "audio",
      mediaType,
    };
  }

  const looksLikeImage =
    normalizedImageType.startsWith("image/") ||
    isSupportedImageMediaType(normalizedImageType) ||
    isImageFilename(filename);

  if (looksLikeImage) {
    const mediaType = isSupportedImageMediaType(normalizedImageType)
      ? normalizedImageType
      : inferImageMediaTypeFromName(filename);

    if (!isSupportedImageMediaType(mediaType)) {
      return { kind: "reject", message: UNSUPPORTED_MEDIA_REPLY };
    }

    if (size > MAX_IMAGE_BYTES) {
      return { kind: "reject", message: OVERSIZED_IMAGE_REPLY };
    }

    return { filename, kind: "image", mediaType };
  }

  const mediaType = normalizeDocumentMediaType(rawType, filename);

  if (!isSupportedDocumentMediaType(mediaType, filename)) {
    return { kind: "reject", message: UNSUPPORTED_DOCUMENT_TYPES_REPLY };
  }

  if (size > MAX_DOCUMENT_INGEST_BYTES) {
    return { kind: "reject", message: OVERSIZED_FILE_REPLY };
  }

  return { filename, kind: "document", mediaType };
}

async function downloadDiscordAttachment(
  attachment: Attachment,
  maxBytes: number,
  options: {
    idleTimeoutMs?: number;
    overallTimeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<ArrayBuffer> {
  if (attachment.size > maxBytes) {
    throw new OversizedDiscordFileError();
  }

  if (attachment.size === 0) {
    throw new EmptyDownloadError();
  }

  const deadline = createDownloadDeadline(options);

  try {
    deadline.resetIdle();
    const response = await waitForAbortable(
      fetch(attachment.url, { signal: deadline.signal }),
      deadline.signal
    );

    if (!response.ok) {
      throw new Error(`Failed to download file (${response.status}).`);
    }

    assertDiscordContentLength(response, maxBytes);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new EmptyDownloadError();
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      deadline.resetIdle();
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await waitForAbortable(reader.read(), deadline.signal);
      } catch (error) {
        void reader.cancel(error).catch(() => undefined);
        throw error;
      }
      const { done, value } = result;
      if (done) {
        break;
      }
      if (!value?.byteLength) {
        continue;
      }

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new OversizedDiscordFileError();
      }
      chunks.push(value);
    }

    if (total === 0) {
      throw new EmptyDownloadError();
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return merged.buffer;
  } finally {
    deadline.dispose();
  }
}

function assertDiscordContentLength(
  response: Response,
  maxBytes: number
): void {
  const rawLength = response.headers.get("content-length")?.trim();
  if (!(rawLength && /^\d+$/.test(rawLength))) {
    return;
  }

  const contentLength = Number(rawLength);
  if (contentLength === 0) {
    throw new EmptyDownloadError();
  }
  if (contentLength > maxBytes) {
    throw new OversizedDiscordFileError();
  }
}

function inferAudioMediaTypeFromName(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();

  switch (extension) {
    case ".ogg":
    case ".opus":
      return "audio/ogg";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    default:
      return "audio/ogg";
  }
}

function isImageFilename(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(filename);
}

function inferImageMediaTypeFromName(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();

  switch (extension) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}
