import { describe, expect, test } from "bun:test";
import type {
  ChannelNativeAction,
  ChannelNativeActionRequest,
} from "@atlas/core/channel-native-actions";
import {
  type AnyMessageContent,
  generateWAMessageContent,
  proto,
} from "@whiskeysockets/baileys";
import {
  executeWhatsAppNativeAction,
  WhatsAppMessageRegistry,
} from "./native-actions";
import type { WhatsAppNativeBinding } from "./native-controls";

const binding: WhatsAppNativeBinding = {
  channelUserAliases: [],
  channelUserId: "628111@s.whatsapp.net",
  destination: "120000@g.us",
  orgId: "org-a",
  profileId: "profile-a",
  sessionId: "session-a",
  userId: "user-a",
};
function request(action: ChannelNativeAction): ChannelNativeActionRequest {
  return {
    action,
    channel: "whatsapp",
    channelChatId: binding.destination,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    id: "request-a",
    orgId: binding.orgId,
    profileId: binding.profileId,
    sessionId: binding.sessionId,
  };
}
function fixture() {
  const registry = new WhatsAppMessageRegistry();
  registry.remember(binding, {
    fromMe: false,
    id: "inbound",
    participant: binding.channelUserId,
    remoteJid: binding.destination,
  });
  registry.remember(binding, {
    fromMe: true,
    id: "outbound",
    remoteJid: binding.destination,
  });
  const bodies: AnyMessageContent[] = [];
  const wire: proto.IMessage[] = [];
  const socket = {
    sendMessage: async (jid: string, body: AnyMessageContent) => {
      bodies.push(body);
      const generated = await generateWAMessageContent(body, {
        userJid: "628999@s.whatsapp.net",
      } as never);
      wire.push(proto.Message.decode(proto.Message.encode(generated).finish()));
      return {
        key: { fromMe: true, id: `sent-${bodies.length}`, remoteJid: jid },
      };
    },
  };
  const run = (
    action: ChannelNativeAction,
    overrides: Partial<Parameters<typeof executeWhatsAppNativeAction>[0]> = {}
  ) =>
    executeWhatsAppNativeAction({
      binding,
      currentMessageId: "inbound",
      readMedia: async () => {
        throw new Error("File access not authorized");
      },
      registry,
      request: request(action),
      socket: socket as never,
      ...overrides,
    });
  return { bodies, registry, run, wire };
}

describe("WhatsApp native action transport with installed Baileys protobuf encoding", () => {
  test("cancellation or fresh policy denial after preparation prevents the native send", async () => {
    const f = fixture();
    expect(
      (
        await f.run(
          { kind: "poll", options: ["A", "B"], question: "Q" },
          {
            beforeSend: async () => {
              throw new Error("Action disabled during preparation");
            },
          }
        )
      ).status
    ).toBe("failed");
    expect(
      (
        await f.run(
          { emoji: "👍", kind: "react" },
          { signal: AbortSignal.abort() }
        )
      ).status
    ).toBe("failed");
    expect(f.bodies.length).toBe(0);
  });
  test("reaction, poll, edit and delete encode actual supported payloads for bound targets", async () => {
    const f = fixture();
    for (const action of [
      { emoji: "👍", kind: "react" },
      { kind: "poll", options: ["Today", "Tomorrow"], question: "When?" },
      { kind: "edit", messageId: "outbound", text: "Corrected" },
      { kind: "delete", messageId: "outbound" },
    ] satisfies ChannelNativeAction[]) {
      expect((await f.run(action)).status).toBe("accepted");
    }
    expect(f.bodies.length).toBe(4);
    expect(f.wire[0]?.reactionMessage?.key?.id).toBe("inbound");
    expect(f.wire[0]?.reactionMessage?.key?.remoteJid).toBe(
      binding.destination
    );
    const poll =
      f.wire[1]?.pollCreationMessageV3 ?? f.wire[1]?.pollCreationMessage;
    expect(poll?.options?.map((option) => option.optionName)).toEqual([
      "Today",
      "Tomorrow",
    ]);
    expect(f.wire[2]?.protocolMessage?.key?.id).toBe("outbound");
    expect(f.wire[3]?.protocolMessage?.key?.id).toBe("outbound");
  });

  test("foreign org, profile, session, chat, thread, expired request and unobserved targets have zero native effects", async () => {
    const f = fixture();
    for (const change of [
      { orgId: "other" },
      { profileId: "other" },
      { sessionId: "other" },
      { channelChatId: "other@g.us" },
      { channelThreadId: "other" },
      { expiresAt: new Date(0).toISOString() },
    ]) {
      expect(
        (
          await f.run(
            { emoji: "👍", kind: "react" },
            {
              request: {
                ...request({ emoji: "👍", kind: "react" }),
                ...change,
              },
            }
          )
        ).status
      ).toBe("failed");
    }
    expect((await f.run({ kind: "delete", messageId: "foreign" })).status).toBe(
      "failed"
    );
    expect(
      (await f.run({ kind: "edit", messageId: "inbound", text: "Forged" }))
        .status
    ).toBe("failed");
    expect((await f.run({ kind: "delete", messageId: "inbound" })).status).toBe(
      "failed"
    );
    expect(f.bodies.length).toBe(0);
  });

  test("registry cannot widen a message from another tenant or turn it into a bot-owned message", async () => {
    const f = fixture();
    f.registry.remember(
      { ...binding, orgId: "other" },
      { fromMe: true, id: "foreign", remoteJid: binding.destination }
    );
    f.registry.remember(binding, {
      fromMe: true,
      id: "inbound",
      remoteJid: binding.destination,
    });
    expect((await f.run({ kind: "delete", messageId: "foreign" })).status).toBe(
      "failed"
    );
    expect((await f.run({ kind: "delete", messageId: "inbound" })).status).toBe(
      "failed"
    );
    expect(f.bodies.length).toBe(0);
  });

  test("unsupported channel operations and unsupported poll semantics fail explicitly", async () => {
    const f = fixture();
    const actions: ChannelNativeAction[] = [
      { kind: "pin", messageId: "outbound" },
      { kind: "unpin", messageId: "outbound" },
      { kind: "topic_create", name: "Topic" },
      { closed: true, kind: "topic_edit" },
      { kind: "thread_create", name: "Thread" },
      { anonymous: true, kind: "poll", options: ["A", "B"], question: "Q" },
      { durationHours: 1, kind: "poll", options: ["A", "B"], question: "Q" },
      { kind: "poll", options: ["A", "A"], question: "Q" },
    ];
    for (const action of actions) {
      expect((await f.run(action)).status).toBe("failed");
    }
    expect(f.bodies.length).toBe(0);
  });

  test("failed file admission never sends; uncertain send acknowledgement never retries", async () => {
    const f = fixture();
    expect(
      (
        await f.run({
          kind: "send_media",
          mode: "voice",
          path: "artifacts/private.wav",
        })
      ).status
    ).toBe("failed");
    expect(f.bodies.length).toBe(0);
    let sends = 0;
    expect(
      (
        await f.run(
          { emoji: "👍", kind: "react" },
          {
            socket: {
              sendMessage: async () => {
                sends += 1;
                throw new Error("after acceptance");
              },
            } as never,
          }
        )
      ).status
    ).toBe("unknown");
    expect(sends).toBe(1);
    expect(
      (
        await f.run(
          { emoji: "👍", kind: "react" },
          {
            socket: {
              sendMessage: async () => ({
                key: { fromMe: true, id: "ack", remoteJid: "foreign@g.us" },
              }),
            } as never,
          }
        )
      ).status
    ).toBe("unknown");
  });
});
