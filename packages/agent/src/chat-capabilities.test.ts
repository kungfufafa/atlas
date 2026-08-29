import { describe, expect, test } from "bun:test";
import {
  type ChatCompletionResult,
  type GenerateChatInput,
  PROVIDER_CAPABILITY_IDS,
  type ProviderClient,
  replaceImagePartsWithDescriptions,
  type ToolDefinition,
} from "@atlas/core";
import {
  ChatCapabilityError,
  type ChatCapabilityPolicy,
  createAgentHarness,
  enforceChatCapabilityPolicy,
} from "./index";

interface CapturingProvider extends ProviderClient {
  generateCalls: number;
  inputs: GenerateChatInput[];
  streamCalls: number;
  textCalls: number;
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const response: ChatCompletionResult = {
  assistantMessage: {
    content: "Answer",
    role: "assistant",
    thinking: "Reasoning",
  },
  content: "Answer",
  toolCalls: [],
};

const sampleTool: ToolDefinition = {
  description: "Sample tool",
  name: "sample",
  parameters: { properties: {}, type: "object" },
  run: () => Promise.resolve({ ok: true }),
};

function createCapturingProvider(): CapturingProvider {
  const provider: CapturingProvider = {
    generateCalls: 0,
    generateChat(input) {
      provider.generateCalls += 1;
      provider.inputs.push(input);
      return Promise.resolve(response);
    },
    generateText() {
      provider.textCalls += 1;
      return Promise.resolve({ content: "{}" });
    },
    inputs: [],
    name: "openai",
    streamCalls: 0,
    streamChat(input, handlers) {
      provider.streamCalls += 1;
      provider.inputs.push(input);
      handlers.onThinking?.("Reasoning");
      handlers.onChunk("Answer");
      return Promise.resolve(response);
    },
    textCalls: 0,
  };
  return provider;
}

function supportedPolicy(
  overrides: ChatCapabilityPolicy["capabilities"] = {}
): ChatCapabilityPolicy {
  const supported = { selectable: true, status: "supported" } as const;
  return {
    capabilities: {
      [PROVIDER_CAPABILITY_IDS.chatCompletion]: supported,
      [PROVIDER_CAPABILITY_IDS.chatInputImage]: supported,
      [PROVIDER_CAPABILITY_IDS.chatReasoning]: supported,
      [PROVIDER_CAPABILITY_IDS.chatStreaming]: supported,
      [PROVIDER_CAPABILITY_IDS.chatStructuredOutput]: supported,
      [PROVIDER_CAPABILITY_IDS.chatToolUse]: supported,
      ...overrides,
    },
  };
}

describe("chat capability policy", () => {
  test("rejects unsupported completion before any provider call", async () => {
    const provider = createCapturingProvider();
    const harness = createAgentHarness({
      chatCapabilityPolicy: supportedPolicy({
        [PROVIDER_CAPABILITY_IDS.chatCompletion]: {
          reasons: ["model-unsupported"],
          selectable: false,
          status: "unsupported",
        },
      }),
      provider,
    });
    const session = harness.createChatSession();

    await expect(session.send("hello")).rejects.toMatchObject({
      capabilityId: PROVIDER_CAPABILITY_IDS.chatCompletion,
      code: "CHAT_CAPABILITY_UNSUPPORTED",
    });
    expect(provider.generateCalls + provider.streamCalls).toBe(0);
    expect(session.getHistory()).toHaveLength(0);
  });

  test("applies completion policy to automation generation", async () => {
    const provider = createCapturingProvider();
    const harness = createAgentHarness({
      chatCapabilityPolicy: supportedPolicy({
        [PROVIDER_CAPABILITY_IDS.chatCompletion]: {
          reasons: ["model-unsupported"],
          selectable: false,
          status: "unsupported",
        },
      }),
      provider,
    });

    await expect(
      harness.createAutomationFromPrompt({
        channel: "web",
        prompt: "Send a daily summary",
      })
    ).rejects.toMatchObject({
      capabilityId: PROVIDER_CAPABILITY_IDS.chatCompletion,
      code: "CHAT_CAPABILITY_UNSUPPORTED",
    });
    expect(provider.textCalls).toBe(0);
  });

  test("requires structured output for JSON generation but not plain text", async () => {
    const provider = createCapturingProvider();
    const policy = supportedPolicy({
      [PROVIDER_CAPABILITY_IDS.chatStructuredOutput]: {
        reasons: ["model-unsupported"],
        selectable: false,
        status: "unsupported",
      },
    });
    const harness = createAgentHarness({
      chatCapabilityPolicy: policy,
      provider,
    });

    await expect(
      harness.createAutomationFromPrompt({
        channel: "web",
        prompt: "Send a daily summary",
      })
    ).rejects.toMatchObject({
      capabilityId: PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
      code: "CHAT_CAPABILITY_UNSUPPORTED",
    });
    expect(provider.textCalls).toBe(0);

    await expect(
      enforceChatCapabilityPolicy(provider, policy).generateText({
        prompt: "Return an object",
        system: "Return JSON",
      })
    ).rejects.toMatchObject({
      capabilityId: PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
      code: "CHAT_CAPABILITY_UNSUPPORTED",
    });
    expect(provider.textCalls).toBe(0);

    await expect(
      enforceChatCapabilityPolicy(provider, policy).generateText({
        format: "text",
        prompt: "Write a title",
        system: "Return prose",
      })
    ).resolves.toEqual({ content: "{}" });
    expect(provider.textCalls).toBe(1);
  });

  test("rejects image attachments at request resolution before provider work", async () => {
    const provider = createCapturingProvider();
    const session = createAgentHarness({
      chatCapabilityPolicy: supportedPolicy({
        [PROVIDER_CAPABILITY_IDS.chatInputImage]: {
          reasons: ["model-unsupported"],
          selectable: false,
          status: "unsupported",
        },
      }),
      provider,
    }).createChatSession({ enableToolLoop: false });

    await expect(
      session.send({
        images: [{ data: TINY_PNG_BASE64, mediaType: "image/png" }],
        message: "Describe this image",
      })
    ).rejects.toMatchObject({
      capabilityId: PROVIDER_CAPABILITY_IDS.chatInputImage,
      code: "CHAT_CAPABILITY_UNSUPPORTED",
    });
    expect(provider.generateCalls + provider.streamCalls).toBe(0);
    expect(session.getHistory()).toHaveLength(0);
  });

  test("guards image-bearing direct provider calls", async () => {
    const provider = createCapturingProvider();
    const guarded = enforceChatCapabilityPolicy(
      provider,
      supportedPolicy({
        [PROVIDER_CAPABILITY_IDS.chatInputImage]: {
          selectable: false,
          status: "unsupported",
        },
      })
    );

    await expect(
      guarded.generateChat({
        messages: [
          {
            content: [
              {
                data: TINY_PNG_BASE64,
                mediaType: "image/png",
                type: "image",
              },
            ],
            role: "user",
          },
        ],
        system: "Describe images",
      })
    ).rejects.toMatchObject({
      capabilityId: PROVIDER_CAPABILITY_IDS.chatInputImage,
      code: "CHAT_CAPABILITY_UNSUPPORTED",
    });
    expect(provider.generateCalls).toBe(0);
  });

  test("degrades completed vision fallback descriptions to text", async () => {
    const provider = createCapturingProvider();
    const session = createAgentHarness({
      chatCapabilityPolicy: supportedPolicy({
        [PROVIDER_CAPABILITY_IDS.chatInputImage]: {
          selectable: false,
          status: "unsupported",
        },
      }),
      provider,
    }).createChatSession({
      enableToolLoop: false,
      preprocessUserContent: async (content) =>
        replaceImagePartsWithDescriptions(content, ["A small red square."]),
    });

    await expect(
      session.send({
        images: [{ data: TINY_PNG_BASE64, mediaType: "image/png" }],
        message: "Describe this image",
      })
    ).resolves.toBe("Answer");
    expect(provider.generateCalls).toBe(1);
    expect(provider.inputs[0]?.messages.at(-1)?.content).toEqual([
      { text: "Describe this image", type: "text" },
      { text: "[Image]\nA small red square.", type: "text" },
    ]);
    expect(session.getHistory()[0]?.content).toEqual([
      { text: "Describe this image", type: "text" },
      {
        data: TINY_PNG_BASE64,
        description: "A small red square.",
        mediaType: "image/png",
        type: "image",
      },
    ]);
  });

  test("treats a missing completion claim as unknown", async () => {
    const provider = createCapturingProvider();
    const policy = supportedPolicy();
    delete policy.capabilities[PROVIDER_CAPABILITY_IDS.chatCompletion];
    const session = createAgentHarness({
      chatCapabilityPolicy: policy,
      provider,
    }).createChatSession();

    await expect(session.send("hello")).rejects.toBeInstanceOf(
      ChatCapabilityError
    );
    await expect(session.send("hello")).rejects.toMatchObject({
      code: "CHAT_CAPABILITY_UNKNOWN",
      status: "unknown",
    });
    expect(provider.generateCalls + provider.streamCalls).toBe(0);
  });

  test("requires tool-use only when tool definitions are sent", async () => {
    const provider = createCapturingProvider();
    const policy = supportedPolicy({
      [PROVIDER_CAPABILITY_IDS.chatToolUse]: {
        selectable: false,
        status: "unsupported",
      },
    });
    const toolSession = createAgentHarness({
      chatCapabilityPolicy: policy,
      provider,
      tools: [sampleTool],
    }).createChatSession({ tools: [sampleTool] });

    await expect(toolSession.send("use the tool")).rejects.toMatchObject({
      capabilityId: PROVIDER_CAPABILITY_IDS.chatToolUse,
    });
    expect(provider.generateCalls).toBe(0);

    const plainSession = createAgentHarness({
      chatCapabilityPolicy: policy,
      provider,
    }).createChatSession({ enableToolLoop: false });
    await expect(plainSession.send("plain chat")).resolves.toBe("Answer");
    expect(provider.generateCalls).toBe(1);
  });

  test("drops thinking when reasoning is unverified instead of blocking chat", async () => {
    const provider = createCapturingProvider();
    const policy = supportedPolicy({
      [PROVIDER_CAPABILITY_IDS.chatReasoning]: {
        reasons: ["model-unknown"],
        selectable: false,
        status: "unknown",
      },
    });
    const thinkingSession = createAgentHarness({
      chatCapabilityPolicy: policy,
      chatOptions: { thinking: { effort: "high", enabled: true } },
      provider,
    }).createChatSession({ enableToolLoop: false });

    await expect(thinkingSession.send("think")).resolves.toBe("Answer");
    expect(provider.generateCalls).toBe(1);
    expect(provider.inputs[0]?.providerOptions?.thinking).toBeUndefined();

    const plainSession = createAgentHarness({
      chatCapabilityPolicy: policy,
      chatOptions: { thinking: { enabled: false } },
      provider,
    }).createChatSession({ enableToolLoop: false });
    await expect(plainSession.send("do not think")).resolves.toBe("Answer");
  });

  test("drops thinking when reasoning cannot accept image input", async () => {
    const provider = createCapturingProvider();
    const session = createAgentHarness({
      chatCapabilityPolicy: supportedPolicy({
        [PROVIDER_CAPABILITY_IDS.chatReasoning]: {
          constraints: {
            supportedValues: { "request.multimodal": [false] },
          },
          selectable: true,
          status: "supported",
        },
      }),
      chatOptions: { thinking: { effort: "high", enabled: true } },
      provider,
    }).createChatSession({ enableToolLoop: false });

    await expect(
      session.send({
        images: [{ data: TINY_PNG_BASE64, mediaType: "image/png" }],
        message: "Think about this image.",
      })
    ).resolves.toBe("Answer");
    expect(provider.generateCalls).toBe(1);
    expect(provider.inputs[0]?.providerOptions?.thinking).toBeUndefined();
  });

  test("degrades unsupported streaming to generateChat and emits handlers", async () => {
    const provider = createCapturingProvider();
    const session = createAgentHarness({
      chatCapabilityPolicy: supportedPolicy({
        [PROVIDER_CAPABILITY_IDS.chatStreaming]: {
          reasons: ["model-unsupported"],
          selectable: false,
          status: "unsupported",
        },
      }),
      provider,
    }).createChatSession({ enableToolLoop: false });
    const events: string[] = [];

    await expect(
      session.sendStream("hello", {
        onChunk: (delta) => events.push(`chunk:${delta}`),
        onThinking: (delta) => events.push(`thinking:${delta}`),
      })
    ).resolves.toBe("Answer");

    expect(provider.streamCalls).toBe(0);
    expect(provider.generateCalls).toBe(1);
    expect(events).toEqual(["thinking:Reasoning", "chunk:Answer"]);
  });

  test("uses the supported streaming, tool-use, and reasoning path", async () => {
    const provider = createCapturingProvider();
    const session = createAgentHarness({
      chatCapabilityPolicy: supportedPolicy(),
      chatOptions: { thinking: { effort: "medium", enabled: true } },
      provider,
      tools: [sampleTool],
    }).createChatSession({ tools: [sampleTool] });
    const chunks: string[] = [];

    await expect(
      session.sendStream("hello", {
        onChunk: (delta) => chunks.push(delta),
      })
    ).resolves.toBe("Answer");

    expect(provider.streamCalls).toBe(1);
    expect(provider.generateCalls).toBe(0);
    expect(provider.inputs[0]?.tools?.map((tool) => tool.name)).toEqual([
      "sample",
    ]);
    expect(provider.inputs[0]?.providerOptions?.thinking).toEqual({
      effort: "medium",
      enabled: true,
    });
    expect(chunks).toEqual(["Answer"]);
  });
});
