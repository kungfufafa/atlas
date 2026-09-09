import { AtlasApiError } from "./api-error";
import type {
  ChatMessage,
  DocumentAttachment,
  ImageAttachment,
  MessageContentPart,
  ProviderName,
} from "./contract";
import {
  extractInboundDocumentText,
  resolveUserContentForProvider,
  toAnthropicDocumentBlock,
  toOpenAIResponsesDocumentBlock,
} from "./document-content";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  TOKENS_PER_DOCUMENT_ESTIMATE,
  TOKENS_PER_IMAGE_ESTIMATE,
} from "./message-content-limits";

export {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_INGEST_BYTES,
  MAX_GENERATED_IMAGE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGES_PER_MESSAGE,
  TOKENS_PER_DOCUMENT_ESTIMATE,
  TOKENS_PER_IMAGE_ESTIMATE,
} from "./message-content-limits";
export { extractInboundDocumentText };

const ALLOWED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const STRICT_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_END_MARKER = new Uint8Array([0xff, 0xd9]);

const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLS_MEDIA_TYPE = "application/vnd.ms-excel";
const XLSM_MEDIA_TYPE = "application/vnd.ms-excel.sheet.macroEnabled.12";
const XLSB_MEDIA_TYPE = "application/vnd.ms-excel.sheet.binary.macroEnabled.12";

const ALLOWED_DOCUMENT_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/x-ndjson",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  XLSX_MEDIA_TYPE,
  XLS_MEDIA_TYPE,
  XLSM_MEDIA_TYPE,
  XLSB_MEDIA_TYPE,
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/tab-separated-values",
]);

const DOCUMENT_EXTENSION_MEDIA_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".md": "text/markdown",
  ".ndjson": "application/x-ndjson",
  ".pdf": "application/pdf",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".xls": XLS_MEDIA_TYPE,
  ".xlsb": XLSB_MEDIA_TYPE,
  ".xlsm": XLSM_MEDIA_TYPE,
  ".xlsx": XLSX_MEDIA_TYPE,
};

/** Shared browser picker and server validation catalog. Format support is harness-owned. */
export const DOCUMENT_ATTACHMENT_ACCEPT = [
  ...Object.keys(DOCUMENT_EXTENSION_MEDIA_TYPES),
  ...ALLOWED_DOCUMENT_MEDIA_TYPES,
].join(",");

export function isMessageContentPartArray(
  content: string | MessageContentPart[]
): content is MessageContentPart[] {
  return Array.isArray(content);
}

export function normalizeUserContent(
  message: string,
  images?: ImageAttachment[],
  documents?: DocumentAttachment[]
): string | MessageContentPart[] {
  const hasImages = Boolean(images?.length);
  const hasDocuments = Boolean(documents?.length);

  if (!(hasImages || hasDocuments)) {
    return message;
  }

  if (hasImages) {
    validateImageAttachments(images!);
  }

  if (hasDocuments) {
    validateDocumentAttachments(documents!);
  }

  validateCombinedAttachmentCount(images?.length ?? 0, documents?.length ?? 0);

  const parts: MessageContentPart[] = [];

  if (message.trim()) {
    parts.push({ text: message, type: "text" });
  }

  for (const image of images ?? []) {
    parts.push({
      data: image.data,
      mediaType: normalizeImageMediaType(image.mediaType),
      type: "image",
    });
  }

  for (const document of documents ?? []) {
    parts.push({
      data: document.data,
      filename: document.filename,
      mediaType: normalizeDocumentMediaType(
        document.mediaType,
        document.filename
      ),
      type: "document",
    });
  }

  if (parts.length === 0) {
    throw new AtlasApiError(
      "Message must include text or at least one attachment.",
      400
    );
  }

  return parts;
}

export function validateCombinedAttachmentCount(
  imageCount: number,
  documentCount: number
): void {
  const total = imageCount + documentCount;

  if (total > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AtlasApiError(
      `At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`,
      400
    );
  }
}

export function validateImageAttachments(images: ImageAttachment[]): void {
  if (images.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AtlasApiError(
      `At most ${MAX_ATTACHMENTS_PER_MESSAGE} images per message.`,
      400
    );
  }

  for (const image of images) {
    const mediaType = normalizeImageMediaType(image.mediaType);

    if (!ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType)) {
      throw new AtlasApiError(
        `Unsupported image type: ${image.mediaType}. Allowed: jpeg, png, gif, webp.`,
        400
      );
    }

    const bytes = validateAttachmentBytes(image.data, MAX_IMAGE_BYTES, "image");
    validateImageSignature(bytes, mediaType);
  }
}

