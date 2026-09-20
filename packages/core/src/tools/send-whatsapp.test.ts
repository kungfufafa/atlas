import { describe, expect, test } from "bun:test";
import { evaluateActionRisk } from "../risk-engine";
import { runSendWhatsApp, sendWhatsAppTool } from "./send-whatsapp";

describe("send_whatsapp", () => {
  test("sends from the workspace paired number to the given destination", async () => {
    const calls: Array<{ orgId: string; text: string; to: string }> = [];
    const result = await runSendWhatsApp(
      { text: "Meeting jam 3", to: "6289500000001" },
      { orgId: "org_finance" },
      async (payload) => {
        calls.push(payload);
        return { ok: true };
      }
    );

    expect(result).toEqual({ ok: true, to: "6289500000001" });
    expect(calls).toEqual([
      {
        orgId: "org_finance",
        text: "Meeting jam 3",
        to: "6289500000001",
      },
    ]);
  });

  test("fails when the workspace WhatsApp is not paired", async () => {
    const result = await runSendWhatsApp(
      { text: "hi", to: "6289500000001" },
      { orgId: "org_finance" },
      async () => ({ error: "WhatsApp is not paired.", ok: false })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not paired");
    }
  });

  test("fails without organization context", async () => {
    const result = await runSendWhatsApp(
      { text: "hi", to: "6289500000001" },
      {},
      async () => {
        throw new Error("should not send");
      }
    );

    expect(result.ok).toBe(false);
  });

  test("does not let an internal channel guest relay outbound messages", async () => {
    let sendCalls = 0;
    const result = await runSendWhatsApp(
      { text: "relay this", to: "6289500000001" },
      {
        orgId: "org_finance",
        userId: "user_channel_guest_0123456789abcdef",
      },
      async () => {
        sendCalls += 1;
        return { ok: true };
      }
    );

    expect(result).toEqual({
      error: "Channel guest principals cannot send outbound WhatsApp messages.",
      ok: false,
    });
    expect(sendCalls).toBe(0);
  });

  test("fails when the destination is not a phone number", async () => {
    const result = await runSendWhatsApp(
      { text: "hi", to: "236283431522503@lid" },
      { orgId: "org_finance" },
      async () => {
        throw new Error("should not send");
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("phone number");
    }
  });

  test("is registered as send_whatsapp", () => {
    expect(sendWhatsAppTool.name).toBe("send_whatsapp");
  });
});

describe("send_whatsapp batches", () => {
  test("the complete recipient list remains one approval-gated external action", () => {
    const risk = evaluateActionRisk("send_whatsapp", {
      text: "hi",
      to: ["6289500000001", "6289500000002"],
    });
    expect(risk.requiresApproval).toBe(true);
    expect(risk.actionClass).toBe("EXTERNAL_COMMUNICATION");
  });

  test("sends six approved destinations once each and preserves per-recipient receipts", async () => {
    const to = Array.from({ length: 6 }, (_, i) => `628950000000${i + 1}`);
    const calls: string[] = [];
    const result = await runSendWhatsApp(
      { text: "Meeting jam 3", to },
      { orgId: "org_finance" },
      async (payload) => {
        calls.push(payload.to);
        return { ok: true };
      }
    );
    expect(calls).toEqual(to);
    expect(result).toEqual({
      ok: true,
      results: to.map((number) => ({ ok: true, status: "sent", to: number })),
    });
  });

  test("validates all destinations before sending any and bounds batch size", async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      return { ok: true };
    };
    const invalid = await runSendWhatsApp(
      { text: "hi", to: ["6289500000001", "236283431522503@lid"] },
      { orgId: "org_finance" },
      send
    );
    expect(invalid.ok).toBe(false);
    await expect(
      runSendWhatsApp(
        { text: "hi", to: Array(51).fill("6289500000001") },
        { orgId: "org_finance" },
        send
      )
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("deduplicates phone aliases and retains successes when another send is unconfirmed", async () => {
    const calls: string[] = [];
    const result = await runSendWhatsApp(
      {
        text: "hi",
        to: [
          "+62 895 0000 0001",
          "6289500000001",
          "6289500000002",
          "6289500000003",
        ],
      },
      { orgId: "org_finance" },
      async (payload) => {
        calls.push(payload.to);
        if (payload.to.endsWith("2")) {
          throw new Error("transport interrupted");
        }
        return { ok: true };
      }
    );
    expect(calls).toEqual([
      "+62 895 0000 0001",
      "6289500000002",
      "6289500000003",
    ]);
    expect(result).toMatchObject({
      ok: false,
      results: [
        { ok: true, status: "sent" },
        { ok: false, status: "unconfirmed", to: "6289500000002" },
        { ok: true, status: "sent" },
      ],
    });
  });

  test.each(["cancel", "revoke"] as const)(
    "%s stops remaining recipients and retains sent receipts",
    async (mode) => {
      const controller = new AbortController();
      let calls = 0;
      const result = await runSendWhatsApp(
        { text: "hi", to: ["6289500000001", "6289500000002", "6289500000003"] },
        {
          beforeToolCall: async () => {
            if (mode === "revoke" && calls > 0) {
              throw new Error("Access revoked");
            }
          },
          orgId: "org_finance",
          signal: controller.signal,
        },
        async () => {
          calls += 1;
          if (mode === "cancel") {
            controller.abort();
          }
          return { ok: true };
        }
      );
      expect(calls).toBe(1);
      expect(result).toMatchObject({
        ok: false,
        results: [
          { status: "sent" },
          { status: "not_sent" },
          { status: "not_sent" },
        ],
      });
    }
  );
});
