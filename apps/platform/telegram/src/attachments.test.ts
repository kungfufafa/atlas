import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { MAX_DOCUMENT_BYTES } from "@atlas/core/message-content";
import type { Context } from "grammy";
import {
  buildTelegramDocumentInput,
  downloadTelegramFile,
  OVERSIZED_FILE_REPLY,
  UNSUPPORTED_DOCUMENT_TYPES_REPLY,
} from "./attachments";
import { downloadTelegramImage } from "./images";

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
      })
    );

    expect(result).toEqual({
      input: {
        documents: [
          expect.objectContaining({
            data: Buffer.from("pdf-bytes").toString("base64"),
            filename: "report.pdf",
            mediaType: "application/pdf",
          }),
        ],
        message: "Summarize this",
      },
      kind: "input",
    });
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
      })
    );

    expect(result?.kind).toBe("input");
    if (result?.kind === "input") {
      expect(result.input.documents?.[0]?.mediaType).toBe("text/plain");
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
      })
    );

    expect(result).toEqual({
      input: {
        documents: [
          expect.objectContaining({
            filename: "sheet.xlsx",
            mediaType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
        ],
        message: "",
      },
      kind: "input",
    });
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
        fileSize: MAX_DOCUMENT_BYTES + 1,
        mimeType: "application/pdf",
      })
    );

    expect(result).toEqual({ kind: "reject", message: OVERSIZED_FILE_REPLY });
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
});
