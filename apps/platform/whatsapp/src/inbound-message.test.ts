import { describe, expect, test } from "bun:test";
import type { proto } from "@whiskeysockets/baileys";
import {
  extractInboundPhoneHint,
  extractInboundText,
  inspectInboundWhatsAppMedia,
  isPrivateWhatsAppChat,
  isSelfWhatsAppChat,
  parseInboundWhatsAppMessage,
  shouldHandleInboundMessage,
} from "./inbound-message";

const ME = {
  id: "6281379292556:12@s.whatsapp.net",
  lid: "236283431522503:0@lid",
};
const GROUP_JID = "120363042000000000@g.us";
const CAPTIONLESS_CHAT_MEDIA = [
  ["sticker", { stickerMessage: { mimetype: "image/webp" } }],
  ["photo", { imageMessage: { caption: " \n ", mimetype: "image/jpeg" } }],
  ["video", { videoMessage: { mimetype: "video/mp4" } }],
  ["audio", { audioMessage: { mimetype: "audio/ogg", ptt: true } }],
] satisfies [string, proto.IMessage][];

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

  test("ignores unaddressed and unsupported-command group messages", () => {
    expect(
      parseInboundWhatsAppMessage(
        {
          key: {
            participant: "628122222222@s.whatsapp.net",
            remoteJid: GROUP_JID,
          },
          message: { conversation: "hello everyone" },
        },
        ME
      )
    ).toBeNull();
    expect(
      parseInboundWhatsAppMessage(
        {
          key: {
            participant: "628122222222@s.whatsapp.net",
            remoteJid: GROUP_JID,
          },
          message: { conversation: "/unknown" },
        },
        ME
      )
    ).toBeNull();
  });

  test.each(CAPTIONLESS_CHAT_MEDIA)(
    "ignores an unaddressed captionless group %s",
    (_kind, message) => {
      expect(
        parseInboundWhatsAppMessage(
          {
            key: {
              participant: "628122222222@s.whatsapp.net",
              remoteJid: GROUP_JID,
            },
            message,
          },
          ME
        )
      ).toBeNull();
    }
  );

  test.each(CAPTIONLESS_CHAT_MEDIA)(
    "keeps a captionless %s in direct messages",
    (_kind, message) => {
      expect(
        parseInboundWhatsAppMessage(
          {
            key: { remoteJid: "628122222222@s.whatsapp.net" },
            message,
          },
          ME
        )
      ).toMatchObject({ isGroup: false, text: "" });
    }
  );

  test.each(CAPTIONLESS_CHAT_MEDIA)(
    "keeps an unaddressed group %s when group policy explicitly allows it",
    (_kind, message) => {
      expect(
        parseInboundWhatsAppMessage(
          {
            key: {
              participant: "628122222222@s.whatsapp.net",
              remoteJid: GROUP_JID,
            },
            message,
          },
          ME,
          { allowUnaddressedGroup: true }
        )
      ).toMatchObject({ isGroup: true, text: "" });
    }
  );

  test.each([
    [
      "mention of another member",
      { mentionedJid: ["628133333333@s.whatsapp.net"] },
    ],
    ["reply to another member", { participant: "628133333333@s.whatsapp.net" }],
    [
      "reply attributed to another group",
      {
        participant: ME.id,
        quotedMessage: { conversation: "Another group's message" },
        remoteJid: "120363099999999999@g.us",
        stanzaId: "cross-group-message",
      },
    ],
  ] satisfies [string, proto.IContextInfo][])(
    "ignores a group sticker with a %s",
    (_address, contextInfo) => {
      expect(
        parseInboundWhatsAppMessage(
          {
            key: {
              participant: "628122222222@s.whatsapp.net",
              remoteJid: GROUP_JID,
            },
            message: {
              stickerMessage: { contextInfo, mimetype: "image/webp" },
            },
          },
          ME
        )
      ).toBeNull();
    }
  );

  test.each([
    [
      "mention",
      { mentionedJid: [ME.id] },
      { mentionedJids: ["6281379292556@s.whatsapp.net"] },
    ],
    [
      "reply",
      {
        participant: ME.lid,
        quotedMessage: { conversation: "Atlas reply" },
        remoteJid: GROUP_JID,
        stanzaId: "atlas-message",
      },
      {
        quotedMessageId: "atlas-message",
        quotedParticipant: "236283431522503@lid",
        quotedText: "Atlas reply",
      },
    ],
  ] satisfies [string, proto.IContextInfo, Record<string, unknown>][])(
    "preserves a group sticker's bot %s metadata",
    (_address, contextInfo, expected) => {
      expect(
        parseInboundWhatsAppMessage(
          {
            key: {
              participant: "628122222222@s.whatsapp.net",
              remoteJid: GROUP_JID,
            },
            message: {
              stickerMessage: { contextInfo, mimetype: "image/webp" },
            },
          },
          ME
        )
      ).toMatchObject({ ...expected, isGroup: true, text: "" });
    }
  );

  test("drops echoed outbound group commands before command handling", () => {
    expect(
      parseInboundWhatsAppMessage(
        {
          key: {
            fromMe: true,
            participant: ME.id,
            remoteJid: GROUP_JID,
          },
          message: { conversation: "/clear" },
        },
        ME
      )
    ).toBeNull();
  });

  test("parses group mention metadata and normalizes sender identities", () => {
    expect(
      parseInboundWhatsAppMessage(
        {
          key: {
            participant: "104784384290844:0@lid",
            participantPn: "628122222222:8@s.whatsapp.net",
            remoteJid: GROUP_JID,
          },
          message: {
            extendedTextMessage: {
              contextInfo: { mentionedJid: [ME.id] },
              text: "@Atlas hello",
            },
          },
        },
        ME
      )
    ).toEqual({
      fromMe: false,
      isGroup: true,
      jid: GROUP_JID,
      me: ME,
      mentionedJids: ["6281379292556@s.whatsapp.net"],
      quotedMessageId: null,
      quotedParticipant: null,
      quotedText: null,
      senderJid: "628122222222@s.whatsapp.net",
      senderJids: ["628122222222@s.whatsapp.net", "104784384290844@lid"],
      senderPn: "628122222222:8@s.whatsapp.net",
      text: "@Atlas hello",
    });
  });

  test("keeps same-group quoted text for reply context", () => {
    const parsed = parseInboundWhatsAppMessage(
      {
        key: {
          participant: "628122222222@s.whatsapp.net",
          remoteJid: GROUP_JID,
        },
        message: {
          extendedTextMessage: {
            contextInfo: {
              participant: ME.lid,
              quotedMessage: { conversation: "The earlier group report" },
              remoteJid: GROUP_JID,
              stanzaId: "local-message",
            },
            text: "please continue",
          },
        },
      },
      ME
    );

    expect(parsed?.quotedParticipant).toBe("236283431522503@lid");
    expect(parsed?.quotedText).toBe("The earlier group report");
    expect(parsed?.quotedMessageId).toBe("local-message");
  });

  test("does not trigger or expose a quote attributed to another group", () => {
    const message = {
      extendedTextMessage: {
        contextInfo: {
          participant: ME.id,
          quotedMessage: { conversation: "Secret from another group" },
          remoteJid: "120363099999999999@g.us",
          stanzaId: "cross-group-message",
        },
        text: "continue",
      },
    };

    expect(
      parseInboundWhatsAppMessage(
        {
          key: {
            participant: "628122222222@s.whatsapp.net",
            remoteJid: GROUP_JID,
          },
          message,
        },
        ME
      )
    ).toBeNull();

    const explicitlyAddressed = parseInboundWhatsAppMessage(
      {
        key: {
          participant: "628122222222@s.whatsapp.net",
          remoteJid: GROUP_JID,
        },
        message: {
          extendedTextMessage: {
            ...message.extendedTextMessage,
            contextInfo: {
              ...message.extendedTextMessage.contextInfo,
              mentionedJid: [ME.id],
            },
            text: "@Atlas continue",
          },
        },
      },
      ME
    );
    expect(explicitlyAddressed?.quotedParticipant).toBeNull();
    expect(explicitlyAddressed?.quotedText).toBeNull();
    expect(explicitlyAddressed?.quotedMessageId).toBeNull();
  });

  test("handles captionless group media when explicitly replying to the bot", () => {
    const parsed = parseInboundWhatsAppMessage(
      {
        key: {
          participant: "628122222222@s.whatsapp.net",
          remoteJid: GROUP_JID,
        },
        message: {
          documentMessage: {
            contextInfo: { participant: ME.id },
            fileName: "report.pdf",
            mimetype: "application/pdf",
          },
        },
      },
      ME
    );

    expect(parsed?.isGroup).toBe(true);
    expect(parsed?.text).toBe("");
  });

  test.each([
    ["report.pdf", "application/pdf"],
    [
      "workbook.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    ["photo.png", "image/png"],
    ["photo.png", "application/octet-stream"],
  ])(
    "routes an unmentioned group document %s (%s) to the authorized handler",
    (fileName, mimetype) => {
      const parsed = parseInboundWhatsAppMessage(
        {
          key: {
            participant: "628122222222@s.whatsapp.net",
            remoteJid: GROUP_JID,
          },
          message: {
            documentMessage: {
              fileName,
              mimetype,
            },
          },
        },
        ME
      );
      expect(parsed?.isGroup).toBe(true);
      expect(parsed?.mentionedJids).toEqual([]);
      expect(parsed?.text).toBe("");
      expect(parsed?.senderJid).toBe("628122222222@s.whatsapp.net");
    }
  );

  test("routes an unmentioned captioned group photo to the authorized handler", () => {
    expect(
      parseInboundWhatsAppMessage(
        {
          key: {
            participant: "628122222222@s.whatsapp.net",
            remoteJid: GROUP_JID,
          },
          message: {
            imageMessage: {
              caption: "Read this chart",
              mimetype: "image/jpeg",
            },
          },
        },
        ME
      )
    ).toMatchObject({
      isGroup: true,
      mentionedJids: [],
      text: "Read this chart",
    });
  });

  test.each([
    "photo.jpg",
    "photo.jpeg",
    "photo.png",
    "photo.webp",
    "photo.gif",
  ])("recognizes %s sent as a generic document as image media", (filename) => {
    expect(
      inspectInboundWhatsAppMedia({
        documentMessage: {
          fileName: filename,
          mimetype: "application/octet-stream",
        },
      })
    ).toMatchObject({ filename, kind: "image" });
  });
});
