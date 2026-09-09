import {
  MAX_DOCUMENT_INGEST_BYTES,
  MAX_IMAGE_BYTES,
} from "@atlas/core/message-content";
import type { Context } from "grammy";
import { InputFile } from "grammy";

/** Atlas document upload policy, below the hosted Bot API multipart limit (50 MB). */
export const TELEGRAM_ARTIFACT_MAX_BYTES = MAX_DOCUMENT_INGEST_BYTES;

export interface SendTelegramArtifactInput {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  presentation?: "auto" | "voice" | "document";
}

export interface SendTelegramArtifactResult {
  error?: string;
  messageId?: string;
  ok: boolean;
}

export async function sendTelegramArtifact(
  ctx: Context,
  input: SendTelegramArtifactInput
): Promise<SendTelegramArtifactResult> {
  if (input.bytes.byteLength > TELEGRAM_ARTIFACT_MAX_BYTES) {
    return {
      error: formatTelegramArtifactTooLargeMessage(input.bytes.byteLength),
      ok: false,
    };
  }

  if (!ctx.chat) {
    return { error: "Telegram chat context is missing.", ok: false };
  }

  try {
    const threadId = ctx.message?.message_thread_id;
    const sendOptions =
      threadId === undefined || threadId === 1
        ? undefined
        : { message_thread_id: threadId };
    const file = new InputFile(input.bytes, input.filename);
    let sent: { message_id: number };
    if (input.presentation === "document") {
      sent = await ctx.api.sendDocument(ctx.chat.id, file, sendOptions);
    } else if (
      input.presentation === "voice" ||
      input.mimeType === "audio/ogg"
    ) {
      const prefix = Buffer.from(input.bytes.subarray(0, 256));
      if (
        !(
          prefix.subarray(0, 4).equals(Buffer.from("OggS")) &&
          prefix.includes(Buffer.from("OpusHead"))
        )
      ) {
        throw new Error(
          "Native voice delivery requires Ogg Opus audio. Use document delivery for other formats."
        );
      }
      sent = await ctx.api.sendVoice(ctx.chat.id, file, sendOptions);
    } else if (
      input.mimeType === "audio/mpeg" ||
      input.mimeType === "audio/mp4"
    ) {
      assertNativeMediaSignature(input);
      sent = await ctx.api.sendAudio(ctx.chat.id, file, sendOptions);
    } else if (input.mimeType === "video/mp4") {
      assertNativeMediaSignature(input);
      sent = await ctx.api.sendVideo(ctx.chat.id, file, sendOptions);
    } else if (
      isTelegramPhotoMimeType(input.mimeType) &&
      input.bytes.byteLength <= MAX_IMAGE_BYTES
    ) {
      sent = await ctx.api.sendPhoto(ctx.chat.id, file, sendOptions);
    } else {
      sent = await ctx.api.sendDocument(ctx.chat.id, file, sendOptions);
    }
    if (!Number.isInteger(sent.message_id) || sent.message_id <= 0) {
      throw new Error(
        "Telegram upload acknowledgement did not include a message ID; delivery is unconfirmed. Do not retry automatically."
      );
    }
    return { messageId: String(sent.message_id), ok: true };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Failed to send the file.",
      ok: false,
    };
  }
}

function assertNativeMediaSignature(input: SendTelegramArtifactInput): void {
  const bytes = input.bytes;
  const mp3 =
    bytes.length >= 3 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
      (bytes[0] === 0xff && bytes[1]! >= 0xe0));
  const mp4 =
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(4, 8)).equals(Buffer.from("ftyp"));
  if (input.mimeType === "audio/mpeg" ? !mp3 : !mp4) {
    throw new Error(
      "The file bytes do not match the selected native audio/video format."
    );
  }
}

function isTelegramPhotoMimeType(mimeType: string): boolean {
  return mimeType === "image/jpeg" || mimeType === "image/png";
}

export function formatTelegramArtifactTooLargeMessage(bytes: number): string {
  return `File is too large for Atlas Telegram delivery (${formatMegabytes(bytes)}; Atlas limit ${formatMegabytes(TELEGRAM_ARTIFACT_MAX_BYTES)}). Use the share link instead.`;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
