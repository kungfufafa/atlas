import { describe, expect, test } from "bun:test";
import type { SaveInboundDocument } from "@atlas/core/attachments/inbound-document";
import type { WAMessage } from "@whiskeysockets/baileys";
import {
  AUDIO_DOWNLOAD_FAILED_REPLY,
  buildWhatsAppAudioInput,
  MAX_AUDIO_BYTES,
  OVERSIZED_AUDIO_REPLY,
} from "./audio";

function createAudioMessage(fileLength?: number): WAMessage {
  return {
    key: { id: "voice-1", remoteJid: "6281234567890@s.whatsapp.net" },
    message: {
      audioMessage: {
        fileLength,
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
      },
    },
  };
}

describe("buildWhatsAppAudioInput", () => {
  test("saves original bytes before transcription and retains the transcript and file reference", async () => {
    const bytes = Buffer.from([0, 255, 17, 2, 130, 0]);
    const events: string[] = [];
    const result = await buildWhatsAppAudioInput(
      createAudioMessage(),
      async () => {
        events.push("download");
        return bytes;
      },
      async (input) => {
        events.push("transcribe");
        expect(input).toEqual({
          data: bytes.toString("base64"),
          filename: "voice.ogg",
          mediaType: "audio/ogg",
        });
        return { text: "  Prepare the meeting notes.  " };
      },
      {
        caption: "Include next steps.",
        saveInboundDocument: async (file) => {
          events.push("save");
          expect(file.bytes).toEqual(bytes);
          expect(file.filename).toBe("voice.ogg");
          expect(file.mediaType).toBe("audio/ogg");
          return {
            relativePath: "artifacts/voice.ogg",
            sizeBytes: file.bytes.byteLength,
          };
        },
      }
    );

    expect(events).toEqual(["download", "save", "transcribe"]);
    expect(result.kind).toBe("input");
    if (result.kind === "input") {
      expect(
        result.input.message.startsWith("Prepare the meeting notes.")
      ).toBe(true);
      expect(result.input.message.indexOf("Include next steps.")).toBeLessThan(
        result.input.message.indexOf("artifacts/voice.ogg")
      );
      expect(result.input.message).toContain("artifacts/voice.ogg");
    }
  });

  test.each(["missing", "failed", "incomplete"] as const)(
    "does not transcribe when persistence is %s",
    async (failure) => {
      let transcribed = false;
      const saveInboundDocument: SaveInboundDocument = async () => {
        if (failure === "failed") {
          throw new Error("Disk full");
        }
        return { relativePath: "artifacts/voice.ogg", sizeBytes: 0 };
      };
      const result = await buildWhatsAppAudioInput(
        createAudioMessage(),
        async () => Buffer.from("original audio"),
        async () => {
          transcribed = true;
          return { text: "must not run" };
        },
        {
          saveInboundDocument:
            failure === "missing" ? undefined : saveInboundDocument,
        }
      );

      expect(result.kind).toBe("reject");
      expect(transcribed).toBe(false);
    }
  );

  test.each([
    "download",
    "empty",
    "oversized",
    "advertised_oversized",
  ] as const)("does not save or transcribe on %s failure", async (failure) => {
    let downloaded = false;
    let saved = false;
    let transcribed = false;
    const result = await buildWhatsAppAudioInput(
      createAudioMessage(
        failure === "advertised_oversized" ? MAX_AUDIO_BYTES + 1 : undefined
      ),
      async () => {
        downloaded = true;
        if (failure === "download") {
          throw new Error("Media unavailable");
        }
        return failure === "oversized"
          ? Buffer.alloc(MAX_AUDIO_BYTES + 1)
          : Buffer.alloc(0);
      },
      async () => {
        transcribed = true;
        return { text: "must not run" };
      },
      {
        saveInboundDocument: async (file) => {
          saved = true;
          return {
            relativePath: "artifacts/voice.ogg",
            sizeBytes: file.bytes.byteLength,
          };
        },
      }
    );

    expect(result).toEqual({
      kind: "reject",
      message: failure.includes("oversized")
        ? OVERSIZED_AUDIO_REPLY
        : AUDIO_DOWNLOAD_FAILED_REPLY,
    });
    expect(downloaded).toBe(failure !== "advertised_oversized");
    expect(saved).toBe(false);
    expect(transcribed).toBe(false);
  });

  test("cancellation while saving prevents transcription", async () => {
    const controller = new AbortController();
    let transcribed = false;
    await expect(
      buildWhatsAppAudioInput(
        createAudioMessage(),
        async () => Buffer.from("original audio"),
        async () => {
          transcribed = true;
          return { text: "must not run" };
        },
        {
          saveInboundDocument: (file) => {
            expect(file.signal).toBe(controller.signal);
            controller.abort();
            return new Promise(() => undefined);
          },
          signal: controller.signal,
        }
      )
    ).rejects.toThrow();
    expect(transcribed).toBe(false);
  });
});
