import { describe, expect, test } from "bun:test";
import { createAgentHarness } from "@atlas/agent";
import type {
  ChatCompletionResult,
  GenerateChatInput,
  ProviderClient,
  ProviderName,
  ToolDefinition,
} from "@atlas/core";
import { parseAnthropicContent } from "./anthropic";
import { parseGeminiFunctionCalls } from "./gemini/messages";
import { parseOpenAIToolCalls } from "./openai";
import { buildChatCompletionResult } from "./shared";
import { parseSubscriptionResponse } from "./subscription/prompt";

const TOOL_ARGUMENTS = {
  path: "artifacts/provider-parity.pptx",
  slides: [{ title: "Provider parity" }],
};

interface ProviderMode {
  buildToolCallResult: () => ChatCompletionResult;
  label: string;
  name: ProviderName;
}

const providerModes: ProviderMode[] = [
  {
    buildToolCallResult: () =>
      parseSubscriptionResponse(
        [
          "```atlas-tool-call",
          JSON.stringify({ arguments: TOOL_ARGUMENTS, name: "write_pptx" }),
          "```",
        ].join("\n")
      ),
    label: "ChatGPT subscription",
    name: "chatgpt",
  },
  {
    buildToolCallResult: () =>
      parseSubscriptionResponse(
        [
          "```atlas-tool-call",
          JSON.stringify({ arguments: TOOL_ARGUMENTS, name: "write_pptx" }),
          "```",
        ].join("\n")
      ),
    label: "Claude subscription",
    name: "claude",
  },
  {
    buildToolCallResult: () => {
      const toolCalls = parseOpenAIToolCalls([
        {
          function: {
            arguments: JSON.stringify(TOOL_ARGUMENTS),
            name: "write_pptx",
          },
          id: "openai-call",
        },
      ]);
      return buildChatCompletionResult({ content: "", toolCalls });
    },
    label: "OpenAI API",
    name: "openai",
  },
  {
    buildToolCallResult: () =>
      parseAnthropicContent([
        {
          id: "anthropic-call",
          input: TOOL_ARGUMENTS,
          name: "write_pptx",
          type: "tool_use",
        },
      ]),
    label: "Anthropic API",
    name: "anthropic",
  },
  {
    buildToolCallResult: () => {
      const toolCalls = parseGeminiFunctionCalls([
        { args: TOOL_ARGUMENTS, name: "write_pptx" },
      ]);
      return buildChatCompletionResult({ content: "", toolCalls });
    },
    label: "Gemini API",
    name: "gemini",
  },
];

function createProvider(
  name: ProviderName,
  toolCallResult: ChatCompletionResult,
  followUpInputs: GenerateChatInput[]
): ProviderClient {
  let callIndex = 0;
  const generateChat = (
    input: GenerateChatInput
  ): Promise<ChatCompletionResult> => {
    callIndex += 1;
    if (callIndex === 1) {
      return Promise.resolve(toolCallResult);
    }
    followUpInputs.push(input);
    return Promise.resolve(
      buildChatCompletionResult({ content: "Deck ready", toolCalls: [] })
    );
  };

  return {
    generateChat,
    generateText: () => Promise.resolve({ content: "{}" }),
    name,
    streamChat: (input) => generateChat(input),
  };
}

describe("provider tool-loop parity", () => {
  for (const mode of providerModes) {
    test(`${mode.label} sends normalized write calls through the Atlas tool loop`, async () => {
      const executedInputs: unknown[] = [];
      const followUpInputs: GenerateChatInput[] = [];
      const writePptx: ToolDefinition = {
        description: "Create a PowerPoint presentation",
        name: "write_pptx",
        parameters: { type: "object" },
        run: (input) => {
          executedInputs.push(input);
          return Promise.resolve({ path: TOOL_ARGUMENTS.path });
        },
      };
      const provider = createProvider(
        mode.name,
        mode.buildToolCallResult(),
        followUpInputs
      );
      const session = createAgentHarness({
        provider,
        tools: [writePptx],
      }).createChatSession({ tools: [writePptx] });

      await expect(session.send("Create a parity deck")).resolves.toBe(
        "Deck ready"
      );
      expect(executedInputs).toEqual([TOOL_ARGUMENTS]);
      expect(followUpInputs).toHaveLength(1);
      expect(followUpInputs[0]?.messages.at(-1)).toMatchObject({
        name: "write_pptx",
        role: "tool",
      });
    });
  }
});
