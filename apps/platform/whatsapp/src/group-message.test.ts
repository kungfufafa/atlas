import { describe, expect, test } from "bun:test";
import {
  explainWhatsAppGroupMessageHandling,
  isWhatsAppBotAddress,
  isWhatsAppGroupChat,
  parseSupportedWhatsAppGroupCommand,
  resolveWhatsAppChannelOrgKey,
  stripWhatsAppBotMention,
  type WhatsAppAccount,
} from "./group-message";

const BOT: WhatsAppAccount = {
  id: "628100000000:12@s.whatsapp.net",
  lid: "236283431522503:0@lid",
};

describe("WhatsApp group message helpers", () => {
  test("recognizes group JIDs and scopes org selection by chat", () => {
    expect(isWhatsAppGroupChat("120363042000000000@g.us")).toBe(true);
    expect(isWhatsAppGroupChat("628100000000@s.whatsapp.net")).toBe(false);
    expect(resolveWhatsAppChannelOrgKey("120363042000000000@g.us", true)).toBe(
      "g:120363042000000000@g.us"
    );
    expect(
      resolveWhatsAppChannelOrgKey("628100000000@s.whatsapp.net", false)
    ).toBe("628100000000@s.whatsapp.net");
  });

  test("normalizes device and LID variants of the bot identity", () => {
    expect(isWhatsAppBotAddress("628100000000@s.whatsapp.net", BOT)).toBe(true);
    expect(isWhatsAppBotAddress("628100000000:99@s.whatsapp.net", BOT)).toBe(
      true
    );
    expect(isWhatsAppBotAddress("236283431522503@lid", BOT)).toBe(true);
    expect(isWhatsAppBotAddress("628199999999@s.whatsapp.net", BOT)).toBe(
      false
    );
  });

  test("accepts bot mentions and replies to either bot identity", () => {
    expect(
      explainWhatsAppGroupMessageHandling({
        me: BOT,
        mentionedJids: ["628100000000@s.whatsapp.net"],
        quotedParticipant: null,
        text: "@Atlas hello",
      })
    ).toEqual({ reason: "bot-mention", shouldHandle: true });
    expect(
      explainWhatsAppGroupMessageHandling({
        me: BOT,
        mentionedJids: [],
        quotedParticipant: "236283431522503@lid",
        text: "follow up",
      })
    ).toEqual({ reason: "reply-to-bot", shouldHandle: true });
  });

  test("allows only supported slash commands", () => {
    expect(parseSupportedWhatsAppGroupCommand("/status now")).toBe("/status");
    expect(parseSupportedWhatsAppGroupCommand("/attach")).toBe("/attach");
    expect(parseSupportedWhatsAppGroupCommand("/profile research")).toBe(
      "/profile"
    );
    expect(parseSupportedWhatsAppGroupCommand("/unknown")).toBeNull();
    expect(
      explainWhatsAppGroupMessageHandling({
        mentionedJids: [],
        quotedParticipant: null,
        text: "/help",
      }).shouldHandle
    ).toBe(true);
    expect(
      explainWhatsAppGroupMessageHandling({
        mentionedJids: [],
        quotedParticipant: null,
        text: "/profile research",
      })
    ).toEqual({ reason: "slash-command", shouldHandle: true });
    expect(
      explainWhatsAppGroupMessageHandling({
        mentionedJids: [],
        quotedParticipant: null,
        text: "/unknown",
      })
    ).toEqual({ reason: "unsupported-command", shouldHandle: false });
    expect(
      explainWhatsAppGroupMessageHandling({
        me: BOT,
        mentionedJids: [BOT.id],
        quotedParticipant: null,
        text: "/unknown @Atlas",
      })
    ).toEqual({ reason: "bot-mention", shouldHandle: true });
  });

  test("ignores unaddressed messages and mentions when bot identity is missing", () => {
    expect(
      explainWhatsAppGroupMessageHandling({
        me: BOT,
        mentionedJids: [],
        quotedParticipant: null,
        text: "hello everyone",
      })
    ).toEqual({ reason: "no-trigger", shouldHandle: false });
    expect(
      explainWhatsAppGroupMessageHandling({
        mentionedJids: [BOT.id],
        quotedParticipant: null,
        text: "@Atlas hello",
      })
    ).toEqual({ reason: "missing-bot-info", shouldHandle: false });
  });

  test("removes only the textual mention mapped to the bot", () => {
    expect(
      stripWhatsAppBotMention({
        me: BOT,
        mentionedJids: [
          "628122222222@s.whatsapp.net",
          "628100000000@s.whatsapp.net",
        ],
        text: "@Alice @Atlas please compare these",
      })
    ).toBe("@Alice please compare these");
    expect(
      stripWhatsAppBotMention({
        me: BOT,
        mentionedJids: ["628100000000:77@s.whatsapp.net"],
        text: "@Atlas hello",
      })
    ).toBe("hello");
  });
});
