import {
  prepareChannelAudio,
  type SaveInboundDocument,
} from "@atlas/core/attachments/inbound-document";
import type { SendMessageInput } from "@atlas/core/contract";
import {
  throwIfSignalAborted,
  waitForAbortable,
} from "@atlas/core/download-deadline";
import type { WAMessage } from "@whiskeysockets/baileys";
import {
  downloadWhatsAppMediaWithinDeadline,
  OversizedWhatsAppMediaError,
  type WhatsAppMediaDownload,
} from "./attachments";
import { inspectInboundWhatsAppMedia } from "./inbound-message";

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export const OVERSIZED_AUDIO_REPLY =
  "Audio is too large. Maximum size is 25 MB.";

export const AUDIO_DOWNLOAD_FAILED_REPLY =
  "Could not download that voice note. Try again.";

export const AUDIO_TRANSCRIBE_FAILED_REPLY =
  "Could not transcribe that voice note. Try again or send text.";

export type WhatsAppAudioTranscribe = (input: {
  data: string;
  filename: string;
  mediaType: string;
}) => Promise<{ text: string }>;

export interface WhatsAppAudioInputOptions {
  caption?: string;
  downloadOverallTimeoutMs?: number;
  saveInboundDocument?: SaveInboundDocument;
  signal?: AbortSignal;
}

export async function buildWhatsAppAudioInput(
  inbound: WAMessage,
  download: WhatsAppMediaDownload,
  transcribe: WhatsAppAudioTranscribe,
  options: WhatsAppAudioInputOptions = {}
): Promise<
  | { kind: "input"; input: SendMessageInput }
  | { kind: "reject"; message: string }
> {
  const media = inspectInboundWhatsAppMedia(inbound.message);
  if (media?.kind !== "audio") {
    return { kind: "reject", message: AUDIO_DOWNLOAD_FAILED_REPLY };
  }

  if (media.fileLength !== null && media.fileLength > MAX_AUDIO_BYTES) {
    return { kind: "reject", message: OVERSIZED_AUDIO_REPLY };
  }

  let bytes: Buffer;
  try {
    bytes = await downloadWhatsAppMediaWithinDeadline(download, inbound, {
      maxBytes: MAX_AUDIO_BYTES,
      overallTimeoutMs: options.downloadOverallTimeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throwIfSignalAborted(options.signal);
    }
    if (error instanceof OversizedWhatsAppMediaError) {
      return { kind: "reject", message: OVERSIZED_AUDIO_REPLY };
    }
    return { kind: "reject", message: AUDIO_DOWNLOAD_FAILED_REPLY };
  }

  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
    return { kind: "reject", message: AUDIO_DOWNLOAD_FAILED_REPLY };
  }

  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    return { kind: "reject", message: OVERSIZED_AUDIO_REPLY };
  }

  const mediaType = inferAudioMediaType(media.mimetype, media.filename);
  const prepared = await prepareChannelAudio({
    bytes,
    caption: options.caption ?? media.caption,
    channel: "WhatsApp",
    filename: media.filename,
    mediaType,
    saveInboundDocument: options.saveInboundDocument,
    signal: options.signal,
  });
  if (prepared.kind === "reject") {
    return prepared;
  }

  try {
    const transcription = transcribe({
      data: bytes.toString("base64"),
      filename: media.filename,
      mediaType,
    });
    const { text } = options.signal
      ? await waitForAbortable(transcription, options.signal)
      : await transcription;
    const transcript = text.trim();
    if (!transcript) {
      return { kind: "reject", message: AUDIO_TRANSCRIBE_FAILED_REPLY };
    }

    return {
      input: { message: `${transcript}\n\n${prepared.input.message}` },
      kind: "input",
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throwIfSignalAborted(options.signal);
    }
    if (error instanceof Error && error.message.trim()) {
      return { kind: "reject", message: error.message };
    }

    return { kind: "reject", message: AUDIO_TRANSCRIBE_FAILED_REPLY };
  }
}

function inferAudioMediaType(mimetype: string, filename: string): string {
  const trimmed = mimetype.split(";")[0]?.trim().toLowerCase() ?? "";
  if (trimmed.startsWith("audio/")) {
    return trimmed;
  }

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
