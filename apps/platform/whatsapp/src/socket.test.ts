import { describe, expect, test } from "bun:test";
import {
  claimInboundDelivery,
  createInboundMessageDedupe,
  extractDisconnectStatusCode,
  isSupportedUpsertType,
} from "./socket";

describe("WhatsApp socket helpers", () => {
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
});
