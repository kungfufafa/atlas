import { describe, expect, test } from "bun:test";
import { MAX_DOCUMENT_BYTES } from "@atlas/core/message-content";
import type { WAMessage } from "@whiskeysockets/baileys";
import {
  buildWhatsAppMediaInput,
  OVERSIZED_FILE_REPLY,
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
        fileLength: MAX_DOCUMENT_BYTES + 1,
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
});
