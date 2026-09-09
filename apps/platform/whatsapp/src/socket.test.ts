import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WhatsAppDeliveryRetryableError,
  WhatsAppInboundReplaySafeError,
} from "./delivery-error";
import { InboundDeliveryLedger } from "./inbound-delivery-ledger";
import {
  BusyReplyLimiter,
  buildInboundDeliveryId,
  claimInboundDelivery,
  createInboundMessageDedupe,
  detachWhatsAppSocketListeners,
  dispatchWhatsAppMessagesConcurrently,
  extractDisconnectStatusCode,
  isSupportedUpsertType,
  runClaimedInboundDelivery,
  settleFailedInboundDelivery,
  shouldRequestDevicePairingCode,
  summarizeMissingTextPayload,
  whatsAppReconnectDelayMs,
} from "./socket";

describe("WhatsApp socket helpers", () => {
  test("dispatches independent items without waiting for an earlier item", async () => {
    const started: number[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const pending = dispatchWhatsAppMessagesConcurrently(
      [1, 2],
      async (item) => {
        started.push(item);
        if (item === 1) {
          await firstBlocked;
        }
      }
    );

    await Bun.sleep(0);
    expect(started).toEqual([1, 2]);
    releaseFirst();
    await pending;
  });

  test("removes every bridge listener before retiring a socket", () => {
    const removed: string[] = [];
    detachWhatsAppSocketListeners({
      ev: {
        removeAllListeners: (event) => {
          removed.push(event);
        },
      },
    });

    expect(removed).toEqual([
      "chats.phoneNumberShare",
      "connection.update",
      "creds.update",
      "messages.upsert",
      "messages.reaction",
    ]);
  });

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

  test("scopes durable delivery ids to the chat and group participant", () => {
    const firstSender = buildInboundDeliveryId({
      messageId: "message-1",
      participant: "sender-a@s.whatsapp.net",
      remoteJid: "group@g.us",
    });
    const secondSender = buildInboundDeliveryId({
      messageId: "message-1",
      participant: "sender-b@s.whatsapp.net",
      remoteJid: "group@g.us",
    });
    const direct = buildInboundDeliveryId({
      messageId: "message-1",
      remoteJid: "sender-a@s.whatsapp.net",
    });

    expect(firstSender).toHaveLength(64);
    expect(firstSender).not.toBe(secondSender);
    expect(firstSender).not.toBe(direct);
    expect(firstSender).not.toContain("sender-a");
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

  test("rate-limits overload replies per chat and globally", () => {
    let now = 1000;
    const limiter = new BusyReplyLimiter({
      cooldownMs: 100,
      globalLimit: 2,
      now: () => now,
      windowMs: 1000,
    });

    expect(limiter.allow("chat-a")).toBe(true);
    expect(limiter.allow("chat-a")).toBe(false);
    expect(limiter.allow("chat-b")).toBe(true);
    expect(limiter.allow("chat-c")).toBe(false);

    now += 1000;
    expect(limiter.allow("chat-a")).toBe(true);
    expect(limiter.allow("chat-c")).toBe(true);
  });

  test("records outbound delivery failures instead of replaying the agent turn", async () => {
    const completed: string[] = [];
    const released: string[] = [];
    const disposition = await settleFailedInboundDelivery({
      deliveryId: "delivery-1",
      error: new WhatsAppDeliveryRetryableError("outbound failed"),
      ledger: {
        complete: async (id) => {
          completed.push(id);
        },
        release: (id) => {
          released.push(id);
        },
      },
    });

    expect(disposition).toBe("delivery-error-recorded");
    expect(completed).toEqual(["delivery-1"]);
    expect(released).toEqual([]);
  });

  test("retries a claimed inbound delivery locally before completing it", async () => {
    const completed: string[] = [];
    const released: string[] = [];
    const delays: number[] = [];
    let calls = 0;

    const result = await runClaimedInboundDelivery({
      deliver: async () => {
        calls += 1;
        if (calls < 3) {
          throw new WhatsAppInboundReplaySafeError("temporary handler failure");
        }
      },
      deliveryId: "delivery-retry-success",
      ledger: {
        complete: async (id) => {
          completed.push(id);
        },
        release: (id) => {
          released.push(id);
        },
      },
      retryBaseDelayMs: 10,
      wait: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(result).toEqual({ attempts: 3, disposition: "completed" });
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);
    expect(completed).toEqual(["delivery-retry-success"]);
    expect(released).toEqual([]);
  });

  test("releases a claimed inbound delivery after exhausting local retries", async () => {
    const completed: string[] = [];
    const released: string[] = [];
    const failure = new WhatsAppInboundReplaySafeError(
      "persistent handler failure"
    );
    let calls = 0;

    const result = await runClaimedInboundDelivery({
      deliver: async () => {
        calls += 1;
        throw failure;
      },
      deliveryId: "delivery-retry-exhausted",
      ledger: {
        complete: async (id) => {
          completed.push(id);
        },
        release: (id) => {
          released.push(id);
        },
      },
      retryBaseDelayMs: 0,
    });

    expect(result).toEqual({
      attempts: 3,
      disposition: "released-for-provider-replay",
      error: failure,
    });
    expect(calls).toBe(3);
    expect(completed).toEqual([]);
    expect(released).toEqual(["delivery-retry-exhausted"]);
  });

  test("does not retry an outbound delivery failure with an unknown outcome", async () => {
    const completed: string[] = [];
    const released: string[] = [];
    const failure = new WhatsAppDeliveryRetryableError("outbound failed");
    let calls = 0;

    const result = await runClaimedInboundDelivery({
      deliver: async () => {
        calls += 1;
        throw failure;
      },
      deliveryId: "delivery-unknown-outcome",
      ledger: {
        complete: async (id) => {
          completed.push(id);
        },
        release: (id) => {
          released.push(id);
        },
      },
      wait: async () => {
        throw new Error("delivery errors must not schedule a retry");
      },
    });

    expect(result).toEqual({
      attempts: 1,
      disposition: "delivery-error-recorded",
      error: failure,
    });
    expect(calls).toBe(1);
    expect(completed).toEqual(["delivery-unknown-outcome"]);
    expect(released).toEqual([]);
  });

  test("does not retry an unmarked failure after the agent boundary", async () => {
    const completed: string[] = [];
    const released: string[] = [];
    const failure = new Error("session state save failed after agent turn");
    let agentTurns = 0;

    const result = await runClaimedInboundDelivery({
      deliver: async () => {
        agentTurns += 1;
        throw failure;
      },
      deliveryId: "delivery-post-agent-failure",
      ledger: {
        complete: async (id) => {
          completed.push(id);
        },
        release: (id) => {
          released.push(id);
        },
      },
      wait: async () => {
        throw new Error("unmarked failures must not schedule a retry");
      },
    });

    expect(result).toEqual({
      attempts: 1,
      disposition: "delivery-error-recorded",
      error: failure,
    });
    expect(agentTurns).toBe(1);
    expect(completed).toEqual(["delivery-post-agent-failure"]);
    expect(released).toEqual([]);
  });

  test("persists a successful inbound retry across ledger restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-wa-retry-ledger-"));
    const path = join(directory, "inbound.jsonl");

    try {
      const ledger = new InboundDeliveryLedger(path);
      await ledger.load();
      expect(ledger.claim("delivery-retry-persisted")).toBe(true);
      let calls = 0;

      const result = await runClaimedInboundDelivery({
        deliver: async () => {
          calls += 1;
          if (calls === 1) {
            throw new WhatsAppInboundReplaySafeError(
              "temporary handler failure"
            );
          }
        },
        deliveryId: "delivery-retry-persisted",
        ledger,
        retryBaseDelayMs: 0,
      });

      expect(result).toEqual({ attempts: 2, disposition: "completed" });
      const restarted = new InboundDeliveryLedger(path);
      await restarted.load();
      expect(restarted.claim("delivery-retry-persisted")).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("releases the claim when the socket generation changes during backoff", async () => {
    const released: string[] = [];
    let current = true;
    let calls = 0;

    const result = await runClaimedInboundDelivery({
      deliver: async () => {
        calls += 1;
        throw new WhatsAppInboundReplaySafeError("temporary handler failure");
      },
      deliveryId: "delivery-stale-generation",
      isCurrent: () => current,
      ledger: {
        complete: async () => undefined,
        release: (id) => {
          released.push(id);
        },
      },
      wait: async () => {
        current = false;
      },
    });

    expect(result).toEqual({
      attempts: 1,
      disposition: "released-stale",
    });
    expect(calls).toBe(1);
    expect(released).toEqual(["delivery-stale-generation"]);
  });

  test("persists the no-replay outcome for an outbound delivery failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-wa-failed-send-"));
    const path = join(directory, "inbound.jsonl");

    try {
      const ledger = new InboundDeliveryLedger(path);
      await ledger.load();
      expect(ledger.claim("delivery-1")).toBe(true);

      expect(
        await settleFailedInboundDelivery({
          deliveryId: "delivery-1",
          error: new WhatsAppDeliveryRetryableError("outbound failed"),
          ledger,
        })
      ).toBe("delivery-error-recorded");

      const restarted = new InboundDeliveryLedger(path);
      await restarted.load();
      expect(restarted.claim("delivery-1")).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("releases replay-safe failures for a provider replay", async () => {
    const completed: string[] = [];
    const released: string[] = [];
    const disposition = await settleFailedInboundDelivery({
      deliveryId: "delivery-2",
      error: new WhatsAppInboundReplaySafeError(
        "handler failed before delivery"
      ),
      ledger: {
        complete: async (id) => {
          completed.push(id);
        },
        release: (id) => {
          released.push(id);
        },
      },
    });

    expect(disposition).toBe("released-for-provider-replay");
    expect(completed).toEqual([]);
    expect(released).toEqual(["delivery-2"]);
  });
});
