import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { WAMessage } from "@whiskeysockets/baileys";
import {
  buildWhatsAppMediaInput,
  collectBoundedMediaStream,
  DOWNLOAD_FAILED_REPLY,
  formatExtractedWhatsAppDocumentMessage,
  formatSavedWhatsAppDocumentMessage,
  mergeWhatsAppUserMessage,
  OVERSIZED_FILE_REPLY,
  OVERSIZED_IMAGE_REPLY,
  OversizedWhatsAppMediaError,
  readWhatsAppMediaStream,
  resolveWhatsAppDocumentHandling,
  SAVE_FAILED_DOCUMENT_REPLY,
  savedWorkspaceDocumentHint,
  UNREADABLE_DOCUMENT_REPLY,
  UNSUPPORTED_DOCUMENT_TYPES_REPLY,
  UNSUPPORTED_MEDIA_REPLY,
} from "./attachments";

const tinyJpegBytes = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z",
  "base64"
);

async function* mediaChunks(chunks: Buffer[]): AsyncGenerator<Buffer> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("collectBoundedMediaStream", () => {
  test("collects chunks without exceeding the configured byte limit", async () => {
    await expect(
      collectBoundedMediaStream(
        mediaChunks([Buffer.from("hello"), Buffer.from(" world")]),
        11
      )
    ).resolves.toEqual(Buffer.from("hello world"));
  });

  test("aborts collection as soon as the byte limit is exceeded", async () => {
    await expect(
      collectBoundedMediaStream(
        mediaChunks([Buffer.alloc(6), Buffer.alloc(6)]),
        10
      )
    ).rejects.toThrow("exceeds the download limit");
  });

  test("times out a stalled media stream", async () => {
    async function* stalledStream() {
      await new Promise<void>(() => undefined);
      yield Buffer.from("never");
    }

    await expect(
      collectBoundedMediaStream(stalledStream(), 1024, 5)
    ).rejects.toThrow("timed out");
  });
});

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
    const bytes = tinyJpegBytes;
    const result = await buildWhatsAppMediaInput(
      createImageMessage({
        caption: "what is this",
        mimeType: "IMAGE/JPG; charset=binary",
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

  test("saves oversized documents of every supported type instead of extracting text", async () => {
    const cases = [
      {
        fileName: "sales.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      {
        fileName: "report.pdf",
        mimeType: "application/pdf",
      },
      {
        fileName: "notes.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      {
        fileName: "export.csv",
        mimeType: "text/csv",
      },
      {
        fileName: "readme.txt",
        mimeType: "text/plain",
      },
      {
        fileName: "notes.md",
        mimeType: "text/markdown",
      },
    ];

    for (const file of cases) {
      let extracted = false;
      const bytes = Buffer.from("extracted-source");
      const relativePath = `artifacts/${file.fileName}`;
      const result = await buildWhatsAppMediaInput(
        createDocumentMessage({
          caption: "Analyze",
          fileName: file.fileName,
          mimeType: file.mimeType,
        }),
        async () => bytes,
        {
          extractDocumentText: async () => {
            extracted = true;
            return { text: "should not run", truncated: false };
          },
          ingestMaxBytes: 100,
          inlineMaxBytes: 8,
          saveInboundDocument: async () => ({
            relativePath,
            sizeBytes: bytes.byteLength,
          }),
        }
      );

      expect(extracted).toBe(false);
      expect(result).toEqual({
        input: {
          message: formatSavedWhatsAppDocumentMessage({
            caption: "Analyze",
            filename: file.fileName,
            mediaType: file.mimeType,
            relativePath,
            sizeBytes: bytes.byteLength,
          }),
        },
        kind: "input",
      });
    }
  });

  test("rejects when saving a mid-size document fails instead of extracting text", async () => {
    let extracted = false;
    const result = await buildWhatsAppMediaInput(
      createDocumentMessage({
        caption: "Analyze",
        fileName: "sales.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      async () => Buffer.from("extracted-source"),
      {
        extractDocumentText: async () => {
          extracted = true;
          return { text: "should not run", truncated: false };
        },
        ingestMaxBytes: 100,
        inlineMaxBytes: 8,
        saveInboundDocument: async () => {
          throw new Error("disk full");
        },
      }
    );

    expect(extracted).toBe(false);
    expect(result).toEqual({
      kind: "reject",
      message: SAVE_FAILED_DOCUMENT_REPLY,
    });
  });

  test("rejects unsafe saved paths instead of extracting text", async () => {
    let extracted = false;
    const result = await buildWhatsAppMediaInput(
      createDocumentMessage({
        fileName: "sales.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      async () => Buffer.from("extracted-source"),
      {
        extractDocumentText: async () => {
          extracted = true;
          return { text: "should not run", truncated: false };
        },
        ingestMaxBytes: 100,
        inlineMaxBytes: 8,
        saveInboundDocument: async () => ({
          relativePath: "../sales.xlsx",
          sizeBytes: 16,
        }),
      }
    );

    expect(extracted).toBe(false);
    expect(result).toEqual({
      kind: "reject",
      message: SAVE_FAILED_DOCUMENT_REPLY,
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

describe("savedWorkspaceDocumentHint", () => {
  test("points spreadsheets at the spreadsheet tool and other files at extract or read", () => {
    expect(
      savedWorkspaceDocumentHint({
        filename: "sales.xlsx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        relativePath: "artifacts/sales.xlsx",
      })
    ).toContain("spreadsheet tool");
    expect(
      savedWorkspaceDocumentHint({
        filename: "export.csv",
        mediaType: "text/csv",
        relativePath: "artifacts/export.csv",
      })
    ).toContain("process the full workbook");
    expect(
      savedWorkspaceDocumentHint({
        filename: "report.pdf",
        mediaType: "application/pdf",
        relativePath: "artifacts/report.pdf",
      })
    ).toContain("extract_document_text");
    expect(
      savedWorkspaceDocumentHint({
        filename: "notes.docx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        relativePath: "artifacts/notes.docx",
      })
    ).toContain("Finish the user's request in this turn");
    expect(
      savedWorkspaceDocumentHint({
        filename: "readme.txt",
        mediaType: "text/plain",
        relativePath: "artifacts/readme.txt",
      })
    ).toContain("Read it from the profile workspace");
  });
});

describe("mergeWhatsAppUserMessage", () => {
  test("keeps saved-file instructions when the caption is repeated as chat text", () => {
    const media = formatSavedWhatsAppDocumentMessage({
      caption: "Analyze",
      filename: "sales.xlsx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      relativePath: "artifacts/sales.xlsx",
      sizeBytes: 22 * 1024 * 1024,
    });

    expect(mergeWhatsAppUserMessage("Analyze", media)).toBe(media);
    expect(mergeWhatsAppUserMessage("", media)).toBe(media);
    expect(mergeWhatsAppUserMessage("Please review", media)).toBe(
      `Please review\n\n${media}`
    );
    expect(mergeWhatsAppUserMessage("A", media)).toBe(`A\n\n${media}`);
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

describe("bounded WhatsApp media downloads", () => {
  test("destroys a stream as soon as its actual bytes exceed the cap", async () => {
    const stream = new PassThrough();
    const download = readWhatsAppMediaStream(stream, {
      idleTimeoutMs: 100,
      maxBytes: 8,
      overallTimeoutMs: 100,
    });

    stream.write(Buffer.alloc(6));
    stream.end(Buffer.alloc(6));

    await expect(download).rejects.toBeInstanceOf(OversizedWhatsAppMediaError);
    expect(stream.destroyed).toBe(true);
  });

  test("rejects zero-byte streams", async () => {
    const stream = new PassThrough();
    stream.end();

    await expect(
      readWhatsAppMediaStream(stream, {
        idleTimeoutMs: 100,
        maxBytes: 8,
        overallTimeoutMs: 100,
      })
    ).rejects.toThrow("empty");
  });

  test("destroys a stream that stalls past its idle deadline", async () => {
    const stream = new PassThrough();

    await expect(
      readWhatsAppMediaStream(stream, {
        idleTimeoutMs: 5,
        maxBytes: 8,
        overallTimeoutMs: 100,
      })
    ).rejects.toThrow("stalled");
    expect(stream.destroyed).toBe(true);
  });

  test("bounds injected downloader implementations with an overall deadline", async () => {
    const result = await buildWhatsAppMediaInput(
      createDocumentMessage({
        fileName: "report.pdf",
        mimeType: "application/pdf",
      }),
      async () => await new Promise<Buffer>(() => {}),
      { downloadOverallTimeoutMs: 5 }
    );

    expect(result).toEqual({ kind: "reject", message: DOWNLOAD_FAILED_REPLY });
  });
});
