import type { SendMessageInput } from "@atlas/core/contract";
import {
  isSupportedDocumentMediaType,
  isSupportedImageMediaType,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  normalizeDocumentMediaType,
  normalizeImageMediaType,
  SUPPORTED_DOCUMENT_TYPE_LABEL,
  validateCombinedAttachmentCount,
  validateDocumentAttachments,
  validateImageAttachments,
} from "@atlas/core/message-content";
import type { Attachment, Message } from "discord.js";

export const UNSUPPORTED_DOCUMENT_TYPES_REPLY = `Unsupported file type. Send ${SUPPORTED_DOCUMENT_TYPE_LABEL} (max 5 MB).`;

export const OVERSIZED_FILE_REPLY = "File is too large. Maximum size is 5 MB.";

export const UNSUPPORTED_MEDIA_REPLY = `Send text, a photo, a voice note, or a supported document (${SUPPORTED_DOCUMENT_TYPE_LABEL} — max 5 MB).`;

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

  for (const attachment of message.attachments?.values() ?? []) {
    const classified = classifyDiscordAttachment(attachment);
    if (classified.kind === "reject") {
      return classified;
    }

    const maxBytes =
      classified.kind === "image"
        ? MAX_IMAGE_BYTES
        : classified.kind === "audio"
          ? MAX_AUDIO_BYTES
          : MAX_DOCUMENT_BYTES;

    let bytes: ArrayBuffer;

    try {
      bytes = await downloadDiscordAttachment(attachment, maxBytes);
    } catch (error) {
      if (error instanceof OversizedDiscordFileError) {
        return {
          kind: "reject",
          message:
            classified.kind === "audio"
              ? OVERSIZED_AUDIO_REPLY
              : OVERSIZED_FILE_REPLY,
        };
      }

      return { kind: "reject", message: DOWNLOAD_FAILED_REPLY };
    }

    const data = Buffer.from(bytes).toString("base64");

    if (classified.kind === "image") {
      images.push({ data, mediaType: classified.mediaType });
      continue;
    }

    if (classified.kind === "audio") {
      if (!options?.transcribeAudio) {
        return { kind: "reject", message: AUDIO_TRANSCRIBE_FAILED_REPLY };
      }

      try {
        const { text } = await options.transcribeAudio({
          data,
          filename: classified.filename,
          mediaType: classified.mediaType,
        });
        const transcript = text.trim();
        if (!transcript) {
          return { kind: "reject", message: AUDIO_TRANSCRIBE_FAILED_REPLY };
        }
        transcripts.push(transcript);
      } catch (error) {
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

    documents.push({
      data,
      filename: classified.filename,
      mediaType: classified.mediaType,
    });
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

  const caption = message.content?.trim() ?? "";
  const messageText = [...transcripts, caption].filter(Boolean).join("\n\n");

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
  | { kind: "image"; mediaType: string }
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
      return { kind: "reject", message: OVERSIZED_FILE_REPLY };
    }

    return { kind: "image", mediaType };
  }

  const mediaType = normalizeDocumentMediaType(rawType, filename);

  if (!isSupportedDocumentMediaType(mediaType, filename)) {
    return { kind: "reject", message: UNSUPPORTED_DOCUMENT_TYPES_REPLY };
  }

  if (size > MAX_DOCUMENT_BYTES) {
    return { kind: "reject", message: OVERSIZED_FILE_REPLY };
  }

  return { filename, kind: "document", mediaType };
}

async function downloadDiscordAttachment(
  attachment: Attachment,
  maxBytes: number
): Promise<ArrayBuffer> {
  if (attachment.size > maxBytes) {
    throw new OversizedDiscordFileError();
  }

  const response = await fetch(attachment.url);

  if (!response.ok) {
    throw new Error(`Failed to download file (${response.status}).`);
  }

  const bytes = await response.arrayBuffer();

  if (bytes.byteLength > maxBytes) {
    throw new OversizedDiscordFileError();
  }

  return bytes;
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
