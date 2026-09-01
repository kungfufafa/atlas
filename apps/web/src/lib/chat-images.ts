import type {
  DocumentAttachment,
  ImageAttachment,
  MessageContentPart,
} from "@atlas/core/contract";
import {
  isImageDescriptionText,
  parseImageDescriptionText,
} from "@atlas/core/image-content";
import {
  normalizeDocumentMediaType,
  normalizeImageMediaType,
  parseDataUrl,
  parseDocumentDataUrl,
} from "@atlas/core/message-content";
import type { FileUIPart } from "ai";
import {
  type DisplayDocument,
  documentDisplayFromContentPart,
  documentDisplayFromFilePart,
} from "@/lib/pasted-text";

export type AttachmentUrlResolver = (
  attachmentId: string,
  inline: boolean
) => string;

export const IMAGE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";

export const DOCUMENT_ACCEPT =
  ".pdf,.docx,.xls,.xlsx,.xlsm,.xlsb,.csv,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.ms-excel.sheet.binary.macroEnabled.12,text/plain,text/csv,text/markdown";

export const ALL_ATTACHMENT_ACCEPT = `${IMAGE_ACCEPT},${DOCUMENT_ACCEPT}`;

const DOCUMENT_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  "text/plain",
  "text/csv",
  "text/markdown",
]);

export function isImageFilePart(file: FileUIPart): boolean {
  return normalizeImageMediaType(file.mediaType ?? "").startsWith("image/");
}

export function isDocumentFilePart(file: FileUIPart): boolean {
  if (isImageFilePart(file)) {
    return false;
  }

  const filename = file.filename ?? "";
  const mediaType = normalizeDocumentMediaType(file.mediaType ?? "", filename);
  return DOCUMENT_MEDIA_TYPES.has(mediaType);
}

export function filePartsToImageAttachments(
  files: FileUIPart[]
): ImageAttachment[] {
  const images: ImageAttachment[] = [];

  for (const file of files) {
    if (!isImageFilePart(file)) {
      continue;
    }

    const parsed = parseDataUrl(file.url);

    if (parsed) {
      images.push(parsed);
    }
  }

  return images;
}

export function filePartsToDocumentAttachments(
  files: FileUIPart[]
): DocumentAttachment[] {
  const documents: DocumentAttachment[] = [];

  for (const file of files) {
    if (!isDocumentFilePart(file)) {
      continue;
    }

    const filename = file.filename?.trim() || "document";
    const parsed = parseDocumentDataUrl(file.url, filename);

    if (parsed) {
      documents.push(parsed);
    }
  }

  return documents;
}

export function userContentToDisplayImages(
  content: string | MessageContentPart[],
  resolveAttachmentUrl?: AttachmentUrlResolver
): Array<{ url: string; mediaType: string }> {
  if (typeof content === "string") {
    return [];
  }

  const images: Array<{ url: string; mediaType: string }> = [];

  for (const part of content) {
    if (part.type === "image" && !part.description?.trim()) {
      images.push({
        mediaType: part.mediaType,
        url: `data:${part.mediaType};base64,${part.data}`,
      });
      continue;
    }

    if (
      part.type === "image_ref" &&
      !part.description?.trim() &&
      resolveAttachmentUrl
    ) {
      images.push({
        mediaType: part.mediaType,
        url: resolveAttachmentUrl(part.attachmentId, true),
      });
    }
  }

  return images;
}

export interface DisplayImageAttachment {
  description?: string | null;
  mediaType: string;
  url?: string;
}

export function userContentToDisplayImageAttachments(
  content: string | MessageContentPart[],
  resolveAttachmentUrl?: AttachmentUrlResolver
): DisplayImageAttachment[] {
  const attachments: DisplayImageAttachment[] = [];

  if (typeof content === "string") {
    if (isImageDescriptionText(content)) {
      attachments.push({
        description: parseImageDescriptionText(content),
        mediaType: "image/unknown",
      });
    }

    return attachments;
  }

  for (const part of content) {
    if (part.type === "image" && part.description?.trim()) {
      attachments.push({
        description: part.description.trim(),
        mediaType: part.mediaType,
        url: `data:${part.mediaType};base64,${part.data}`,
      });
      continue;
    }

    if (part.type === "image_ref" && part.description?.trim()) {
      attachments.push({
        description: part.description.trim(),
        mediaType: part.mediaType,
        url: resolveAttachmentUrl?.(part.attachmentId, true),
      });
      continue;
    }

    if (part.type === "image_ref" && !resolveAttachmentUrl) {
      attachments.push({
        mediaType: part.mediaType,
      });
      continue;
    }

    if (part.type === "text" && isImageDescriptionText(part.text)) {
      attachments.push({
        description: parseImageDescriptionText(part.text),
        mediaType: "image/unknown",
      });
    }
  }

  return attachments;
}

export function stripImageDescriptionsFromDisplayText(
  content: string | MessageContentPart[]
): string {
  if (typeof content === "string") {
    return isImageDescriptionText(content) ? "" : content;
  }

  return content
    .filter(
      (part): part is Extract<MessageContentPart, { type: "text" }> =>
        part.type === "text" && !isImageDescriptionText(part.text)
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function filePartsToDisplayDocuments(
  files: FileUIPart[]
): DisplayDocument[] {
  const documents: DisplayDocument[] = [];

  for (const file of files) {
    if (!isDocumentFilePart(file)) {
      continue;
    }

    documents.push(documentDisplayFromFilePart(file));
  }

  return documents;
}

export function userContentToDisplayDocuments(
  content: string | MessageContentPart[],
  resolveAttachmentUrl?: AttachmentUrlResolver
): DisplayDocument[] {
  if (typeof content === "string") {
    return [];
  }

  const documents: DisplayDocument[] = [];

  for (const part of content) {
    if (part.type === "document") {
      documents.push(documentDisplayFromContentPart(part));
      continue;
    }

    if (part.type === "document_ref") {
      documents.push({
        filename: part.filename,
        mediaType: part.mediaType,
        url: resolveAttachmentUrl?.(part.attachmentId, false),
      });
    }
  }

  return documents;
}
