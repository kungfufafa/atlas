import type { SendMessageInput } from "../contract";
import { waitForAbortable } from "../download-deadline";
import {
  type extractInboundDocumentText,
  isSpreadsheetDocumentMediaType,
  isSupportedDocumentMediaType,
  isSupportedImageMediaType,
  MAX_DOCUMENT_INGEST_BYTES,
  MAX_IMAGE_BYTES,
  normalizeDocumentMediaType,
  normalizeImageMediaType,
  SUPPORTED_DOCUMENT_TYPE_LABEL,
  validateImageAttachments,
} from "../message-content";

export interface SavedInboundDocument {
  relativePath: string;
  sizeBytes: number;
}

export type SaveInboundDocument = (input: {
  bytes: Buffer;
  filename: string;
  mediaType: string;
  signal?: AbortSignal;
}) => Promise<SavedInboundDocument>;

export const CHANNEL_DOCUMENT_OVERSIZED_REPLY =
  "Atlas accepts documents up to 25 MB.";
export const CHANNEL_DOCUMENT_UNSUPPORTED_REPLY = `Unsupported file type. Send ${SUPPORTED_DOCUMENT_TYPE_LABEL} (Atlas document limit: 25 MB).`;
export const CHANNEL_DOCUMENT_SAVE_FAILED_REPLY =
  "The file did not arrive in the profile workspace. Please send the attachment again.";
export const CHANNEL_DOCUMENT_UNREADABLE_REPLY =
  "The file did not arrive as a readable attachment. Please send the original file again.";

export type PreparedChannelFile =
  | { kind: "input"; input: SendMessageInput }
  | { kind: "reject"; message: string };

export function savedWorkspaceDocumentHint(input: {
  filename: string;
  mediaType: string;
  relativePath: string;
}): string {
  const mediaType = normalizeDocumentMediaType(input.mediaType, input.filename);
  const action = input.mediaType.startsWith("audio/")
    ? "Use the supplied transcript for the voice message; do not guess content from the filename."
    : isSupportedImageMediaType(input.mediaType)
      ? "Inspect the attached image bytes; do not infer its contents from the filename or caption."
      : isSpreadsheetDocumentMediaType(mediaType, input.filename) ||
          mediaType === "text/csv" ||
          mediaType === "text/tab-separated-values"
        ? "Use the spreadsheet tool to inspect and process the full workbook."
        : mediaType.startsWith("text/") ||
            mediaType === "application/json" ||
            mediaType === "application/x-ndjson"
          ? "Use read_file on this path to read the full text from the profile workspace."
          : `Use extract_document_text with documentRef ${JSON.stringify(input.relativePath)}.`;
  return `The original file is saved at ${JSON.stringify(input.relativePath)}. ${action} Preserve the source and write requested deliverables to new artifacts/ files. If a tool truncates, inspect the remaining content or state the missing coverage; do not claim a complete review from a partial result.`;
}

export function formatSavedChannelDocumentMessage(input: {
  caption: string;
  channel: string;
  filename: string;
  mediaType: string;
  relativePath: string;
  sizeBytes: number;
}): string {
  const body = `[Saved ${input.channel} file: ${input.relativePath} (${(input.sizeBytes / (1024 * 1024)).toFixed(1)} MB)]\nOriginal filename: ${JSON.stringify(input.filename)}\n${savedWorkspaceDocumentHint(input)}`;
  return [input.caption, body].filter(Boolean).join("\n\n");
}

function isSafeSavedRelativePath(relativePath: string): boolean {
  const [folder, filename, ...rest] = relativePath.split("/");
  return (
    rest.length === 0 &&
    folder === "artifacts" &&
    Boolean(filename) &&
    filename !== "." &&
    filename !== ".." &&
    !/[\\\u0000-\u001f\u007f]/.test(relativePath)
  );
}

