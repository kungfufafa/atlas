import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CHANNEL_DOCUMENT_SAVE_FAILED_REPLY } from "@atlas/core/attachments/inbound-document";
import type { Message } from "discord.js";
import {
  buildDiscordAttachmentInput,
  DOWNLOAD_FAILED_REPLY,
  OVERSIZED_FILE_REPLY,
  UNSUPPORTED_DOCUMENT_TYPES_REPLY,
} from "./attachments";

async function saveAttachment(input: { bytes: Buffer; filename: string }) {
  return {
    relativePath: `artifacts/${input.filename}`,
    sizeBytes: input.bytes.length,
  };
}

function createMessage(options: {
  content?: string;
  attachments: Array<{
    contentType?: string | null;
    name: string;
    size?: number;
    url?: string;
  }>;
}): Message {
  const attachments = new Map(
    options.attachments.map((item, index) => [
      `att_${index}`,
      {
        contentType: item.contentType ?? null,
        name: item.name,
        size: item.size ?? 12,
        url: item.url ?? `https://cdn.example/${item.name}`,
      },
    ])
  );

  return {
    attachments: {
      size: attachments.size,
      values: () => attachments.values(),
    },
    content: options.content ?? "",
  } as unknown as Message;
}

describe("buildDiscordAttachmentInput", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  test("preserves all five saved document references and rejects a sixth before downloading", async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 32);
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => new Response(bytes), {
        preconnect: fetch.preconnect,
      })
    );
    const attachments = Array.from({ length: 5 }, (_, index) => ({
      contentType: "text/plain",
      name: `source-${index}.txt`,
      size: bytes.length,
    }));
    let saves = 0;
    const result = await buildDiscordAttachmentInput(
      createMessage({ attachments, content: "Compare every file" }),
      {
        saveInboundDocument: async (input) => {
          saves++;
          return {
            relativePath: `artifacts/${input.filename}`,
            sizeBytes: input.bytes.length,
          };
        },
      }
    );
    expect(result?.kind).toBe("input");
    if (result?.kind !== "input") {
      throw new Error("Expected saved documents");
    }
    expect(saves).toBe(5);
    expect(result.input.documents).toBeUndefined();
    expect(result.input.message).toContain("Compare every file");
    for (const item of attachments) {
      expect(result.input.message).toContain(`artifacts/${item.name}`);
    }
    fetchSpy.mockClear();
    const rejected = await buildDiscordAttachmentInput(
      createMessage({ attachments: [...attachments, { name: "sixth.txt" }] })
    );
    expect(rejected?.kind).toBe("reject");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects a later unsupported entry before any source is saved", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("must not download")
    );
    let saves = 0;
    const result = await buildDiscordAttachmentInput(
      createMessage({
        attachments: [
          { name: "source.txt", size: 6 * 1024 * 1024 },
          { name: "payload.zip" },
        ],
      }),
      {
        saveInboundDocument: async () => {
          saves++;
          return {
            relativePath: "artifacts/source.txt",
            sizeBytes: 6 * 1024 * 1024,
          };
        },
      }
    );
    expect(result?.kind).toBe("reject");
    expect(saves).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("saves a pdf with caption and a tool reference", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("pdf-bytes", {
        headers: { "content-type": "application/pdf" },
      })
    );

    const result = await buildDiscordAttachmentInput(
      createMessage({
        attachments: [
          {
            contentType: "application/pdf",
            name: "report.pdf",
          },
        ],
        content: "Summarize",
      }),
      { saveInboundDocument: saveAttachment }
    );

    expect(result).toEqual({
      input: {
        documents: undefined,
        images: undefined,
        message: expect.stringContaining("artifacts/report.pdf"),
      },
      kind: "input",
    });
    if (result?.kind === "input") {
      expect(result.input.message).toContain("Summarize");
      expect(result.input.message).toContain("extract_document_text");
      expect(result.input.message).not.toContain("pdf-bytes");
    }
  });

  test("canonicalizes an image MIME alias before forwarding", async () => {
    const jpegBytes = Buffer.from(
      "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z",
      "base64"
    );
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(jpegBytes)
    );

    const result = await buildDiscordAttachmentInput(
      createMessage({
        attachments: [
          {
            contentType: "IMAGE/JPG; charset=binary",
            name: "photo.jpg",
          },
        ],
      }),
      { saveInboundDocument: saveAttachment }
    );

    expect(result).toEqual({
      input: {
        documents: undefined,
        images: [
          {
            data: jpegBytes.toString("base64"),
            mediaType: "image/jpeg",
          },
        ],
        message: expect.stringContaining("artifacts/photo.jpg"),
      },
      kind: "input",
    });
  });

  test("saves xlsx for the spreadsheet tool without an inline document", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("xlsx-bytes")
    );

    const result = await buildDiscordAttachmentInput(
      createMessage({
        attachments: [
          {
            contentType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            name: "sheet.xlsx",
          },
        ],
      }),
      { saveInboundDocument: saveAttachment }
    );

    expect(result?.kind).toBe("input");
    if (result?.kind === "input") {
      expect(result.input.documents).toBeUndefined();
      expect(result.input.message).toContain("artifacts/sheet.xlsx");
      expect(result.input.message).toContain("spreadsheet");
      expect(result.input.message).not.toContain("xlsx-bytes");
    }
  });

  test("rejects a supported source when persistence is unavailable", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("source text")
    );
    const result = await buildDiscordAttachmentInput(
      createMessage({ attachments: [{ name: "notes.txt" }] })
    );
    expect(result).toEqual({
      kind: "reject",
      message: CHANNEL_DOCUMENT_SAVE_FAILED_REPLY,
    });
  });

  test("transcribes a voice note into message text", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ogg-bytes", { headers: { "content-type": "audio/ogg" } })
    );

    const result = await buildDiscordAttachmentInput(
      createMessage({
        attachments: [
          {
            contentType: "audio/ogg",
            name: "voice-message.ogg",
          },
        ],
      }),
      {
        caption: "Please summarize",
        saveInboundDocument: async (input) => {
          expect(input.bytes).toEqual(Buffer.from("ogg-bytes"));
          return saveAttachment(input);
        },
        transcribeAudio: async () => ({ text: "Transcribed voice message" }),
      }
    );

    expect(result).toEqual({
      input: {
        documents: undefined,
        images: undefined,
        message: expect.stringContaining(
          "Transcribed voice message\n\nPlease summarize"
        ),
      },
      kind: "input",
    });
  });

  test("audio save failure prevents transcription", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ogg-bytes")
    );
    let transcriptions = 0;
    const result = await buildDiscordAttachmentInput(
      createMessage({
        attachments: [{ contentType: "audio/ogg", name: "voice.ogg" }],
      }),
      {
        saveInboundDocument: async () => {
          throw new Error("Disk full");
        },
        transcribeAudio: async () => {
          transcriptions++;
          return { text: "must not run" };
        },
      }
    );
    expect(result).toEqual({
      kind: "reject",
      message: CHANNEL_DOCUMENT_SAVE_FAILED_REPLY,
    });
    expect(transcriptions).toBe(0);
  });

  test("rejects zip files before download", async () => {
    fetchSpy = spyOn(globalThis, "fetch");

    const result = await buildDiscordAttachmentInput(
      createMessage({
        attachments: [{ contentType: "application/zip", name: "archive.zip" }],
      })
    );

    expect(result).toEqual({
      kind: "reject",
      message: UNSUPPORTED_DOCUMENT_TYPES_REPLY,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects oversized files from the declared size", async () => {
    fetchSpy = spyOn(globalThis, "fetch");

    const result = await buildDiscordAttachmentInput(
      createMessage({
        attachments: [
          {
            contentType: "application/pdf",
            name: "big.pdf",
            size: 26 * 1024 * 1024,
          },
        ],
      })
    );

    expect(result).toEqual({
      kind: "reject",
      message: OVERSIZED_FILE_REPLY,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects zero-byte bodies and oversized Content-Length headers", async () => {
    fetchSpy = spyOn(globalThis, "fetch");
    const message = createMessage({
      attachments: [{ contentType: "application/pdf", name: "report.pdf" }],
    });

    fetchSpy.mockResolvedValueOnce(
      new Response(null, { headers: { "content-length": "0" } })
    );
    await expect(buildDiscordAttachmentInput(message)).resolves.toEqual({
      kind: "reject",
      message: DOWNLOAD_FAILED_REPLY,
    });

    fetchSpy.mockResolvedValueOnce(
      new Response("x", {
        headers: { "content-length": String(25 * 1024 * 1024 + 1) },
      })
    );
    await expect(buildDiscordAttachmentInput(message)).resolves.toEqual({
      kind: "reject",
      message: OVERSIZED_FILE_REPLY,
    });
  });

  test("cancels a streamed body as soon as its actual bytes exceed the cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(13 * 1024 * 1024));
        controller.enqueue(new Uint8Array(13 * 1024 * 1024));
      },
    });
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));

    const result = await buildDiscordAttachmentInput(
      createMessage({
        attachments: [
          { contentType: "application/pdf", name: "report.pdf", size: 1 },
        ],
      })
    );

    expect(result).toEqual({
      kind: "reject",
      message: OVERSIZED_FILE_REPLY,
    });
    expect(cancelled).toBe(true);
  });

  test("returns a terminal download error when a body stalls", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));

    const result = await buildDiscordAttachmentInput(
      createMessage({
        attachments: [{ contentType: "application/pdf", name: "report.pdf" }],
      }),
      { idleTimeoutMs: 5, overallTimeoutMs: 100 }
    );

    expect(result).toEqual({ kind: "reject", message: DOWNLOAD_FAILED_REPLY });
    expect(cancelled).toBe(true);
  });

  test("propagates caller cancellation during attachment preprocessing", async () => {
    const body = new ReadableStream<Uint8Array>();
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    const controller = new AbortController();
    const pending = buildDiscordAttachmentInput(
      createMessage({
        attachments: [{ contentType: "application/pdf", name: "report.pdf" }],
      }),
      { signal: controller.signal }
    );

    controller.abort(new DOMException("Stopped", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("bounds the initial CDN request with the overall deadline", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => await new Promise<Response>(() => {}), {
        preconnect: fetch.preconnect,
      })
    );

    const result = await buildDiscordAttachmentInput(
      createMessage({
        attachments: [{ contentType: "application/pdf", name: "report.pdf" }],
      }),
      { idleTimeoutMs: 100, overallTimeoutMs: 5 }
    );

    expect(result).toEqual({ kind: "reject", message: DOWNLOAD_FAILED_REPLY });
  });
});
