import { expect, test } from "bun:test";
import type { GenerateChatInput, ProviderClient } from "@atlas/core";
import {
  GROUP_CHAT_KIND_GUIDANCE,
  messagingGroupAudienceLine,
  messagingPrivateAudienceLine,
  messagingUnsetAudienceLine,
  PRIVATE_CHAT_KIND_GUIDANCE,
} from "./chat-prompt";
import { createAgentHarness } from "./index";

function createCapturingProvider(): ProviderClient & {
  lastInput?: GenerateChatInput;
} {
  const provider: ProviderClient & { lastInput?: GenerateChatInput } = {
    generateChat(input) {
      provider.lastInput = input;
      return Promise.resolve({
        assistantMessage: { content: "ok", role: "assistant" },
        content: "ok",
        toolCalls: [],
      });
    },
    generateText() {
      return Promise.resolve({ content: "{}" });
    },
    name: "mock",
    streamChat() {
      return Promise.resolve({
        assistantMessage: { content: "ok", role: "assistant" },
        content: "ok",
        toolCalls: [],
      });
    },
  };
  return provider;
}

test("createAgentChatSession passes chatKind into the system prompt", async () => {
  const provider = createCapturingProvider();
  const harness = createAgentHarness({ provider });

  await harness
    .createChatSession({
      channel: "whatsapp",
      chatKind: "private",
      enableToolLoop: false,
    })
    .send("status?");
  const privateSystem = provider.lastInput?.system ?? "";
  expect(privateSystem).toContain(messagingPrivateAudienceLine("WhatsApp"));
  expect(privateSystem).toContain(PRIVATE_CHAT_KIND_GUIDANCE);
  expect(privateSystem).not.toContain(messagingGroupAudienceLine("WhatsApp"));

  await harness
    .createChatSession({
      channel: "whatsapp",
      chatKind: "group",
      enableToolLoop: false,
    })
    .send("status?");
  const groupSystem = provider.lastInput?.system ?? "";
  expect(groupSystem).toContain(messagingGroupAudienceLine("WhatsApp"));
  expect(groupSystem).toContain(GROUP_CHAT_KIND_GUIDANCE);
  expect(groupSystem).not.toContain(messagingPrivateAudienceLine("WhatsApp"));
  expect(groupSystem).not.toBe(privateSystem);
});

test("createAgentChatSession without chatKind does not fire private or group lines", async () => {
  const provider = createCapturingProvider();
  await createAgentHarness({ provider })
    .createChatSession({ channel: "telegram", enableToolLoop: false })
    .send("status?");
  const system = provider.lastInput?.system ?? "";
  expect(system).toContain(messagingUnsetAudienceLine("Telegram"));
  expect(system).not.toContain(messagingPrivateAudienceLine("Telegram"));
  expect(system).not.toContain(messagingGroupAudienceLine("Telegram"));
});
