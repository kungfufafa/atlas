import type { Context } from "grammy";
import { InputFile } from "grammy";

/** Align with the inbound attachment cap in attachments.ts. */
export const TELEGRAM_ARTIFACT_MAX_BYTES = 5 * 1024 * 1024;

export interface SendTelegramArtifactInput {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface SendTelegramArtifactResult {
  error?: string;
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
      threadId === undefined ? undefined : { message_thread_id: threadId };
    const file = new InputFile(input.bytes, input.filename);

    if (isTelegramPhotoMimeType(input.mimeType)) {
      await ctx.api.sendPhoto(ctx.chat.id, file, sendOptions);
    } else {
      await ctx.api.sendDocument(ctx.chat.id, file, sendOptions);
    }
    return { ok: true };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Failed to send the file.",
      ok: false,
    };
  }
}

function isTelegramPhotoMimeType(mimeType: string): boolean {
  return mimeType === "image/jpeg" || mimeType === "image/png";
}

export function formatTelegramArtifactTooLargeMessage(bytes: number): string {
  return `File is too large for Telegram (${formatMegabytes(bytes)}; max ${formatMegabytes(TELEGRAM_ARTIFACT_MAX_BYTES)}). Use the share link instead.`;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
