import type {
  GenerateChatInput,
  GenerateTextInput,
  ProviderClient,
  StreamChatHandlers,
} from "@atlas/core";
import { createAnthropicProvider } from "../anthropic";
import { toOpenCodeGoApiModelId } from "../models";
import { createOpenAIProvider } from "../openai";
import { generateOpenAIResponsesChat } from "../openai/responses";
import {
  DEFAULT_OPENCODE_GO_CATALOG_MODEL_ID,
  OPENCODE_GO_CHAT_BASE_URL,
  OPENCODE_GO_MESSAGES_BASE_URL,
} from "./catalog";
import { resolveOpenCodeGoApiKind } from "./protocol";

export {
  OPENCODE_GO_CHAT_BASE_URL,
  OPENCODE_GO_MESSAGES_BASE_URL,
} from "./catalog";

export interface OpenCodeGoProviderOptions {
  apiKey: string;
  model?: string;
}

export function createOpenCodeGoProvider(
  options: OpenCodeGoProviderOptions
): ProviderClient {
  const catalogModel = options.model ?? DEFAULT_OPENCODE_GO_CATALOG_MODEL_ID;
  const model = toOpenCodeGoApiModelId(catalogModel);
  const apiKind = resolveOpenCodeGoApiKind(model);

  if (apiKind === "messages") {
    const anthropic = createAnthropicProvider({
      apiKey: options.apiKey,
      baseUrl: OPENCODE_GO_MESSAGES_BASE_URL,
      model,
      providerLabel: "OpenCode Go",
      providerName: "opencode_go",
    });

    return {
      generateChat: (input: GenerateChatInput) =>
        anthropic.generateChat({ ...input, providerOptions: undefined }),
      generateText: (input: GenerateTextInput) => anthropic.generateText(input),
      name: "opencode_go",
      streamChat: (input: GenerateChatInput, handlers: StreamChatHandlers) =>
        anthropic.streamChat(
          { ...input, providerOptions: undefined },
          handlers
        ),
    };
  }

  if (apiKind === "responses") {
    const toChatInput = (input: GenerateTextInput): GenerateChatInput => ({
      messages: [{ content: input.prompt, role: "user" }],
      signal: input.signal,
      system: input.system,
    });

    return {
      generateChat: (input: GenerateChatInput) =>
        generateOpenAIResponsesChat({
          apiKey: options.apiKey,
          baseUrl: OPENCODE_GO_CHAT_BASE_URL,
          input: { ...input, providerOptions: undefined },
          label: "OpenCode Go",
          model,
          stream: false,
        }),
      generateText: async (input: GenerateTextInput) => {
        const result = await generateOpenAIResponsesChat({
          apiKey: options.apiKey,
          baseUrl: OPENCODE_GO_CHAT_BASE_URL,
          input: toChatInput(input),
          label: "OpenCode Go",
          model,
          stream: false,
        });

        return {
          content: result.content,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      },
      name: "opencode_go",
      streamChat: (input: GenerateChatInput, handlers: StreamChatHandlers) =>
        generateOpenAIResponsesChat({
          apiKey: options.apiKey,
          baseUrl: OPENCODE_GO_CHAT_BASE_URL,
          handlers,
          input: { ...input, providerOptions: undefined },
          label: "OpenCode Go",
          model,
          stream: true,
        }),
    };
  }

  return createOpenAIProvider({
    apiKey: options.apiKey,
    baseUrl: OPENCODE_GO_CHAT_BASE_URL,
    model,
    providerName: "opencode_go",
  });
}
