import { describe, expect, test } from "bun:test";
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
            return {};
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

  test("sends JPEG and PNG artifacts as photos with native previews", async () => {
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
            return {};
          },
        },
        chat: { id: 1 },
        message: { message_thread_id: 77 },
      } as never,
      {
        bytes: new Uint8Array([1, 2, 3]),
        filename: "preview.png",
        mimeType: "image/png",
      }
    );

    expect(result.ok).toBe(true);
    expect(photos).toEqual([
      {
        filename: "preview.png",
        options: { message_thread_id: 77 },
      },
    ]);
  });
});
