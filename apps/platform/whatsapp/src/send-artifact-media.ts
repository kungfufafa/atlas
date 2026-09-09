import {
  isSupportedImageMediaType,
  MAX_DOCUMENT_INGEST_BYTES,
  MAX_IMAGE_BYTES,
} from "@atlas/core/message-content";
import type { WASocket } from "@whiskeysockets/baileys";
import { encodeWhatsAppAudio, prepareWhatsAppVideo } from "./native-media";

/** Atlas document upload policy; native photo uploads retain the 5 MiB policy. */
export const WHATSAPP_ARTIFACT_MEDIA_MAX_BYTES = MAX_DOCUMENT_INGEST_BYTES;

export interface SendWhatsAppArtifactInput {
  asDocument?: boolean;
  beforeSend?: () => Promise<void>;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  /** An explicit request; ordinary audio attachments remain music/audio. */
  voiceNote?: boolean;
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
    if (!input.asDocument && input.mimeType.startsWith("audio/")) {
      const audio = await encodeWhatsAppAudio(
        buffer,
        input.mimeType,
        Boolean(input.voiceNote)
      );
      await input.beforeSend?.();
      await socket.sendMessage(jid, {
        audio,
        mimetype: input.voiceNote ? "audio/ogg; codecs=opus" : "audio/mpeg",
        ptt: Boolean(input.voiceNote),
      });
      return { ok: true };
    }

    if (
      !input.asDocument &&
      input.mimeType.split(";")[0]?.trim() === "video/mp4"
    ) {
      const video = await prepareWhatsAppVideo(buffer);
      await input.beforeSend?.();
      await socket.sendMessage(jid, { mimetype: "video/mp4", ...video });
      return { ok: true };
    }

    if (
      !input.asDocument &&
      isSupportedImageMediaType(input.mimeType) &&
      input.bytes.byteLength <= MAX_IMAGE_BYTES
    ) {
      await input.beforeSend?.();
      await socket.sendMessage(jid, {
        image: buffer,
        mimetype: input.mimeType,
      });
      return { ok: true };
    }

    await input.beforeSend?.();
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
  return `File is too large for Atlas WhatsApp delivery (${formatMegabytes(bytes)}; Atlas limit ${formatMegabytes(WHATSAPP_ARTIFACT_MEDIA_MAX_BYTES)}). Use the share link instead.`;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
