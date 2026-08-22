import type { Context } from "grammy";
import { InputFile } from "grammy";

/** Align with inbound document cap in attachments.ts. */
export const TELEGRAM_ARTIFACT_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

export interface SendArtifactDocumentInput {
  bytes: Uint8Array;
  filename: string;
}

export interface SendArtifactDocumentResult {
  error?: string;
  ok: boolean;
}

export async function sendTelegramArtifactDocument(
  ctx: Context,
  input: SendArtifactDocumentInput
): Promise<SendArtifactDocumentResult> {
  if (input.bytes.byteLength > TELEGRAM_ARTIFACT_DOCUMENT_MAX_BYTES) {
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
    await ctx.api.sendDocument(
      ctx.chat.id,
      new InputFile(input.bytes, input.filename),
      threadId === undefined ? undefined : { message_thread_id: threadId }
    );
    return { ok: true };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Failed to send document.",
      ok: false,
    };
  }
}

export function formatTelegramArtifactTooLargeMessage(bytes: number): string {
  return `File is too large for Telegram (${formatMegabytes(bytes)}; max ${formatMegabytes(TELEGRAM_ARTIFACT_DOCUMENT_MAX_BYTES)}). Use the share link instead.`;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
