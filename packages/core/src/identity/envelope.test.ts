import { describe, expect, test } from "bun:test";
import { assertChannelEnvelope, PrincipalRequiredError } from "./principal";

describe("ChannelEnvelope", () => {
  test("requires org, principal, profile, conversation, and replyTarget", () => {
    const envelope = assertChannelEnvelope({
      canonicalPrincipal: {
        isPlatformAdmin: false,
        orgId: "org_1",
        orgRole: "member",
        userId: "user_1",
      },
      conversationId: "chat_1",
      orgId: "org_1",
      profileId: "profile_1",
      replyTarget: { channel: "telegram", telegram: { chatId: 42 } },
    });
    expect(envelope.canonicalPrincipal.userId).toBe("user_1");
    expect(() =>
      assertChannelEnvelope({
        ...envelope,
        orgId: "org_other",
      })
    ).toThrow(PrincipalRequiredError);
  });
});
