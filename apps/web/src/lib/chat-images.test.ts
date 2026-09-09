import { describe, expect, test } from "bun:test";
import { DOCUMENT_ATTACHMENT_ACCEPT } from "@atlas/core/message-content";
import {
  DOCUMENT_ACCEPT,
  filePartsToDocumentAttachments,
  isDocumentFilePart,
} from "./chat-images";

describe("chat document accept", () => {
  test("uses the server's document picker catalog", () => {
    expect(DOCUMENT_ACCEPT).toBe(DOCUMENT_ATTACHMENT_ACCEPT);
  });

  test.each([
    [
      "slides.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    ["table.tsv", "text/tab-separated-values"],
    ["data.json", "application/json"],
    ["records.jsonl", "application/x-ndjson"],
    ["records.ndjson", "application/x-ndjson"],
  ])(
    "recognizes %s in both typed and generic uploads and retains it for submission",
    (filename, mediaType) => {
      expect(DOCUMENT_ACCEPT.split(",")).toContain(
        `.${filename.split(".").at(-1)}`
      );
      for (const fileType of [mediaType, "application/octet-stream"]) {
        const part = {
          filename,
          mediaType: fileType,
          type: "file" as const,
          url: `data:${fileType};base64,YWJj`,
        };
        expect(isDocumentFilePart(part)).toBe(true);
        expect(filePartsToDocumentAttachments([part])).toEqual([
          { data: "YWJj", filename, mediaType },
        ]);
      }
    }
  );

  test("keeps unsupported binaries and images out of document submissions", () => {
    const files = [
      {
        filename: "program.exe",
        mediaType: "application/octet-stream",
        type: "file" as const,
        url: "data:application/octet-stream;base64,YWJj",
      },
      {
        filename: "picture.png",
        mediaType: "image/png",
        type: "file" as const,
        url: "data:image/png;base64,YWJj",
      },
    ];
    expect(files.map(isDocumentFilePart)).toEqual([false, false]);
    expect(filePartsToDocumentAttachments(files)).toEqual([]);
  });
  test("includes excel extensions and spreadsheet mime types", () => {
    expect(DOCUMENT_ACCEPT).toContain(".xlsx");
    expect(DOCUMENT_ACCEPT).toContain(".xls");
    expect(DOCUMENT_ACCEPT).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  test("includes and recognizes Markdown documents", () => {
    expect(DOCUMENT_ACCEPT).toContain(".md");
    expect(DOCUMENT_ACCEPT).toContain("text/markdown");
    expect(
      isDocumentFilePart({
        filename: "notes.md",
        mediaType: "text/markdown",
        type: "file",
        url: "data:text/markdown;base64,YWJj",
      })
    ).toBe(true);
  });

  test("recognizes xlsx file parts", () => {
    expect(
      isDocumentFilePart({
        filename: "budget.xlsx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        type: "file",
        url: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,YWJj",
      })
    ).toBe(true);
  });

  test("recognizes excel from extension when media type is generic", () => {
    expect(
      isDocumentFilePart({
        filename: "budget.xlsx",
        mediaType: "application/octet-stream",
        type: "file",
        url: "data:application/octet-stream;base64,YWJj",
      })
    ).toBe(true);
  });
});
