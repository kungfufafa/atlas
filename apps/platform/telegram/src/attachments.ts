import type { SendMessageInput } from "@atlas/core/contract";
import {
  createDownloadDeadline,
  EmptyDownloadError,
  waitForAbortable,
} from "@atlas/core/download-deadline";
import {
  isSupportedDocumentMediaType,
  MAX_DOCUMENT_BYTES,
  normalizeDocumentMediaType,
  SUPPORTED_DOCUMENT_TYPE_LABEL,
  validateDocumentAttachments,
} from "@atlas/core/message-content";
import type { Context } from "grammy";

export const UNSUPPORTED_DOCUMENT_TYPES_REPLY = `Unsupported file type. Send ${SUPPORTED_DOCUMENT_TYPE_LABEL} (max 5 MB).`;

export const OVERSIZED_FILE_REPLY = "File is too large. Maximum size is 5 MB.";

export const UNSUPPORTED_MEDIA_REPLY = `Send text, a photo, voice message, or a supported document (${SUPPORTED_DOCUMENT_TYPE_LABEL} — max 5 MB).`;

export const DOWNLOAD_FAILED_REPLY = "Could not download that file. Try again.";

export class OversizedTelegramFileError extends Error {
  constructor() {
    super("File is too large.");
    this.name = "OversizedTelegramFileError";
  }
}

export interface DownloadedTelegramFile {
  bytes: ArrayBuffer;
  contentType: string | null;
  filePath: string;
}

export interface TelegramDownloadOptions {
  idleTimeoutMs?: number;
  overallTimeoutMs?: number;
  signal?: AbortSignal;
}

function buildTelegramFileDownloadUrl(token: string, filePath: string): URL {
  const path = ["file", `bot${token}`, ...filePath.split("/").filter(Boolean)]
    .map(encodeURIComponent)
    .join("/");
  return new URL(path, "https://api.telegram.org/");
}

export async function downloadTelegramFile(
  ctx: Context,
  fileId: string,
  maxBytes: number,
  options: TelegramDownloadOptions = {}
): Promise<DownloadedTelegramFile> {
  const deadline = createDownloadDeadline(options);

  try {
    deadline.resetIdle();
    const file = await waitForAbortable(
      Promise.resolve(ctx.api.getFile(fileId)),
      deadline.signal
    );

    if (!file.file_path) {
      throw new Error("Telegram did not return a file path.");
    }

    if (file.file_size === 0) {
      throw new EmptyDownloadError();
    }

    if (file.file_size !== undefined && file.file_size > maxBytes) {
      throw new OversizedTelegramFileError();
    }

    const url = buildTelegramFileDownloadUrl(ctx.api.token, file.file_path);
    deadline.resetIdle();
    const response = await waitForAbortable(
      fetch(url, { signal: deadline.signal }),
      deadline.signal
    );

    if (!response.ok) {
      throw new Error(`Failed to download file (${response.status}).`);
    }

    assertTelegramContentLength(response, maxBytes);

    const bytes = await readResponseBodyCapped(response, maxBytes, deadline);

    return {
      bytes,
      contentType: response.headers.get("content-type"),
      filePath: file.file_path,
    };
  } finally {
    deadline.dispose();
  }
}

async function readResponseBodyCapped(
  response: Response,
  maxBytes: number,
  deadline: ReturnType<typeof createDownloadDeadline>
): Promise<ArrayBuffer> {
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
    if (!value || value.byteLength === 0) {
      continue;
    }

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new OversizedTelegramFileError();
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
}

function assertTelegramContentLength(
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
    throw new OversizedTelegramFileError();
  }
}

export type TelegramDocumentBuildResult =
  | { kind: "input"; input: SendMessageInput }
  | { kind: "reject"; message: string }
  | null;

export async function buildTelegramDocumentInput(
  ctx: Context,
  options: TelegramDownloadOptions = {}
): Promise<TelegramDocumentBuildResult> {
  const document = ctx.message?.document;

  if (!document) {
    return null;
  }

  if (document.mime_type?.startsWith("image/")) {
    return null;
  }

  const filename = document.file_name?.trim() || "document";
  const mediaType = normalizeDocumentMediaType(
    document.mime_type ?? "",
    filename
  );

  if (!isSupportedDocumentMediaType(mediaType, filename)) {
    return { kind: "reject", message: UNSUPPORTED_DOCUMENT_TYPES_REPLY };
  }

  if (
    document.file_size !== undefined &&
    document.file_size > MAX_DOCUMENT_BYTES
  ) {
    return { kind: "reject", message: OVERSIZED_FILE_REPLY };
  }

  try {
    const downloaded = await downloadTelegramFile(
      ctx,
      document.file_id,
      MAX_DOCUMENT_BYTES,
      options
    );

    const data = Buffer.from(downloaded.bytes).toString("base64");

    try {
      validateDocumentAttachments([{ data, filename, mediaType }]);
    } catch {
      return { kind: "reject", message: UNSUPPORTED_DOCUMENT_TYPES_REPLY };
    }

    // Base64 here is transport-only; the server persists bytes and stores document_ref in session history.
    return {
      input: {
        documents: [{ data, filename, mediaType }],
        message: ctx.message?.caption?.trim() ?? "",
      },
      kind: "input",
    };
  } catch (error) {
    if (error instanceof OversizedTelegramFileError) {
      return { kind: "reject", message: OVERSIZED_FILE_REPLY };
    }

    throw error;
  }
}

export function hasTelegramDocument(ctx: Context): boolean {
  return Boolean(ctx.message?.document);
}
