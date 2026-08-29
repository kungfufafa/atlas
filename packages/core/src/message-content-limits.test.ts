import { expect, test } from "bun:test";
import {
  MAX_ATTACHMENTS_PER_MESSAGE as messageContentAttachmentLimit,
  MAX_DOCUMENT_BYTES as messageContentDocumentLimit,
  MAX_IMAGE_BYTES as messageContentImageLimit,
} from "./message-content";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
} from "./message-content-limits";

test("exports attachment limits through both the pure and legacy modules", () => {
  expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(5);
  expect(MAX_DOCUMENT_BYTES).toBe(5 * 1024 * 1024);
  expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  expect(messageContentAttachmentLimit).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
  expect(messageContentDocumentLimit).toBe(MAX_DOCUMENT_BYTES);
  expect(messageContentImageLimit).toBe(MAX_IMAGE_BYTES);
});
