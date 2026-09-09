import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SaveInboundDocument } from "@atlas/core/attachments/inbound-document";
import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_INGEST_BYTES,
} from "@atlas/core/message-content";
import type { Context } from "grammy";
import {
  buildTelegramDocumentInput,
  downloadTelegramFile,
  OVERSIZED_FILE_REPLY,
  OversizedTelegramFileError,
  TELEGRAM_HOSTED_FILE_LIMIT_REPLY,
  UNSUPPORTED_DOCUMENT_TYPES_REPLY,
} from "./attachments";
import { downloadTelegramImage } from "./images";

const saveInboundDocument: SaveInboundDocument = async (file) => ({
  relativePath: `artifacts/${file.filename}`,
  sizeBytes: file.bytes.length,
});

function createDocumentContext(options: {
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  caption?: string;
  fileSize?: number;
}): Context {
  return {
    api: {
      getFile: async () => ({
        file_path: "documents/report.pdf",
        file_size: options.fileSize,
      }),
      token: "test-token",
    },
    message: {
      caption: options.caption,
      document: {
        file_id: options.fileId ?? "file-1",
        file_name: options.fileName,
        file_size: options.fileSize,
        mime_type: options.mimeType,
      },
    },
  } as unknown as Context;
}

describe("buildTelegramDocumentInput", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  test("accepts pdf with caption", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("pdf-bytes", {
        headers: { "content-type": "application/pdf" },
      })
    );

    const result = await buildTelegramDocumentInput(
      createDocumentContext({
        caption: "Summarize this",
        fileName: "report.pdf",
        mimeType: "application/pdf",
      }),
      { saveInboundDocument }
    );

    expect(result?.kind).toBe("input");
    if (result?.kind === "input") {
      expect(result.input.documents).toBeUndefined();
      expect(result.input.message).toContain("Summarize this");
      expect(result.input.message).toContain("artifacts/report.pdf");
      expect(result.input.message).toContain("extract_document_text");
      expect(result.input.message).not.toContain("pdf-bytes");
    }
  });

  test("canonicalizes an image content-type alias", async () => {
    const jpegBytes = Buffer.from(
      "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z",
      "base64"
    );
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(jpegBytes, {
        headers: { "content-type": "IMAGE/JPG; charset=binary" },
      })
    );

    const image = await downloadTelegramImage(
      createDocumentContext({ fileName: "photo.jpg" }),
      "file-1"
    );

    expect(image).toEqual({
      data: jpegBytes.toString("base64"),
      mediaType: "image/jpeg",
    });
  });

  test("accepts txt via filename when mime is octet-stream", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("hello", {
        headers: { "content-type": "application/octet-stream" },
      })
    );

    const result = await buildTelegramDocumentInput(
      createDocumentContext({
        fileName: "notes.txt",
        mimeType: "application/octet-stream",
      }),
      { saveInboundDocument }
    );

    expect(result?.kind).toBe("input");
    if (result?.kind === "input") {
      expect(result.input.message).toContain("artifacts/notes.txt");
      expect(result.input.message).toContain("read_file");
      expect(result.input.documents).toBeUndefined();
    }
  });

  test("accepts xlsx documents", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("xlsx-bytes", {
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      })
    );

    const result = await buildTelegramDocumentInput(
      createDocumentContext({
        fileName: "sheet.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      { saveInboundDocument }
    );

    expect(result?.kind).toBe("input");
    if (result?.kind === "input") {
      expect(result.input.documents).toBeUndefined();
      expect(result.input.message).toContain("artifacts/sheet.xlsx");
      expect(result.input.message).toContain("spreadsheet");
      expect(result.input.message).not.toContain("xlsx-bytes");
    }
  });

  test("rejects zip documents", async () => {
    fetchSpy = spyOn(globalThis, "fetch");

    const result = await buildTelegramDocumentInput(
      createDocumentContext({
        fileName: "archive.zip",
        mimeType: "application/zip",
      })
    );

    expect(result).toEqual({
      kind: "reject",
      message: UNSUPPORTED_DOCUMENT_TYPES_REPLY,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects oversized files before fetch when file_size is known", async () => {
    fetchSpy = spyOn(globalThis, "fetch");

    const result = await buildTelegramDocumentInput(
      createDocumentContext({
        fileName: "big.pdf",
        fileSize: MAX_DOCUMENT_INGEST_BYTES + 1,
        mimeType: "application/pdf",
      })
    );

    expect(result).toEqual({ kind: "reject", message: OVERSIZED_FILE_REPLY });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("explains the hosted Telegram download ceiling before fetching", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("must not download")
    );
    const result = await buildTelegramDocumentInput(
      createDocumentContext({
        fileName: "report.pdf",
        fileSize: 20 * 1024 * 1024 + 1,
        mimeType: "application/pdf",
      })
    );
    expect(result).toEqual({
      kind: "reject",
      message: TELEGRAM_HOSTED_FILE_LIMIT_REPLY,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns null for image documents", async () => {
    const result = await buildTelegramDocumentInput(
      createDocumentContext({
        fileName: "photo.png",
        mimeType: "image/png",
      })
    );

    expect(result).toBeNull();
  });
});

describe("downloadTelegramFile", () => {
  test("surfaces download failures to caller", async () => {
    const ctx = {
      api: {
        getFile: async () => {
          throw new Error("network down");
        },
        token: "test-token",
      },
    } as unknown as Context;

    await expect(
      downloadTelegramFile(ctx, "file-1", MAX_DOCUMENT_BYTES)
    ).rejects.toThrow("network down");
  });

  test("encodes the bot token as one URL path segment", async () => {
    const token = "123456:ABC-DEF/ghi_jkl";
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("pdf-bytes", {
        headers: { "content-type": "application/pdf" },
      })
    );
    const ctx = {
      api: {
        getFile: async () => ({ file_path: "photos/file_0.jpg" }),
        token,
      },
    } as unknown as Context;

    try {
      await downloadTelegramFile(ctx, "file-1", MAX_DOCUMENT_BYTES);
      const fetched = fetchSpy.mock.calls[0]?.[0];
      expect(fetched).toBeInstanceOf(URL);
      expect((fetched as URL).pathname).toBe(
        `/file/${encodeURIComponent(`bot${token}`)}/photos/file_0.jpg`
      );
      expect((fetched as URL).href).not.toContain(token);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("cancels a streamed download as soon as it exceeds the cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body)
    );
    const ctx = {
      api: {
        getFile: async () => ({ file_path: "documents/report.pdf" }),
        token: "test-token",
      },
    } as unknown as Context;

    try {
      await expect(
        downloadTelegramFile(ctx, "file-1", 8)
      ).rejects.toBeInstanceOf(Error);
      expect(cancelled).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("rejects zero-byte and oversized declared response bodies", async () => {
    const ctx = {
      api: {
        getFile: async () => ({ file_path: "documents/report.pdf" }),
        token: "test-token",
      },
    } as unknown as Context;
    const fetchSpy = spyOn(globalThis, "fetch");

    try {
      fetchSpy.mockResolvedValueOnce(
        new Response(null, { headers: { "content-length": "0" } })
      );
      await expect(downloadTelegramFile(ctx, "file-1", 8)).rejects.toThrow(
        "empty"
      );

      fetchSpy.mockResolvedValueOnce(
        new Response("x", { headers: { "content-length": "9" } })
      );
      await expect(
        downloadTelegramFile(ctx, "file-1", 8)
      ).rejects.toBeInstanceOf(OversizedTelegramFileError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("aborts a stalled response after the idle deadline", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body)
    );
    const ctx = {
      api: {
        getFile: async () => ({ file_path: "documents/report.pdf" }),
        token: "test-token",
      },
    } as unknown as Context;

    try {
      await expect(
        downloadTelegramFile(ctx, "file-1", 8, {
          idleTimeoutMs: 5,
          overallTimeoutMs: 100,
        })
      ).rejects.toThrow("stalled");
      expect(cancelled).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("bounds Telegram metadata lookup with the overall deadline", async () => {
    const ctx = {
      api: {
        getFile: async () => await new Promise<never>(() => {}),
        token: "test-token",
      },
    } as unknown as Context;

    await expect(
      downloadTelegramFile(ctx, "file-1", 8, {
        idleTimeoutMs: 100,
        overallTimeoutMs: 5,
      })
    ).rejects.toThrow("complete in time");
  });
});
