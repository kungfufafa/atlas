import { describe, expect, mock, test } from "bun:test";
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

  test("sends documents with a filename", async () => {
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
        bytes: new Uint8Array([80, 75, 3, 4]),
        filename: "sales.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }
    );

    expect(sent[0]).toEqual({
      document: expect.any(Buffer),
      fileName: "sales.xlsx",
      mimetype:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  });

  test.each([
    ["image/jpeg", "edited.jpg"],
    ["image/png", "edited.png"],
  ])("delivers %s output as a native photo", async (mimeType, filename) => {
    const bytes = Buffer.from("photo transport fixture");
    const sendMessage = mock(async () => {});
    const jid = "6281111111111@s.whatsapp.net";

    const result = await sendWhatsAppArtifact({ sendMessage } as never, jid, {
      bytes,
      filename,
      mimeType,
    });

    expect(result).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(jid, {
      image: bytes,
      mimetype: mimeType,
    });
  });

  test("keeps SVG artwork deliverable as a document", async () => {
    const bytes = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
    );
    const sendMessage = mock(async () => {});
    const jid = "6281111111111@s.whatsapp.net";

    const result = await sendWhatsAppArtifact({ sendMessage } as never, jid, {
      bytes,
      filename: "logo.svg",
      mimeType: "image/svg+xml",
    });

    expect(result).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(jid, {
      document: bytes,
      fileName: "logo.svg",
      mimetype: "image/svg+xml",
    });
  });
});