export function validateDocumentAttachments(
  documents: DocumentAttachment[]
): void {
  if (documents.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AtlasApiError(
      `At most ${MAX_ATTACHMENTS_PER_MESSAGE} documents per message.`,
      400
    );
  }

  for (const document of documents) {
    const filename = document.filename.trim();

    if (!filename) {
      throw new AtlasApiError("Document filename must not be empty.", 400);
    }

    const mediaType = normalizeDocumentMediaType(document.mediaType, filename);

    if (!ALLOWED_DOCUMENT_MEDIA_TYPES.has(mediaType)) {
      throw new AtlasApiError(
        `Unsupported document type: ${document.mediaType}. Allowed: pdf, docx, pptx, xls, xlsx, xlsm, xlsb, csv, tsv, json, jsonl, txt, md.`,
        400
      );
    }

    validateAttachmentBytes(document.data, MAX_DOCUMENT_BYTES, "document");
  }
}

export function normalizeDocumentMediaType(
  mediaType: string,
  filename: string
): string {
  const trimmed = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

  if (ALLOWED_DOCUMENT_MEDIA_TYPES.has(trimmed)) {
    return trimmed;
  }

  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return DOCUMENT_EXTENSION_MEDIA_TYPES[extension] ?? trimmed;
}

export const SUPPORTED_DOCUMENT_TYPE_LABEL =
  "pdf, docx, pptx, xls, xlsx, xlsm, xlsb, csv, tsv, json, jsonl, txt, or md";

export function isSupportedDocumentMediaType(
  mediaType: string,
  filename: string
): boolean {
  return ALLOWED_DOCUMENT_MEDIA_TYPES.has(
    normalizeDocumentMediaType(mediaType, filename)
  );
}

export function isSpreadsheetDocumentMediaType(
  mediaType: string,
  filename: string
): boolean {
  const normalized = normalizeDocumentMediaType(mediaType, filename);

  return (
    normalized === XLSX_MEDIA_TYPE ||
    normalized === XLS_MEDIA_TYPE ||
    normalized === XLSM_MEDIA_TYPE ||
    normalized === XLSB_MEDIA_TYPE
  );
}

export function isSupportedImageMediaType(mediaType: string): boolean {
  return ALLOWED_IMAGE_MEDIA_TYPES.has(normalizeImageMediaType(mediaType));
}

export function normalizeImageMediaType(mediaType: string): string {
  const trimmed = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  return trimmed === "image/jpg" ? "image/jpeg" : trimmed;
}

function validateAttachmentBytes(
  data: string,
  maxBytes: number,
  label: string
): Uint8Array {
  return decodeBase64AttachmentData(data, label, maxBytes);
}

export function decodeBase64AttachmentData(
  data: string,
  label = "attachment",
  maxBytes?: number
): Uint8Array {
  const raw = data.trim();

  if (!raw) {
    throw new AtlasApiError(`${label} data must not be empty.`, 400);
  }

  const base64 = readBase64Payload(raw);
  if (base64 === null) {
    throw new AtlasApiError(`${label} data must be valid base64.`, 400);
  }
  if (!base64) {
    throw new AtlasApiError(`${label} data must not be empty.`, 400);
  }
  if (!STRICT_BASE64_RE.test(base64)) {
    throw new AtlasApiError(`${label} data must be valid base64.`, 400);
  }
  if (!hasCanonicalBase64Padding(base64)) {
    throw new AtlasApiError(`${label} data must be canonical base64.`, 400);
  }

  const byteLength = estimateBase64DecodedLength(base64);

  if (maxBytes !== undefined && byteLength > maxBytes) {
    throw new AtlasApiError(
      `Each ${label} must be at most ${maxBytes / (1024 * 1024)} MB.`,
      400
    );
  }

  const bytes = decodeBase64Bytes(base64, label);
  if (bytes.byteLength !== byteLength) {
    throw new AtlasApiError(`${label} data must be canonical base64.`, 400);
  }
  return bytes;
}

