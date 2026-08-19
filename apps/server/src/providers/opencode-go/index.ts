import type {
  GenerateChatInput,
  GenerateTextInput,
  ProviderClient,
  StreamChatHandlers,
} from "@atlas/core";
import { createAnthropicProvider } from "../anthropic";
import { toOpenCodeGoApiModelId } from "../models";
import { createOpenAIProvider } from "../openai";

const OPENCODE_GO_CHAT_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_MESSAGES_BASE_URL = "https://opencode.ai/zen/go";

const MESSAGES_MODELS = new Set([
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.8-max",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus",
]);

export interface OpenCodeGoProviderOptions {
  apiKey: string;
  model?: string;
}

export function createOpenCodeGoProvider(
  options: OpenCodeGoProviderOptions
): ProviderClient {
  const model = toOpenCodeGoApiModelId(
    options.model ?? "opencode-go/kimi-k2.7-code"
  );
  const useMessages = MESSAGES_MODELS.has(model);

  if (useMessages) {
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

  return createOpenAIProvider({
    apiKey: options.apiKey,
    baseUrl: OPENCODE_GO_CHAT_BASE_URL,
    model,
    providerName: "opencode_go",
  });
}
