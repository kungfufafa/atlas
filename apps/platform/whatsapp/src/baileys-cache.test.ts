import { describe, expect, test } from "bun:test";
import { initAuthCreds, makeEventBuffer, proto } from "@whiskeysockets/baileys";
import processMessage from "@whiskeysockets/baileys/lib/Utils/process-message.js";
import { WhatsAppProtocolCache } from "./baileys-cache";
import { createBaileysLogger } from "./baileys-logger";

describe("WhatsApp protocol cache", () => {
  test("Baileys recovers a real placeholder response with a null stanza ID", async () => {
    const logger = createBaileysLogger();
    const ev = makeEventBuffer(logger);
    const creds = initAuthCreds();
    creds.me = { id: "620000000001@s.whatsapp.net" };
    const recovered = new Promise<string | null | undefined>((resolve) => {
      ev.on("messages.upsert", ({ messages }) =>
        resolve(messages[0]?.message?.conversation)
      );
    });
    const bytes = proto.WebMessageInfo.encode({
      key: {
        id: "recovered-message",
        remoteJid: "620000000002@s.whatsapp.net",
      },
      message: { conversation: "recovered original" },
    }).finish();
    await processMessage(
      {
        key: { fromMe: true, remoteJid: creds.me.id },
        message: {
          protocolMessage: {
            peerDataOperationRequestResponseMessage: {
              peerDataOperationResult: [
                {
                  placeholderMessageResendResponse: {
                    webMessageInfoBytes: bytes,
                  },
                },
              ],
              stanzaId: null,
            },
            type: proto.Message.ProtocolMessage.Type
              .PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
          },
        },
      },
      {
        creds,
        ev,
        keyStore: {
          get: async () => ({}),
          isInTransaction: () => false,
          set: async () => {},
          transaction: async (operation) => await operation(),
        },
        logger,
        options: {},
        placeholderResendCache: new WhatsAppProtocolCache({ ttlMs: 1000 }),
        shouldProcessHistoryMsg: false,
      }
    );
    expect(await recovered).toBe("recovered original");
  });

  test("accepts missing peer-response stanza IDs without throwing or aliasing real keys", () => {
    const cache = new WhatsAppProtocolCache({ ttlMs: 1000 });
    cache.set("null", "legitimate stanza");
    for (const key of [null, undefined, {}, 123, ""]) {
      cache.set(key, "ignored");
      expect(cache.get(key)).toBeUndefined();
      expect(() => cache.del(key)).not.toThrow();
    }
    expect(cache.get("null")).toBe("legitimate stanza");
  });

  test("retains exhausted retry counters across Baileys deletions until expiry", () => {
    let now = 0;
    const cache = new WhatsAppProtocolCache({
      now: () => now,
      retainAtRetryLimit: 5,
      ttlMs: 1000,
    });
    cache.set("failed-message", 5);
    cache.del("failed-message");
    expect(cache.get("failed-message")).toBe(5);
    now = 1000;
    expect(cache.get("failed-message")).toBeUndefined();
  });

  test("bounds memory, expires values, and permits normal placeholder deletion", () => {
    let now = 0;
    const cache = new WhatsAppProtocolCache({
      maxEntries: 2,
      now: () => now,
      ttlMs: 1000,
    });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    cache.del("b");
    expect(cache.get("b")).toBeUndefined();
    now = 1000;
    expect(cache.get("c")).toBeUndefined();
    cache.set("d", 4);
    cache.flushAll();
    expect(cache.get("d")).toBeUndefined();
  });
});
