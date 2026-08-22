import { isSupportedImageMediaType } from "@atlas/core/message-content";
import type { WASocket } from "@whiskeysockets/baileys";

export const WHATSAPP_ARTIFACT_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export interface SendWhatsAppArtifactInput {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface SendWhatsAppArtifactResult {
  error?: string;
  ok: boolean;
}

export async function sendWhatsAppArtifact(
  socket: WASocket | null,
  jid: string,
  input: SendWhatsAppArtifactInput
): Promise<SendWhatsAppArtifactResult> {
  if (!socket) {
    return { error: "WhatsApp is not connected.", ok: false };
  }

  if (input.bytes.byteLength > WHATSAPP_ARTIFACT_MEDIA_MAX_BYTES) {
    return {
      error: formatWhatsAppArtifactTooLargeMessage(input.bytes.byteLength),
      ok: false,
    };
  }

  const buffer = Buffer.from(input.bytes);

  try {
    if (isSupportedImageMediaType(input.mimeType)) {
      await socket.sendMessage(jid, {
        image: buffer,
        mimetype: input.mimeType,
      });
      return { ok: true };
    }

    await socket.sendMessage(jid, {
      document: buffer,
      fileName: input.filename,
      mimetype: input.mimeType,
    });
    return { ok: true };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Failed to send the file.",
      ok: false,
    };
  }
}

export function formatWhatsAppArtifactTooLargeMessage(bytes: number): string {
  return `File is too large for WhatsApp (${formatMegabytes(bytes)}; max ${formatMegabytes(WHATSAPP_ARTIFACT_MEDIA_MAX_BYTES)}). Use the share link instead.`;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
