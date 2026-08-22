import { describe, expect, test } from "bun:test";
import {
  formatWhatsAppArtifactTooLargeMessage,
  sendWhatsAppArtifact,
  WHATSAPP_ARTIFACT_MEDIA_MAX_BYTES,
} from "./send-artifact-media";

describe("sendWhatsAppArtifact", () => {
  test("rejects when the socket is disconnected", async () => {
    const result = await sendWhatsAppArtifact(
      null,
      "6281111111111@s.whatsapp.net",
      {
        bytes: new Uint8Array([1, 2, 3]),
        filename: "note.md",
        mimeType: "text/markdown",
      }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not connected");
  });

  test("rejects files over the WhatsApp media cap", async () => {
    const bytes = new Uint8Array(WHATSAPP_ARTIFACT_MEDIA_MAX_BYTES + 1);
    const result = await sendWhatsAppArtifact(
      { sendMessage: async () => {} } as never,
      "6281111111111@s.whatsapp.net",
      {
        bytes,
        filename: "huge.md",
        mimeType: "text/markdown",
      }
    );

    expect(result).toEqual({
      error: formatWhatsAppArtifactTooLargeMessage(bytes.byteLength),
      ok: false,
    });
  });

  test("sends images with a mime type and documents with a filename", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const socket = {
      sendMessage: async (_jid: string, content: Record<string, unknown>) => {
        sent.push(content);
      },
    };

    await sendWhatsAppArtifact(
      socket as never,
      "6281111111111@s.whatsapp.net",
      {
        bytes: new Uint8Array([137, 80, 78, 71]),
        filename: "shot.png",
        mimeType: "image/png",
      }
    );
    await sendWhatsAppArtifact(
      socket as never,
      "6281111111111@s.whatsapp.net",
      {
        bytes: new Uint8Array([80, 75, 3, 4]),
        filename: "sales.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }
    );

    expect(sent[0]).toEqual({
      image: expect.any(Buffer),
      mimetype: "image/png",
    });
    expect(sent[1]).toEqual({
      document: expect.any(Buffer),
      fileName: "sales.xlsx",
      mimetype:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  });
});