export async function prepareChannelDocument(input: {
  bytes: Buffer;
  caption: string;
  channel: string;
  extractDocumentText?: typeof extractInboundDocumentText;
  filename: string;
  ingestMaxBytes?: number;
  inlineMaxBytes?: number;
  mediaType: string;
  saveInboundDocument?: SaveInboundDocument;
  signal?: AbortSignal;
}): Promise<PreparedChannelFile> {
  input.signal?.throwIfAborted();
  const mediaType = normalizeDocumentMediaType(input.mediaType, input.filename);
  if (!isSupportedDocumentMediaType(mediaType, input.filename)) {
    return { kind: "reject", message: CHANNEL_DOCUMENT_UNSUPPORTED_REPLY };
  }
  if (
    input.bytes.byteLength >
    Math.min(
      input.ingestMaxBytes ?? MAX_DOCUMENT_INGEST_BYTES,
      MAX_DOCUMENT_INGEST_BYTES
    )
  ) {
    return { kind: "reject", message: CHANNEL_DOCUMENT_OVERSIZED_REPLY };
  }
  if (input.bytes.byteLength === 0) {
    return { kind: "reject", message: CHANNEL_DOCUMENT_UNREADABLE_REPLY };
  }
  return saveChannelFile({ ...input, mediaType });
}

async function saveChannelFile(input: {
  bytes: Buffer;
  caption: string;
  channel: string;
  filename: string;
  mediaType: string;
  saveInboundDocument?: SaveInboundDocument;
  signal?: AbortSignal;
}): Promise<PreparedChannelFile> {
  if (!input.saveInboundDocument) {
    return { kind: "reject", message: CHANNEL_DOCUMENT_SAVE_FAILED_REPLY };
  }
  try {
    input.signal?.throwIfAborted();
    const saving = input.saveInboundDocument({
      bytes: input.bytes,
      filename: input.filename,
      mediaType: input.mediaType,
      signal: input.signal,
    });
    const saved = input.signal
      ? await waitForAbortable(saving, input.signal)
      : await saving;
    input.signal?.throwIfAborted();
    if (
      !isSafeSavedRelativePath(saved.relativePath) ||
      saved.sizeBytes !== input.bytes.byteLength
    ) {
      return { kind: "reject", message: CHANNEL_DOCUMENT_SAVE_FAILED_REPLY };
    }
    return {
      input: {
        message: formatSavedChannelDocumentMessage({ ...input, ...saved }),
      },
      kind: "input",
    };
  } catch {
    input.signal?.throwIfAborted();
    return { kind: "reject", message: CHANNEL_DOCUMENT_SAVE_FAILED_REPLY };
  }
}

/** Images retain real model bytes as well as the original workspace file. */
export async function prepareChannelImage(input: {
  bytes: Buffer;
  caption: string;
  channel: string;
  filename: string;
  mediaType: string;
  saveInboundDocument?: SaveInboundDocument;
  signal?: AbortSignal;
}): Promise<PreparedChannelFile> {
  input.signal?.throwIfAborted();
  if (!isSupportedImageMediaType(input.mediaType)) {
    return {
      kind: "reject",
      message: "Unsupported image type. Send jpg, jpeg, png, webp, or gif.",
    };
  }
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
    return { kind: "reject", message: "Atlas accepts images up to 5 MB." };
  }
  const mediaType = normalizeImageMediaType(input.mediaType);
  const images = [{ data: input.bytes.toString("base64"), mediaType }];
  try {
    validateImageAttachments(images);
  } catch {
    return {
      kind: "reject",
      message:
        "The image did not arrive as a readable attachment. Please send it again.",
    };
  }
  const saved = await saveChannelFile({ ...input, mediaType });
  if (saved.kind === "reject") {
    return saved;
  }
  return { input: { ...saved.input, images }, kind: "input" };
}

/** Persist audio already accepted by the bridge before its existing transcription call. */
export async function prepareChannelAudio(input: {
  bytes: Buffer;
  caption: string;
  channel: string;
  filename: string;
  mediaType: string;
  saveInboundDocument?: SaveInboundDocument;
  signal?: AbortSignal;
}): Promise<PreparedChannelFile> {
  input.signal?.throwIfAborted();
  if (input.bytes.byteLength > MAX_DOCUMENT_INGEST_BYTES) {
    return {
      kind: "reject",
      message: "Audio is too large. Maximum size is 25 MB.",
    };
  }
  if (input.bytes.byteLength === 0) {
    return {
      kind: "reject",
      message:
        "The audio did not arrive. Please send the voice note or audio file again.",
    };
  }
  return saveChannelFile(input);
}
