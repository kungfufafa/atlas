import { describe, expect, test } from "bun:test";
import {
  claimInboundDelivery,
  createInboundMessageDedupe,
  extractDisconnectStatusCode,
  isSupportedUpsertType,
  shouldRequestDevicePairingCode,
  summarizeMissingTextPayload,
  whatsAppReconnectDelayMs,
} from "./socket";

describe("WhatsApp socket helpers", () => {
  test("backs off 408 reconnects exponentially up to 30s", () => {
    expect(whatsAppReconnectDelayMs(0)).toBe(1000);
    expect(whatsAppReconnectDelayMs(1)).toBe(2000);
    expect(whatsAppReconnectDelayMs(5)).toBe(30_000);
    expect(whatsAppReconnectDelayMs(8)).toBe(30_000);
  });

  test("reads disconnect status from Boom output even without an error message", () => {
    expect(
      extractDisconnectStatusCode({
        error: { output: { statusCode: 401 } },
      })
    ).toBe(401);
    expect(extractDisconnectStatusCode({ statusCode: 515 })).toBe(515);
    expect(extractDisconnectStatusCode(undefined)).toBeUndefined();
  });

  test("accepts notify and append upserts", () => {
    expect(isSupportedUpsertType("notify")).toBe(true);
    expect(isSupportedUpsertType("append")).toBe(true);
    expect(isSupportedUpsertType("prepend")).toBe(false);
  });

  test("drops duplicate inbound message ids", () => {
    const dedupe = createInboundMessageDedupe(60_000);
    expect(dedupe.remember("jid:msg-1")).toBe(true);
    expect(dedupe.remember("jid:msg-1")).toBe(false);
    expect(dedupe.remember("jid:msg-2")).toBe(true);
  });

  test("requests a device pairing code only for unregistered numbers", () => {
    expect(
      shouldRequestDevicePairingCode({
        alreadyRequested: false,
        phoneDigits: "628123456789",
        registered: false,
      })
    ).toBe(true);
    expect(
      shouldRequestDevicePairingCode({
        alreadyRequested: true,
        phoneDigits: "628123456789",
        registered: false,
      })
    ).toBe(false);
    expect(
      shouldRequestDevicePairingCode({
        alreadyRequested: false,
        phoneDigits: "628123456789",
        registered: true,
      })
    ).toBe(false);
    expect(
      shouldRequestDevicePairingCode({
        alreadyRequested: false,
        phoneDigits: "62812",
        registered: false,
      })
    ).toBe(false);
  });

  test("does not consume a message id until the upsert is deliverable", () => {
    const dedupe = createInboundMessageDedupe(60_000);
    const stub = {
      messageId: "msg-1",
      remoteJid: "628123@s.whatsapp.net",
      shouldHandle: false,
    };
    const real = { ...stub, shouldHandle: true };

    expect(claimInboundDelivery(dedupe, stub)).toBe(false);
    expect(claimInboundDelivery(dedupe, real)).toBe(true);
    expect(claimInboundDelivery(dedupe, real)).toBe(false);
  });

  test("diagnostic summaries omit message content and WhatsApp identities", () => {
    const summary = summarizeMissingTextPayload({
      key: {
        fromMe: false,
        id: "private-message-id",
        participant: "628123456789@s.whatsapp.net",
        remoteJid: "628999999999@s.whatsapp.net",
      },
      message: {
        documentMessage: {
          caption: "confidential report",
          fileName: "payroll-secret.pdf",
        },
      },
      messageStubType: 1,
    });

    expect(summary).not.toContain("private-message-id");
    expect(summary).not.toContain("628123456789");
    expect(summary).not.toContain("628999999999");
    expect(summary).not.toContain("confidential report");
    expect(summary).not.toContain("payroll-secret.pdf");
  });
});
