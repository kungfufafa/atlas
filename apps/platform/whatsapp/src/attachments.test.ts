import { describe, expect, test } from "bun:test";
import type { WAMessage } from "@whiskeysockets/baileys";
import {
  buildWhatsAppMediaInput,
  formatExtractedWhatsAppDocumentMessage,
  OVERSIZED_FILE_REPLY,
  OVERSIZED_IMAGE_REPLY,
  resolveWhatsAppDocumentHandling,
  UNREADABLE_DOCUMENT_REPLY,
  UNSUPPORTED_DOCUMENT_TYPES_REPLY,
  UNSUPPORTED_MEDIA_REPLY,
} from "./attachments";

function createDocumentMessage(options: {
  caption?: string;
  fileLength?: number;
  fileName?: string;
  mimeType?: string;
}): WAMessage {
  return {
    key: {
      fromMe: false,
      id: "msg-1",
      remoteJid: "6281234567890@s.whatsapp.net",
    },
    message: {
      documentMessage: {
        caption: options.caption,
        fileLength: options.fileLength,
        fileName: options.fileName,
        mimetype: options.mimeType,
      },
    },
  };
}

function createImageMessage(options: {
  caption?: string;
  mimeType?: string;
}): WAMessage {
  return {
    key: {
      fromMe: false,
      id: "msg-2",
      remoteJid: "6281234567890@s.whatsapp.net",
    },
    message: {
      imageMessage: {
        caption: options.caption,
        mimetype: options.mimeType,
      },
    },
  };
}