function decodeBase64Bytes(base64: string, label: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(base64, "base64");
  }

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new AtlasApiError(`${label} data must be valid base64.`, 400);
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function hasCanonicalBase64Padding(base64: string): boolean {
  if (base64.endsWith("==")) {
    const finalValue = BASE64_ALPHABET.indexOf(base64.at(-3) ?? "");
    return finalValue >= 0 && finalValue % 16 === 0;
  }
  if (base64.endsWith("=")) {
    const finalValue = BASE64_ALPHABET.indexOf(base64.at(-2) ?? "");
    return finalValue >= 0 && finalValue % 4 === 0;
  }
  return true;
}

function readBase64Payload(raw: string): string | null {
  if (!raw.includes(",")) {
    return raw;
  }

  const commaIndex = raw.indexOf(",");
  const metadata = raw.slice(0, commaIndex);
  const isBase64DataUrl =
    /^data:/iu.test(metadata) && /;base64$/iu.test(metadata);
  if (!isBase64DataUrl) {
    return null;
  }
  return raw.slice(commaIndex + 1);
}

function validateImageSignature(bytes: Uint8Array, mediaType: string): void {
  const dimensions = readImageDimensions(bytes, mediaType);

  if (!dimensions) {
    throw new AtlasApiError(
      `Image bytes are not a structurally valid "${mediaType}" image.`,
      400
    );
  }

  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new AtlasApiError(
      `Image dimensions are too large. Maximum: ${MAX_IMAGE_PIXELS.toLocaleString("en-US")} pixels.`,
      400
    );
  }
}

interface ImageDimensions {
  height: number;
  width: number;
}

function readImageDimensions(
  bytes: Uint8Array,
  mediaType: string
): ImageDimensions | null {
  if (mediaType === "image/png") {
    return readPngDimensions(bytes);
  }
  if (mediaType === "image/jpeg") {
    return readJpegDimensions(bytes);
  }
  if (mediaType === "image/gif") {
    return readGifDimensions(bytes);
  }
  if (mediaType === "image/webp") {
    return readWebpDimensions(bytes);
  }
  return null;
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.byteLength < 33 ||
    !bytesEqual(bytes, PNG_SIGNATURE, 0) ||
    readUInt32BE(bytes, 8) !== 13 ||
    readAscii(bytes, 12, 16) !== "IHDR"
  ) {
    return null;
  }

  const width = readUInt32BE(bytes, 16);
  const height = readUInt32BE(bytes, 20);
  let offset = 8;
  let hasEndChunk = false;

  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = readUInt32BE(bytes, offset);
    const nextOffset = offset + 12 + chunkLength;
    if (nextOffset > bytes.byteLength) {
      return null;
    }
    if (readAscii(bytes, offset + 4, offset + 8) === "IEND") {
      hasEndChunk = chunkLength === 0;
      break;
    }
    offset = nextOffset;
  }

  return width > 0 && height > 0 && hasEndChunk ? { height, width } : null;
}

function readGifDimensions(bytes: Uint8Array): ImageDimensions | null {
  const signature = readAscii(bytes, 0, 6);
  if (
    bytes.byteLength < 14 ||
    (signature !== "GIF87a" && signature !== "GIF89a") ||
    bytes.lastIndexOf(0x3b) < 13
  ) {
    return null;
  }
  const width = readUInt16LE(bytes, 6);
  const height = readUInt16LE(bytes, 8);
  return width > 0 && height > 0 ? { height, width } : null;
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let dimensions: ImageDimensions | null = null;
  let offset = 2;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    while (bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined) {
      return null;
    }
    if (marker === 0xd9) {
      return dimensions;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.byteLength) {
      return null;
    }
    const segmentLength = readUInt16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      return null;
    }
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) {
        return null;
      }
      const height = readUInt16BE(bytes, offset + 3);
      const width = readUInt16BE(bytes, offset + 5);
      if (!(width > 0 && height > 0)) {
        return null;
      }
      dimensions = { height, width };
    }
    if (marker === 0xda) {
      return dimensions &&
        indexOfBytes(bytes, JPEG_END_MARKER, offset + segmentLength) >= 0
        ? dimensions
        : null;
    }
    offset += segmentLength;
  }
  return null;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.byteLength < 30 ||
    readAscii(bytes, 0, 4) !== "RIFF" ||
    readAscii(bytes, 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const riffEnd = readUInt32LE(bytes, 4) + 8;
  const chunkLength = readUInt32LE(bytes, 16);
  if (
    riffEnd > bytes.byteLength ||
    20 + chunkLength > riffEnd ||
    chunkLength === 0
  ) {
    return null;
  }

  const chunkType = readAscii(bytes, 12, 16);
  let width = 0;
  let height = 0;
  if (chunkType === "VP8X" && chunkLength >= 10) {
    width = readUInt24LE(bytes, 24) + 1;
    height = readUInt24LE(bytes, 27) + 1;
  } else if (
    chunkType === "VP8 " &&
    chunkLength >= 10 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    width = readUInt16LE(bytes, 26) % 16_384;
    height = readUInt16LE(bytes, 28) % 16_384;
  } else if (chunkType === "VP8L" && chunkLength >= 5 && bytes[20] === 0x2f) {
    width = 1 + bytes[21]! + (bytes[22]! % 64) * 256;
    height =
      1 +
      Math.floor(bytes[22]! / 64) +
      bytes[23]! * 4 +
      (bytes[24]! % 16) * 1024;
  }

  return width > 0 && height > 0 ? { height, width } : null;
}

