import { describe, expect, mock, test } from "bun:test";
import {
  sendTelegramArtifact,
  TELEGRAM_ARTIFACT_MAX_BYTES,
} from "./send-artifact-document";

describe("sendTelegramArtifact", () => {
  test("rejects files over the telegram cap", async () => {
    const result = await sendTelegramArtifact(
      { api: { sendDocument: async () => ({}) }, chat: { id: 1 } } as never,
      {
        bytes: new Uint8Array(TELEGRAM_ARTIFACT_MAX_BYTES + 1),
        filename: "big.md",
        mimeType: "text/markdown",
      }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("too large");
  });

  test("sends documents into the originating forum topic", async () => {
    const sent: Array<{ options?: { message_thread_id?: number } }> = [];
    const result = await sendTelegramArtifact(
      {
        api: {
          sendDocument: async (
            _chatId: number,
            _file: unknown,
            options?: { message_thread_id?: number }
          ) => {
            sent.push({ options });
            return { message_id: 123 };
          },
        },
        chat: { id: 1 },
        message: { message_thread_id: 77 },
      } as never,
      {
        bytes: new Uint8Array([1, 2, 3]),
        filename: "note.md",
        mimeType: "text/markdown",
      }
    );

    expect(result.ok).toBe(true);
    expect(sent).toEqual([{ options: { message_thread_id: 77 } }]);
  });

  test.each([
    ["image/jpeg", "preview.jpg"],
    ["image/png", "preview.png"],
  ])(
    "sends %s artifacts as photos with native previews",
    async (mimeType, filename) => {
      const photos: Array<{
        options?: { message_thread_id?: number };
        filename: string;
      }> = [];
      const result = await sendTelegramArtifact(
        {
          api: {
            sendPhoto: async (
              _chatId: number,
              file: { filename?: string },
              options?: { message_thread_id?: number }
            ) => {
              photos.push({ filename: file.filename ?? "", options });
              return { message_id: 123 };
            },
          },
          chat: { id: 1 },
          message: { message_thread_id: 77 },
        } as never,
        {
          bytes: new Uint8Array([1, 2, 3]),
          filename,
          mimeType,
        }
      );

      expect(result).toEqual({ messageId: "123", ok: true });
      expect(photos).toEqual([
        {
          filename,
          options: { message_thread_id: 77 },
        },
      ]);
    }
  );

  test("keeps SVG artwork deliverable as a document in its forum topic", async () => {
    const sendDocument = mock(async () => ({ message_id: 123 }));
    const sendPhoto = mock(async () => ({ message_id: 124 }));
    const result = await sendTelegramArtifact(
      {
        api: { sendDocument, sendPhoto },
        chat: { id: 1 },
        message: { message_thread_id: 77 },
      } as never,
      {
        bytes: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
        ),
        filename: "logo.svg",
        mimeType: "image/svg+xml",
      }
    );

    expect(result).toEqual({ messageId: "123", ok: true });
    expect(sendDocument).toHaveBeenCalledTimes(1);
    expect(sendDocument).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ filename: "logo.svg" }),
      { message_thread_id: 77 }
    );
    expect(sendPhoto).not.toHaveBeenCalled();
  });
});

for (const [mimeType, filename, bytes, method] of [
  [
    "audio/ogg",
    "voice.ogg",
    Buffer.from("OggSxxxxxxxxOpusHeadxxxxxxxx"),
    "sendVoice",
  ],
  ["audio/mpeg", "audio.mp3", Buffer.from("ID3synthetic-mp3"), "sendAudio"],
  ["audio/mp4", "audio.m4a", Buffer.from("0000ftypM4A synthetic"), "sendAudio"],
  ["video/mp4", "video.mp4", Buffer.from("0000ftypisomsynthetic"), "sendVideo"],
] as const) {
  test(`${mimeType} uses its native Telegram method with acknowledged message identity`, async () => {
    const sent: unknown[][] = [];
    const result = await sendTelegramArtifact(
      {
        api: {
          [method]: async (...args: unknown[]) => {
            sent.push(args);
            return { message_id: 800 };
          },
        },
        chat: { id: 42 },
        message: { message_thread_id: 77 },
      } as never,
      { bytes, filename, mimeType }
    );
    expect(result).toEqual({ messageId: "800", ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(42);
    expect(sent[0]![1]).toMatchObject({ filename });
    expect(sent[0]![2]).toEqual({ message_thread_id: 77 });
  });
}

test("invalid native media bytes fail before any upload", async () => {
  let uploads = 0;
  const ctx = {
    api: {
      sendVideo: async () => {
        uploads++;
        return { message_id: 1 };
      },
      sendVoice: async () => {
        uploads++;
        return { message_id: 1 };
      },
    },
    chat: { id: 42 },
  } as never;
  for (const mimeType of ["audio/ogg", "video/mp4"]) {
    const result = await sendTelegramArtifact(ctx, {
      bytes: Buffer.from("incorrect bytes"),
      filename: "file",
      mimeType,
    });
    expect(result.ok).toBe(false);
  }
  expect(uploads).toBe(0);
});

test("an upload response without message_id stays unconfirmed and is not retried", async () => {
  let uploads = 0;
  const result = await sendTelegramArtifact(
    {
      api: {
        sendDocument: async () => {
          uploads++;
          return {};
        },
      },
      chat: { id: 42 },
    } as never,
    { bytes: Buffer.from("test"), filename: "note.txt", mimeType: "text/plain" }
  );
  expect(result.ok).toBe(false);
  expect(result.messageId).toBeUndefined();
  expect(uploads).toBe(1);
});

test("General forum topic omits the thread parameter for native uploads", async () => {
  const options: unknown[] = [];
  const result = await sendTelegramArtifact(
    {
      api: {
        sendDocument: async (
          _chat: unknown,
          _file: unknown,
          value: unknown
        ) => {
          options.push(value);
          return { message_id: 1 };
        },
      },
      chat: { id: -100 },
      message: { message_thread_id: 1 },
    } as never,
    { bytes: Buffer.from("test"), filename: "note.txt", mimeType: "text/plain" }
  );
  expect(result.ok).toBe(true);
  expect(options).toEqual([undefined]);
});
