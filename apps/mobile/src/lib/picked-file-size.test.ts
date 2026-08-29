import { afterEach, expect, mock, test } from "bun:test";
import { MAX_DOCUMENT_BYTES } from "@atlas/core/message-content-limits";

const getInfoAsync = mock(async (_uri: string) => ({
  exists: true as const,
  isDirectory: false,
  size: 0,
  uri: _uri,
}));

mock.module("expo-file-system/legacy", () => ({ getInfoAsync }));

const {
  assertDataImportArchiveSize,
  assertPickedDataImportArchiveSize,
  assertPickedDocumentSize,
  MAX_DATA_IMPORT_ARCHIVE_BYTES,
} = await import("./picked-file-size");

afterEach(() => {
  getInfoAsync.mockClear();
  getInfoAsync.mockResolvedValue({
    exists: true,
    isDirectory: false,
    size: 0,
    uri: "file:///fallback",
  });
});

test("rejects an oversized picked document before reading it", async () => {
  await expect(
    assertPickedDocumentSize({
      size: MAX_DOCUMENT_BYTES + 1,
      uri: "file:///large.pdf",
    })
  ).rejects.toThrow("Files must be at most 5 MB.");

  expect(getInfoAsync).not.toHaveBeenCalled();
});

test("uses local metadata when the picker omits a document size", async () => {
  getInfoAsync.mockResolvedValueOnce({
    exists: true,
    isDirectory: false,
    size: MAX_DOCUMENT_BYTES + 1,
    uri: "file:///large.pdf",
  });

  await expect(
    assertPickedDocumentSize({ uri: "file:///large.pdf" })
  ).rejects.toThrow("Files must be at most 5 MB.");

  expect(getInfoAsync).toHaveBeenCalledWith("file:///large.pdf");
});

test("rejects a file whose size cannot be determined", async () => {
  getInfoAsync.mockResolvedValueOnce({
    exists: false,
    isDirectory: false,
    uri: "file:///unknown.pdf",
  });

  await expect(
    assertPickedDocumentSize({ uri: "file:///unknown.pdf" })
  ).rejects.toThrow("Could not determine the selected file size.");
});

test("uses the server's compressed data-import archive limit", async () => {
  await expect(
    assertPickedDataImportArchiveSize({
      size: MAX_DATA_IMPORT_ARCHIVE_BYTES + 1,
      uri: "file:///large.zip",
    })
  ).rejects.toThrow("Import archives must be at most 64 MiB.");

  expect(() =>
    assertDataImportArchiveSize(MAX_DATA_IMPORT_ARCHIVE_BYTES)
  ).not.toThrow();
});
