import { describe, expect, test } from "bun:test";
import {
  extractInboundPhoneHint,
  extractInboundText,
  inspectInboundWhatsAppMedia,
  isPrivateWhatsAppChat,
  isSelfWhatsAppChat,
  shouldHandleInboundMessage,
} from "./inbound-message";

describe("inbound message routing", () => {
  test("accepts private phone and lid chats", () => {
    expect(isPrivateWhatsAppChat("6281379292556@s.whatsapp.net")).toBe(true);
    expect(isPrivateWhatsAppChat("236283431522503@lid")).toBe(true);
    expect(isPrivateWhatsAppChat("123@g.us")).toBe(false);
  });

  test("handles message-yourself traffic marked fromMe", () => {
    const me = {
      id: "6281379292556@s.whatsapp.net",
      lid: "236283431522503@lid",
    };

    expect(
      shouldHandleInboundMessage(
        {
          key: { fromMe: true, remoteJid: "236283431522503@lid" },
          message: { conversation: "hello" },
        },
        me
      )
    ).toBe(true);
    expect(isSelfWhatsAppChat("236283431522503@lid", me)).toBe(true);
  });

  test("ignores fromMe messages in other chats", () => {
    expect(
      shouldHandleInboundMessage(
        {
          key: { fromMe: true, remoteJid: "9999999999@s.whatsapp.net" },
          message: { conversation: "hello" },
        },
        { id: "6281379292556@s.whatsapp.net", lid: "236283431522503@lid" }
      )
    ).toBe(false);
  });

  test("prefers senderPn over participantPn for phone identity", () => {
    expect(
      extractInboundPhoneHint({
        key: {
          participantPn: "628111111111@s.whatsapp.net",
          senderPn: "6281234567890@s.whatsapp.net",
        },
      })
    ).toBe("6281234567890@s.whatsapp.net");
    expect(
      extractInboundPhoneHint({
        key: { participantPn: "628111111111@s.whatsapp.net" },
      })
    ).toBe("628111111111@s.whatsapp.net");
    expect(extractInboundPhoneHint({ key: {} })).toBeNull();
  });

  test("handles captionless documents and photos", () => {
    expect(
      shouldHandleInboundMessage(
        {
          key: { fromMe: false, remoteJid: "6281234567890@s.whatsapp.net" },
          message: {
            documentMessage: {
              fileName: "report.pdf",
              mimetype: "application/pdf",
            },
          },
        },
        undefined
      )
    ).toBe(true);
    expect(
      shouldHandleInboundMessage(
        {
          key: { fromMe: false, remoteJid: "6281234567890@s.whatsapp.net" },
          message: { imageMessage: { mimetype: "image/jpeg" } },
        },
        undefined
      )
    ).toBe(true);
    expect(
      extractInboundText({
        documentMessage: {
          caption: "Summarize this",
          fileName: "report.pdf",
          mimetype: "application/pdf",
        },
      })
    ).toBe("Summarize this");
    expect(
      inspectInboundWhatsAppMedia({
        documentMessage: {
          fileName: "report.pdf",
          mimetype: "application/pdf",
        },
      })
    ).toMatchObject({ filename: "report.pdf", kind: "document" });
    expect(
      inspectInboundWhatsAppMedia({
        audioMessage: { mimetype: "audio/ogg", ptt: true },
      })
    ).toMatchObject({ kind: "audio" });
  });

  test("extracts text from ephemeral wrapped messages", () => {
    expect(
      extractInboundText({
        ephemeralMessage: {
          message: {
            extendedTextMessage: {
              text: "hello from wrapper",
            },
          },
        },
      } as any)
    ).toBe("hello from wrapper");
  });

  test("extracts text from protobuf-like messages that only expose text via JSON", () => {
    const payload = {
      extendedTextMessage: {
        get text() {},
        toJSON() {
          return { text: "hi from toJSON" };
        },
      },
      toJSON() {
        return {
          extendedTextMessage: {
            text: "hi from toJSON",
          },
        };
      },
    };

    expect(extractInboundText(payload as any)).toBe("hi from toJSON");
  });
});
