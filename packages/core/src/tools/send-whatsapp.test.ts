import { describe, expect, test } from "bun:test";
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
