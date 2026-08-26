import { describe, expect, test } from "bun:test";
import { SYNTHETIC_SECRET_FIXTURES } from "../testing/synthetic-secret-fixtures";
import {
  assertOutboundEnvelope,
  OutboundEnvelopeError,
  revalidateOutboundAllowlist,
} from "./outbound-envelope";

describe("outbound envelope", () => {
  test("requires orgId and replyTarget", () => {
    expect(() =>
      assertOutboundEnvelope({ replyTarget: undefined, text: "hi" })
    ).toThrow(OutboundEnvelopeError);
    expect(() =>
      assertOutboundEnvelope({
        orgId: "org_1",
        text: "hi",
      })
    ).toThrow(/replyTarget/);
  });

  test("redacts secrets in outbound text", () => {
    const envelope = assertOutboundEnvelope({
      orgId: "org_1",
      replyTarget: { channel: "telegram", telegram: { chatId: 42 } },
      text: `token=${SYNTHETIC_SECRET_FIXTURES.openAiApiKey}`,
    });
    expect(envelope.text).not.toContain(SYNTHETIC_SECRET_FIXTURES.openAiApiKey);
  });

  test("revalidates telegram replyTarget against paired allowlist", () => {
    const envelope = assertOutboundEnvelope({
      orgId: "org_1",
      replyTarget: { channel: "telegram", telegram: { chatId: 99 } },
      text: "hello",
    });
    expect(() =>
      revalidateOutboundAllowlist(envelope, {
        accessMode: "pairing",
        pairedUserIds: [42],
      })
    ).toThrow(/not paired/);

    expect(() =>
      revalidateOutboundAllowlist(
        assertOutboundEnvelope({
          orgId: "org_1",
          replyTarget: { channel: "telegram", telegram: { chatId: 42 } },
          text: "hello",
        }),
        { accessMode: "pairing", pairedUserIds: [42] }
      )
    ).not.toThrow();
  });

  test("blocks denylisted destinations", () => {
    const envelope = assertOutboundEnvelope({
      orgId: "org_1",
      replyTarget: { channel: "telegram", telegram: { chatId: 7 } },
      text: "hello",
    });
    expect(() =>
      revalidateOutboundAllowlist(envelope, {
        accessMode: "open",
        blockedUserIds: [7],
      })
    ).toThrow(/blocked/);
  });
});
