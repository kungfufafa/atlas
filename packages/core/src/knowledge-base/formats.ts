/**
 * Knowledge base format catalog — a pure module (no Node or heavy runtime
 * imports) so web and mobile pickers can share the same allowlist the server
 * enforces at upload time.
 */
import { DOCX_MEDIA_TYPE, LEGACY_DOC_MEDIA_TYPE } from "../artifact-mime";

export const KB_PDF_MEDIA_TYPE = "application/pdf";
export const KB_PPTX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const KB_XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const KB_XLS_MEDIA_TYPE = "application/vnd.ms-excel";
export const KB_XLSM_MEDIA_TYPE =
  "application/vnd.ms-excel.sheet.macroEnabled.12";
export const KB_XLSB_MEDIA_TYPE =
  "application/vnd.ms-excel.sheet.binary.macroEnabled.12";

/** Formats stored and extracted verbatim as UTF-8 text. */
export const KNOWLEDGE_BASE_PLAIN_TEXT_MEDIA_TYPES: ReadonlySet<string> =
  new Set([
    "application/json",
    "application/x-ndjson",
    "text/csv",
    "text/markdown",
    "text/plain",
    "text/tab-separated-values",
  ]);

/** Spreadsheet formats extracted through the shared document converter. */
export const KNOWLEDGE_BASE_SPREADSHEET_MEDIA_TYPES: ReadonlySet<string> =
  new Set([
    KB_XLSX_MEDIA_TYPE,
    KB_XLS_MEDIA_TYPE,
    KB_XLSM_MEDIA_TYPE,
    KB_XLSB_MEDIA_TYPE,
  ]);

export const KNOWLEDGE_BASE_EXTENSION_MEDIA_TYPES: Readonly<
  Record<string, string>
> = {
  ".csv": "text/csv",
  ".doc": LEGACY_DOC_MEDIA_TYPE,
  ".docx": DOCX_MEDIA_TYPE,
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".md": "text/markdown",
  ".ndjson": "application/x-ndjson",
  ".pdf": KB_PDF_MEDIA_TYPE,
  ".pptx": KB_PPTX_MEDIA_TYPE,
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".xls": KB_XLS_MEDIA_TYPE,
  ".xlsb": KB_XLSB_MEDIA_TYPE,
  ".xlsm": KB_XLSM_MEDIA_TYPE,
  ".xlsx": KB_XLSX_MEDIA_TYPE,
};

export const KNOWLEDGE_BASE_ALLOWED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  KB_PDF_MEDIA_TYPE,
  DOCX_MEDIA_TYPE,
  LEGACY_DOC_MEDIA_TYPE,
  KB_PPTX_MEDIA_TYPE,
  ...KNOWLEDGE_BASE_SPREADSHEET_MEDIA_TYPES,
  ...KNOWLEDGE_BASE_PLAIN_TEXT_MEDIA_TYPES,
]);

export const KNOWLEDGE_BASE_SUPPORTED_TYPE_LABEL =
  "pdf, docx, pptx, xlsx, xls, xlsm, xlsb, csv, tsv, json, jsonl, txt, md";

/** Shared browser/document picker catalog matching the server allowlist. */
export const KNOWLEDGE_BASE_ACCEPT = [
  ...Object.keys(KNOWLEDGE_BASE_EXTENSION_MEDIA_TYPES),
  ...KNOWLEDGE_BASE_ALLOWED_MEDIA_TYPES,
].join(",");

export function normalizeKnowledgeBaseMediaType(
  mediaType: string,
  filename: string
): string {
  const trimmed = mediaType.trim().toLowerCase();
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const fromExtension = KNOWLEDGE_BASE_EXTENSION_MEDIA_TYPES[extension];

  if (fromExtension) {
    return fromExtension;
  }

  return trimmed;
}

export function isSupportedKnowledgeBaseMediaType(
  mediaType: string,
  filename: string
): boolean {
  const normalized = normalizeKnowledgeBaseMediaType(mediaType, filename);
  return KNOWLEDGE_BASE_ALLOWED_MEDIA_TYPES.has(normalized);
}

export function isKnowledgeBaseFilename(filename: string): boolean {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return extension in KNOWLEDGE_BASE_EXTENSION_MEDIA_TYPES;
}