function bytesEqual(
  bytes: Uint8Array,
  expected: Uint8Array,
  offset: number
): boolean {
  if (offset < 0 || offset + expected.byteLength > bytes.byteLength) {
    return false;
  }
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (bytes[offset + index] !== expected[index]) {
      return false;
    }
  }
  return true;
}

function indexOfBytes(
  bytes: Uint8Array,
  expected: Uint8Array,
  fromIndex: number
): number {
  const finalStart = bytes.byteLength - expected.byteLength;
  for (let offset = Math.max(0, fromIndex); offset <= finalStart; offset += 1) {
    if (bytesEqual(bytes, expected, offset)) {
      return offset;
    }
  }
  return -1;
}

function readAscii(bytes: Uint8Array, start: number, end: number): string {
  let value = "";
  for (let index = start; index < end; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0);
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 256;
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 16_777_216 +
    (bytes[offset + 1] ?? 0) * 65_536 +
    (bytes[offset + 2] ?? 0) * 256 +
    (bytes[offset + 3] ?? 0)
  );
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    (bytes[offset + 1] ?? 0) * 256 +
    (bytes[offset + 2] ?? 0) * 65_536 +
    (bytes[offset + 3] ?? 0) * 16_777_216
  );
}

function readUInt24LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65_536
  );
}

function estimateBase64DecodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function getUserMessageText(
  content: string | MessageContentPart[]
): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter(
      (part): part is Extract<MessageContentPart, { type: "text" }> =>
        part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function countUserImages(
  content: string | MessageContentPart[]
): number {
  if (typeof content === "string") {
    return 0;
  }

  return content.filter(
    (part) => part.type === "image" || part.type === "image_ref"
  ).length;
}

export function countUserDocuments(
  content: string | MessageContentPart[]
): number {
  if (typeof content === "string") {
    return 0;
  }

  return content.filter(
    (part) => part.type === "document" || part.type === "document_ref"
  ).length;
}

export function messageContentHasImages(
  content: string | MessageContentPart[]
): boolean {
  return countUserImages(content) > 0;
}

export function messageContentHasDocuments(
  content: string | MessageContentPart[]
): boolean {
  return countUserDocuments(content) > 0;
}

export function messagesIncludeUserImages(
  messages: readonly ChatMessage[]
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" && messageContentHasImages(message.content)
  );
}

export function messagesIncludeUserDocuments(
  messages: readonly ChatMessage[]
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" && messageContentHasDocuments(message.content)
  );
}

export function estimateUserContentTokens(
  content: string | MessageContentPart[]
): number {
  const text = getUserMessageText(content);
  const textTokens = Math.ceil(text.length / 4);
  const imageTokens = countUserImages(content) * TOKENS_PER_IMAGE_ESTIMATE;
  const documentTokens =
    countUserDocuments(content) * TOKENS_PER_DOCUMENT_ESTIMATE;
  return textTokens + imageTokens + documentTokens;
}

