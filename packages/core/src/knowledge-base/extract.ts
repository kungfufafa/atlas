import { convertDocumentBytes, documentExtractTimeoutMs } from "../anydoc-text";
import { DOCX_MEDIA_TYPE, LEGACY_DOC_MEDIA_TYPE } from "../artifact-mime";
import { convertDocxToMarkdown } from "../docx-text";
import { MAX_DOCUMENT_BYTES } from "../message-content";
import {
  KNOWLEDGE_BASE_ALLOWED_MEDIA_TYPES,
  KNOWLEDGE_BASE_PLAIN_TEXT_MEDIA_TYPES,
  KNOWLEDGE_BASE_SUPPORTED_TYPE_LABEL,
  normalizeKnowledgeBaseMediaType,
} from "./formats";

export {
  isKnowledgeBaseFilename,
  isSupportedKnowledgeBaseMediaType,
  KNOWLEDGE_BASE_ACCEPT,
  KNOWLEDGE_BASE_ALLOWED_MEDIA_TYPES,
  KNOWLEDGE_BASE_EXTENSION_MEDIA_TYPES,
  KNOWLEDGE_BASE_PLAIN_TEXT_MEDIA_TYPES,
  KNOWLEDGE_BASE_SUPPORTED_TYPE_LABEL,
  normalizeKnowledgeBaseMediaType,
} from "./formats";

export async function extractText(
  mediaType: string,
  filename: string,
  bytes: Buffer
): Promise<string> {
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    throw new Error(
      `Document must be at most ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB.`
    );
  }

  const normalized = normalizeKnowledgeBaseMediaType(mediaType, filename);

  if (!KNOWLEDGE_BASE_ALLOWED_MEDIA_TYPES.has(normalized)) {
    throw new Error(
      `Unsupported knowledge base document type: ${mediaType}. Allowed: ${KNOWLEDGE_BASE_SUPPORTED_TYPE_LABEL}.`
    );
  }

  // Word-named uploads are decided by their bytes: a real .docx, a legacy OLE .doc
  // (rejected with an actionable message), or HTML saved under a Word extension.
  if (normalized === DOCX_MEDIA_TYPE || normalized === LEGACY_DOC_MEDIA_TYPE) {
    return convertDocxToMarkdown(bytes);
  }

  if (KNOWLEDGE_BASE_PLAIN_TEXT_MEDIA_TYPES.has(normalized)) {
    return bytes.toString("utf8").trim();
  }

  // PDF, PPTX, and the spreadsheet family (xlsx/xls/xlsm/xlsb) go through the
  // shared document converter, matching the channel attachment extraction path.
  const { text } = await convertDocumentBytes(bytes, {
    filename,
    mediaType: normalized,
    timeoutMs: documentExtractTimeoutMs(bytes.length),
  });
  return text;
}

export function buildExtractedTextHeader(options: {
  filename: string;
  mediaType: string;
  uploadedAt: string;
}): string {
  return [
    `# source: ${options.filename}`,
    `# mediaType: ${options.mediaType}`,
    `# uploadedAt: ${options.uploadedAt}`,
    "",
  ].join("\n");
}
