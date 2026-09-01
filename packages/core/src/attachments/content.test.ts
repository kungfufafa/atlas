import { describe, expect, test } from "bun:test";
import {
  persistInlineAttachmentsInContent,
  rehydrateAttachmentRefsInContent,
  rehydrateMessagesForProvider,
} from "./content";

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("attachment content helpers", () => {
  test("persistInlineAttachmentsInContent converts inline parts to refs", async () => {
    const saved: Array<{ kind: string; bytes: Buffer }> = [];

    const result = await persistInlineAttachmentsInContent(
      [
        { text: "see this", type: "text" },
        {
          data: Buffer.from("png").toString("base64"),
          description: "A saved diagram.",
          mediaType: "image/png",
          type: "image",
        },
        {
          data: Buffer.from("pdf").toString("base64"),
          filename: "report.pdf",
          mediaType: "application/pdf",
          type: "document",
        },
      ],
      async (input) => {
        saved.push({ bytes: input.bytes, kind: input.kind });
        return {
          attachmentId: `att_${saved.length}`,
          size: input.bytes.byteLength,
        };
      }
    );

    expect(result).toEqual([
      { text: "see this", type: "text" },
      {
        attachmentId: "att_1",
        description: "A saved diagram.",
        mediaType: "image/png",
        size: 3,
        type: "image_ref",
      },
      {
        attachmentId: "att_2",
        filename: "report.pdf",
        mediaType: "application/pdf",
        size: 3,
        type: "document_ref",
      },
    ]);
    expect(saved).toHaveLength(2);
  });

  test("decodes data-url payloads before saving inline attachments", async () => {
    let savedBytes: Buffer | undefined;

    const result = await persistInlineAttachmentsInContent(
      [
        {
          data: `data:image/png;name=sample.png;base64,${tinyPngBase64}`,
          mediaType: " IMAGE/PNG; charset=binary ",
          type: "image",
        },
      ],
      async (input) => {
        savedBytes = input.bytes;
        return { attachmentId: "att_image", size: input.bytes.byteLength };
      }
    );

    expect(savedBytes).toEqual(Buffer.from(tinyPngBase64, "base64"));
    expect(result).toEqual([
      {
        attachmentId: "att_image",
        mediaType: "image/png",
        size: Buffer.from(tinyPngBase64, "base64").byteLength,
        type: "image_ref",
      },
    ]);
  });

  test("canonicalizes document media types when persisting refs", async () => {
    let savedMediaType = "";

    const result = await persistInlineAttachmentsInContent(
      [
        {
          data: Buffer.from("pdf").toString("base64"),
          filename: "report.PDF",
          mediaType: "application/octet-stream",
          type: "document",
        },
      ],
      async (input) => {
        savedMediaType = input.mediaType;
        return { attachmentId: "att_doc", size: input.bytes.byteLength };
      }
    );

    expect(savedMediaType).toBe("application/pdf");
    expect(result).toEqual([
      {
        attachmentId: "att_doc",
        filename: "report.PDF",
        mediaType: "application/pdf",
        size: 3,
        type: "document_ref",
      },
    ]);
  });

  test("rehydrateAttachmentRefsInContent restores inline provider parts", async () => {
    const pngBase64 = Buffer.from("png").toString("base64");
    const pdfBase64 = Buffer.from("pdf").toString("base64");

    const result = await rehydrateAttachmentRefsInContent(
      [
        {
          attachmentId: "att_img",
          description: "A restored diagram.",
          mediaType: "image/png",
          size: 3,
          type: "image_ref",
        },
        {
          attachmentId: "att_doc",
          filename: "report.pdf",
          mediaType: "application/pdf",
          size: 3,
          type: "document_ref",
        },
      ],
      async (attachmentId) => {
        if (attachmentId === "att_img") {
          return { bytes: Buffer.from("png"), mediaType: "image/png" };
        }

        return {
          bytes: Buffer.from("pdf"),
          mediaType: "application/octet-stream",
        };
      }
    );

    expect(result).toEqual([
      {
        data: pngBase64,
        description: "A restored diagram.",
        mediaType: "image/png",
        type: "image",
      },
      {
        data: pdfBase64,
        filename: "report.pdf",
        mediaType: "application/pdf",
        type: "document",
      },
    ]);
  });

  test("rehydrateMessagesForProvider leaves inline attachments unchanged", async () => {
    const inline = {
      content: [
        { text: "old", type: "text" as const },
        { data: "abc", mediaType: "image/jpeg", type: "image" as const },
      ],
      role: "user" as const,
    };

    const result = await rehydrateMessagesForProvider(
      [inline],
      async () => null
    );

    expect(result).toEqual([inline]);
  });
});