export function stripImagesForCompaction(
  messages: readonly ChatMessage[]
): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || typeof message.content === "string") {
      return message;
    }

    const text = getUserMessageText(message.content);
    const imageCount = countUserImages(message.content);
    const documentCount = countUserDocuments(message.content);
    const suffixParts: string[] = [];

    if (imageCount > 0) {
      suffixParts.push(
        `[${imageCount} image${imageCount === 1 ? "" : "s"} omitted from summary]`
      );
    }

    if (documentCount > 0) {
      suffixParts.push(
        `[${documentCount} document${documentCount === 1 ? "" : "s"} omitted from summary]`
      );
      for (const part of message.content) {
        if (part.type === "document_ref") {
          suffixParts.push(
            `[Original file: ${JSON.stringify({ bytes: part.size, documentRef: part.attachmentId, filename: part.filename })}]`
          );
        } else if (part.type === "document") {
          suffixParts.push(
            `[Document filename: ${JSON.stringify(part.filename)}]`
          );
        }
      }
    }

    const suffix = suffixParts.length > 0 ? `\n${suffixParts.join("\n")}` : "";

    return {
      content: `${text}${suffix}`.trim() || "[attachment]",
      role: "user",
    };
  });
}

export function parseDataUrl(dataUrl: string): ImageAttachment | null {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl.trim());

  if (!match) {
    return null;
  }

  return {
    data: match[2]!,
    mediaType: normalizeImageMediaType(match[1]!),
  };
}

export function parseDocumentDataUrl(
  dataUrl: string,
  filename: string
): DocumentAttachment | null {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl.trim());

  if (!match) {
    return null;
  }

  const mediaType = normalizeDocumentMediaType(match[1]!, filename);

  return {
    data: match[2]!,
    filename,
    mediaType,
  };
}

export function toDataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

export function imageAttachmentFromBase64(
  mediaType: string,
  base64: string
): ImageAttachment {
  const data = base64.includes(",") ? (base64.split(",")[1] ?? base64) : base64;
  return { data, mediaType: normalizeImageMediaType(mediaType) };
}

export function documentAttachmentFromBase64(
  filename: string,
  mediaType: string,
  base64: string
): DocumentAttachment {
  const data = base64.includes(",") ? (base64.split(",")[1] ?? base64) : base64;
  return {
    data,
    filename,
    mediaType: normalizeDocumentMediaType(mediaType, filename),
  };
}

type ProviderContentBlock = Record<string, unknown>;

async function mapResolvedUserContent(
  content: string | MessageContentPart[],
  provider: ProviderName,
  mapText: (text: string) => ProviderContentBlock,
  mapDocument: (
    part: Extract<MessageContentPart, { type: "document" }>
  ) => ProviderContentBlock,
  mapImage: (
    part: Extract<MessageContentPart, { type: "image" }>
  ) => ProviderContentBlock
): Promise<string | ProviderContentBlock[]> {
  const resolved = await resolveUserContentForProvider(content, provider);

  if (typeof resolved === "string") {
    return resolved;
  }

  return resolved.map((part) => {
    if (part.type === "text") {
      return mapText(part.text);
    }

    if (part.type === "document") {
      return mapDocument(part);
    }

    if (part.type === "image") {
      return mapImage(part);
    }

    throw new Error(
      `Unsupported content part type: ${(part as { type: string }).type}`
    );
  });
}

export async function toAnthropicUserContent(
  content: string | MessageContentPart[],
  provider: ProviderName = "anthropic"
): Promise<string | Array<Record<string, unknown>>> {
  return mapResolvedUserContent(
    content,
    provider,
    (text) => ({ text, type: "text" }),
    (part) => toAnthropicDocumentBlock(part),
    (part) => ({
      source: {
        data: part.data,
        media_type: part.mediaType,
        type: "base64",
      },
      type: "image",
    })
  );
}

export async function toOpenAIChatUserContent(
  content: string | MessageContentPart[],
  provider: ProviderName = "openai"
): Promise<string | Array<Record<string, unknown>>> {
  return mapResolvedUserContent(
    content,
    provider,
    (text) => ({ text, type: "text" }),
    (part) => toOpenAIResponsesDocumentBlock(part, toDataUrl),
    (part) => ({
      image_url: { url: toDataUrl(part.mediaType, part.data) },
      type: "image_url",
    })
  );
}

export async function toOpenAIResponsesUserContent(
  content: string | MessageContentPart[],
  provider: ProviderName = "openai"
): Promise<string | Array<Record<string, unknown>>> {
  return mapResolvedUserContent(
    content,
    provider,
    (text) => ({ text, type: "input_text" }),
    (part) => toOpenAIResponsesDocumentBlock(part, toDataUrl),
    (part) => ({
      image_url: toDataUrl(part.mediaType, part.data),
      type: "input_image",
    })
  );
}