describe("buildWhatsAppMediaInput", () => {
  test("forwards a pdf document with caption", async () => {
    const bytes = Buffer.from("pdf-bytes");
    const result = await buildWhatsAppMediaInput(
      createDocumentMessage({
        caption: "Summarize this",
        fileName: "report.pdf",
        mimeType: "application/pdf",
      }),
      async () => bytes
    );

    expect(result).toEqual({
      input: {
        documents: [
          {
            data: bytes.toString("base64"),
            filename: "report.pdf",
            mediaType: "application/pdf",
          },
        ],
        message: "Summarize this",
      },
      kind: "input",
    });
  });

  test("accepts xlsx documents", async () => {
    const bytes = Buffer.from("xlsx-bytes");
    const result = await buildWhatsAppMediaInput(
      createDocumentMessage({
        caption: "Analyze",
        fileName: "sales.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      async () => bytes
    );

    expect(result).toEqual({
      input: {
        documents: [
          {
            data: bytes.toString("base64"),
            filename: "sales.xlsx",
            mediaType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        ],
        message: "Analyze",
      },
      kind: "input",
    });
  });

  test("accepts txt via filename when mime is octet-stream", async () => {
    const bytes = Buffer.from("notes");
    const result = await buildWhatsAppMediaInput(
      createDocumentMessage({
        fileName: "notes.txt",
        mimeType: "application/octet-stream",
      }),
      async () => bytes
    );

    expect(result).toEqual({
      input: {
        documents: [
          {
            data: bytes.toString("base64"),
            filename: "notes.txt",
            mediaType: "text/plain",
          },
        ],
        message: "",
      },
      kind: "input",
    });
  });

  test("rejects heic images instead of relabeling them as jpeg", async () => {
    let downloaded = false;
    const result = await buildWhatsAppMediaInput(
      createImageMessage({
        caption: "photo",
        mimeType: "image/heic",
      }),
      async () => {
        downloaded = true;
        return Buffer.from("heic");
      }
    );

    expect(downloaded).toBe(false);
    expect(result).toEqual({
      kind: "reject",
      message: UNSUPPORTED_MEDIA_REPLY,
    });
  });

  test("forwards a jpeg photo", async () => {
    const bytes = Buffer.from("fake-jpeg");
    const result = await buildWhatsAppMediaInput(
      createImageMessage({
        caption: "what is this",
        mimeType: "image/jpeg",
      }),
      async () => bytes
    );

    expect(result).toEqual({
      input: {
        images: [{ data: bytes.toString("base64"), mediaType: "image/jpeg" }],
        message: "what is this",
      },
      kind: "input",
    });
  });

  test("rejects unsupported documents before downloading", async () => {
    let downloaded = false;
    const result = await buildWhatsAppMediaInput(
      createDocumentMessage({
        fileName: "archive.zip",
        mimeType: "application/zip",
      }),
      async () => {
        downloaded = true;
        return Buffer.from("zip");
      }
    );

    expect(downloaded).toBe(false);
    expect(result).toEqual({
      kind: "reject",
      message: UNSUPPORTED_DOCUMENT_TYPES_REPLY,
    });
  });

  test("rejects oversized documents from the declared file length", async () => {
    let downloaded = false;
    const result = await buildWhatsAppMediaInput(
      createDocumentMessage({
        fileLength: 26 * 1024 * 1024,
        fileName: "report.pdf",
        mimeType: "application/pdf",
      }),
      async () => {
        downloaded = true;
        return Buffer.from("pdf");
      }
    );

    expect(downloaded).toBe(false);
    expect(result).toEqual({
      kind: "reject",
      message: OVERSIZED_FILE_REPLY,
    });
  });

  test("extracts text from documents larger than the inline limit", async () => {
    const bytes = Buffer.from("extracted-source");
    const result = await buildWhatsAppMediaInput(
      createDocumentMessage({
        caption: "Summarize this",
        fileName: "report.pdf",
        mimeType: "application/pdf",
      }),
      async () => bytes,
      {
        extractDocumentText: async () => ({
          text: "Quarterly revenue rose.",
          truncated: false,
        }),
        ingestMaxBytes: 100,
        inlineMaxBytes: 8,
      }
    );

    expect(result).toEqual({
      input: {
        message: formatExtractedWhatsAppDocumentMessage({
          caption: "Summarize this",
          filename: "report.pdf",
          text: "Quarterly revenue rose.",
          truncated: false,
        }),
      },
      kind: "input",
    });
  });

  test("rejects extracted documents with no readable text", async () => {
    const result = await buildWhatsAppMediaInput(
      createDocumentMessage({
        fileName: "scan.pdf",
        mimeType: "application/pdf",
      }),
      async () => Buffer.from("scanned"),
      {
        extractDocumentText: async () => ({ text: "  ", truncated: false }),
        ingestMaxBytes: 100,
        inlineMaxBytes: 4,
      }
    );

    expect(result).toEqual({
      kind: "reject",
      message: UNREADABLE_DOCUMENT_REPLY,
    });
  });

  test("rejects oversized photos from the declared file length", async () => {
    let downloaded = false;
    const result = await buildWhatsAppMediaInput(
      {
        key: {
          fromMe: false,
          id: "msg-3",
          remoteJid: "6281234567890@s.whatsapp.net",
        },
        message: {
          imageMessage: {
            fileLength: 6 * 1024 * 1024,
            mimetype: "image/jpeg",
          },
        },
      },
      async () => {
        downloaded = true;
        return Buffer.from("jpeg");
      }
    );

    expect(downloaded).toBe(false);
    expect(result).toEqual({
      kind: "reject",
      message: OVERSIZED_IMAGE_REPLY,
    });
  });
});

describe("resolveWhatsAppDocumentHandling", () => {
  test("keeps small files inline, extracts mid-size files, and rejects huge files", () => {
    const limits = { ingestMaxBytes: 25, inlineMaxBytes: 5 };

    expect(resolveWhatsAppDocumentHandling(5, limits)).toBe("inline");
    expect(resolveWhatsAppDocumentHandling(6, limits)).toBe("extract");
    expect(resolveWhatsAppDocumentHandling(25, limits)).toBe("extract");
    expect(resolveWhatsAppDocumentHandling(26, limits)).toBe("reject");
  });
});
