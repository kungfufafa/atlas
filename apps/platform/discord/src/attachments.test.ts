import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Message } from "discord.js";
import {
  buildDiscordAttachmentInput,
  OVERSIZED_FILE_REPLY,
  UNSUPPORTED_DOCUMENT_TYPES_REPLY,
} from "./attachments";

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

  test("forwards a pdf with caption", async () => {
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
      })
    );

    expect(result).toEqual({
      input: {
        documents: [
          expect.objectContaining({
            filename: "report.pdf",
            mediaType: "application/pdf",
          }),
        ],
        images: undefined,
        message: "Summarize",
      },
      kind: "input",
    });
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
      })
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
        message: "",
      },
      kind: "input",
    });
  });

  test("accepts xlsx like the web app", async () => {
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
      })
    );

    expect(result?.kind).toBe("input");
    if (result?.kind === "input") {
      expect(result.input.documents?.[0]?.filename).toBe("sheet.xlsx");
    }
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
        transcribeAudio: async () => ({ text: "Transcribed voice message" }),
      }
    );

    expect(result).toEqual({
      input: {
        documents: undefined,
        images: undefined,
        message: "Transcribed voice message",
      },
      kind: "input",
    });
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
            size: 6 * 1024 * 1024,
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
});
