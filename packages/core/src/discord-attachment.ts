import { inferArtifactMimeType, normalizeMimeType } from "./artifact-mime";

/** Conservative Atlas Discord upload policy, not the platform maximum (issue #200). */
export const DISCORD_ARTIFACT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

const DISCORD_ATTACHABLE_EXTENSIONS = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "txt",
  "csv",
  "tsv",
  "md",
  "markdown",
  "json",
  "jsonl",
  "zip",
  "docx",
  "xls",
  "xlsx",
  "pptx",
  "html",
  "htm",
]);

const DISCORD_ATTACHABLE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/markdown",
  "application/json",
  "application/x-ndjson",
  "application/jsonl",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/html",
  "application/xhtml+xml",
]);

export function isDiscordAttachableArtifact(input: {
  filename: string;
  mimeType?: string;
}): boolean {
  const extension = fileExtension(input.filename);
  if (extension && DISCORD_ATTACHABLE_EXTENSIONS.has(extension)) {
    return true;
  }

  const mimeType =
    normalizeMimeType(input.mimeType ?? "") ||
    inferArtifactMimeType(input.filename);
  return DISCORD_ATTACHABLE_MIME_TYPES.has(mimeType);
}

export function formatDiscordAttachmentSizeLimitMessage(
  sizeBytes: number
): string {
  return `File is too large for Discord (${formatMegabytes(sizeBytes)}; max ${formatMegabytes(DISCORD_ARTIFACT_ATTACHMENT_MAX_BYTES)}). Use the share link instead.`;
}

export function formatDiscordUnsupportedAttachmentMessage(input: {
  filename: string;
  mimeType?: string;
}): string {
  const extension = fileExtension(input.filename);
  const typeLabel = extension
    ? `.${extension}`
    : input.mimeType?.trim() || "unknown";
  return `Unsupported file type for Discord attachment (${typeLabel}). Supported: PDF, images (PNG/JPEG/GIF/WebP), text, CSV, ZIP, and common document types.`;
}

function fileExtension(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? filename;
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === basename.length - 1) {
    return "";
  }
  return basename.slice(dotIndex + 1).toLowerCase();
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
