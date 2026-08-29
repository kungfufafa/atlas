export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_IMAGES_PER_MESSAGE = MAX_ATTACHMENTS_PER_MESSAGE;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 64_000_000;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
/** Store/extract ceiling for channel ingest (WhatsApp documents, extract_document_text). */
export const MAX_DOCUMENT_INGEST_BYTES = 25 * 1024 * 1024;
export const TOKENS_PER_IMAGE_ESTIMATE = 1500;
export const TOKENS_PER_DOCUMENT_ESTIMATE = 2000;
