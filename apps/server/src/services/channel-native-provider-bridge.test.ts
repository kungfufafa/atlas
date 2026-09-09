import { afterEach, expect, test } from "bun:test";
import { createAgentHarness } from "@atlas/agent";
import { createClient } from "@atlas/client";
import type { GenerateChatInput, ProviderClient } from "@atlas/core";
import type { ChannelNativeActionRequest } from "@atlas/core/channel-native-actions";
import { channelActionTool } from "../../../../packages/core/src/tools/channel-action";
import { setupTestConfigDir } from "../test-config-dir";
import { createNativeChannelHarness } from "../testing/channel-native-harness";

setupTestConfigDir("atlas-native-provider-bridge-");
const opened: Array<Awaited<ReturnType<typeof createNativeChannelHarness>>> =
  [];
afterEach(() => {
  for (const h of opened.splice(0)) {
    h.database.close();
  }
});

for (const providerName of [
  "openai",
  "anthropic",
  "gemini",
  "openai_compatible",
  "chatgpt",
  "claude",
] as const) {
  test(`${providerName}: shared inline tool execution waits for HTTP worker receipt before provider continuation`, async () => {
    const h = await createNativeChannelHarness("telegram", 5000);
    opened.push(h);
    await h.service.bind(h.orgId, "telegram", h.actor);
    const native = providerName === "chatgpt" || providerName === "claude";
    const call = {
      arguments: { kind: "poll", options: ["Yes", "No"], question: "Proceed?" },
      id: "native-poll",
      name: "channel_action",
    };
    let passes = 0;
    let providerSawReceipt = false;
    const run = async (input: GenerateChatInput) => {
      passes += 1;
      if (native) {
        const result = await input.executeToolCall!(call);
        expect(result.success).toBe(true);
        expect(JSON.parse(result.content)).toMatchObject({
          messageId: "native-ack",
          status: "accepted",
        });
        providerSawReceipt = true;
      } else if (passes === 1) {
        return {
          assistantMessage: {
            content: "",
            role: "assistant" as const,
            toolCalls: [call],
          },
          content: "",
          toolCalls: [call],
        };
      } else {
        const result = input.messages.findLast(
          (message) => message.role === "tool"
        );
        expect(result).toMatchObject({ role: "tool" });
        expect(JSON.parse(String(result?.content))).toMatchObject({
          messageId: "native-ack",
          status: "accepted",
        });
        providerSawReceipt = true;
      }
      return {
        assistantMessage: {
          content: "Acknowledged",
          role: "assistant" as const,
        },
        content: "Acknowledged",
        toolCalls: [],
      };
    };
    const provider: ProviderClient = {
      generateChat: run,
      generateText: async () => ({ content: "unused" }),
      name: providerName,
      streamChat: async (input, handlers) => {
        const result = await run(input);
        if (result.content) {
          handlers.onChunk(result.content);
        }
        return result;
      },
    };
    const session = createAgentHarness({
      provider,
      tools: [channelActionTool],
    }).createChatSession({
      toolContext: {
        ...h.context,
        beforeToolCall: (name) =>
          h.service.authorizeTool(h.orgId, h.sessionId, "telegram", name),
        orgRole: "member",
        requestChannelAction: (action, publish, signal) =>
          h.service.request({ ...h.context, signal }, action, publish),
      },
    });
    const emission = Promise.withResolvers<ChannelNativeActionRequest>();
    h.routeAgent.resolveSession = async () => session;
    const client = createClient({
      authToken: h.token,
      baseUrl: "http://localhost:4310",
      fetch: Object.assign(
        async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1]
        ) => await h.app.fetch(new Request(input, init)),
        { preconnect: fetch.preconnect }
      ),
      orgId: h.orgId,
    });
    const sending = client
      .createChatSession(h.sessionId, "telegram")
      .sendStream("Create a poll", {
        onChannelActionRequested: emission.resolve,
        onChunk() {},
      });
    const event = await emission.promise;
    expect(providerSawReceipt).toBe(false);
    const claim = { ...h.actor, requestId: event.id };
    expect(await client.claimChannelAction(claim)).toEqual(event);
    expect(providerSawReceipt).toBe(false);
    expect(
      await client.completeChannelAction({
        ...claim,
        receipt: { messageId: "native-ack", status: "accepted" },
      })
    ).toEqual({ recorded: true });
    expect(await sending).toBe("Acknowledged");
    expect(providerSawReceipt).toBe(true);
    expect(
      session.getHistory().filter((message) => message.role === "tool")
    ).toHaveLength(1);
  });
}
