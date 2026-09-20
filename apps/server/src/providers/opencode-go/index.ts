import type {
  CustomModelEntry,
  GenerateChatInput,
  GenerateTextInput,
  ProviderClient,
  StreamChatHandlers,
} from "@atlas/core";
import { createAnthropicProvider } from "../anthropic";
import { toOpenCodeGoApiModelId } from "../models";
import { generateOpenAIResponsesChat } from "../openai/responses";
import { createOpenAICompatibleProvider } from "../openai-compatible";
import { modelSupportsReasoning } from "../reasoning-metadata";
import {
  DEFAULT_OPENCODE_GO_CATALOG_MODEL_ID,
  OPENCODE_GO_CHAT_BASE_URL,
  OPENCODE_GO_MESSAGES_BASE_URL,
} from "./catalog";
import { resolveOpenCodeGoApiKind } from "./protocol";
import {
  bindOpenCodeGoSession,
  resolveOpenCodeGoSessionId,
  wrapFetchWithOpenCodeGoSession,
} from "./session";

export {
  OPENCODE_GO_CHAT_BASE_URL,
  OPENCODE_GO_MESSAGES_BASE_URL,
} from "./catalog";
export {
  DEFAULT_OPENCODE_GO_SESSION_ID,
  OPENCODE_GO_SESSION_HEADER,
  resolveOpenCodeGoSessionId,
  wrapFetchWithOpenCodeGoSession,
} from "./session";

export interface OpenCodeGoProviderOptions {
  apiKey: string;
  customModels?: CustomModelEntry[];
  model?: string;
  providerInstanceId?: string;
  providerReplayRevision?: string;
}

export function createOpenCodeGoProvider(
  options: OpenCodeGoProviderOptions
): ProviderClient {
  const catalogModel = options.model ?? DEFAULT_OPENCODE_GO_CATALOG_MODEL_ID;
  const model = toOpenCodeGoApiModelId(catalogModel);
  const apiKind = resolveOpenCodeGoApiKind(model);
  const customModels = options.customModels?.map((entry) => ({
    ...entry,
    id: toOpenCodeGoApiModelId(entry.id),
  }));
  const metadata = customModels?.find((entry) => entry.id === model);
  const supportsThinking = modelSupportsReasoning(model, customModels);
  const fallbackSessionId = resolveOpenCodeGoSessionId({
    providerInstanceId: options.providerInstanceId,
  });
  const fetchImpl = wrapFetchWithOpenCodeGoSession(fallbackSessionId);

  const bind = (client: ProviderClient): ProviderClient =>
    bindOpenCodeGoSession(client, {
      fallbackSessionId,
      providerInstanceId: options.providerInstanceId,
    });

  if (apiKind === "messages") {
    const anthropic = createAnthropicProvider({
      apiKey: options.apiKey,
      baseUrl: OPENCODE_GO_MESSAGES_BASE_URL,
      customModels,
      fetch: fetchImpl,
      model,
      providerInstanceId: options.providerInstanceId,
      providerLabel: "OpenCode Go",
      providerName: "opencode_go",
      providerReplayRevision: options.providerReplayRevision,
    });

    return bind({
      generateChat: (input: GenerateChatInput) =>
        anthropic.generateChat(withoutNativeWebSearch(input)),
      generateText: (input: GenerateTextInput) => anthropic.generateText(input),
      name: "opencode_go",
      streamChat: (input: GenerateChatInput, handlers: StreamChatHandlers) =>
        anthropic.streamChat(withoutNativeWebSearch(input), handlers),
    });
  }

  if (apiKind === "responses") {
    const toChatInput = (input: GenerateTextInput): GenerateChatInput => ({
      messages: [{ content: input.prompt, role: "user" }],
      signal: input.signal,
      system: input.system,
    });

    return bind({
      generateChat: (input: GenerateChatInput) =>
        generateOpenAIResponsesChat({
          apiKey: options.apiKey,
          baseUrl: OPENCODE_GO_CHAT_BASE_URL,
          customModels,
          defaultReasoningEffort: metadata?.defaultReasoningEffort,
          fetch: fetchImpl,
          input: withoutNativeWebSearch(input),
          label: "OpenCode Go",
          model,
          providerInstanceId: options.providerInstanceId,
          providerName: "opencode_go",
          providerReplayRevision: options.providerReplayRevision,
          reasoningEffortValues: metadata?.reasoningEffortValues,
          stream: false,
          supportsThinking,
        }),
      generateText: async (input: GenerateTextInput) => {
        const result = await generateOpenAIResponsesChat({
          apiKey: options.apiKey,
          baseUrl: OPENCODE_GO_CHAT_BASE_URL,
          customModels,
          defaultReasoningEffort: metadata?.defaultReasoningEffort,
          fetch: fetchImpl,
          input: withoutNativeWebSearch(toChatInput(input)),
          label: "OpenCode Go",
          model,
          providerInstanceId: options.providerInstanceId,
          providerName: "opencode_go",
          providerReplayRevision: options.providerReplayRevision,
          reasoningEffortValues: metadata?.reasoningEffortValues,
          stream: false,
          supportsThinking,
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
          customModels,
          defaultReasoningEffort: metadata?.defaultReasoningEffort,
          fetch: fetchImpl,
          handlers,
          input: withoutNativeWebSearch(input),
          label: "OpenCode Go",
          model,
          providerInstanceId: options.providerInstanceId,
          providerName: "opencode_go",
          providerReplayRevision: options.providerReplayRevision,
          reasoningEffortValues: metadata?.reasoningEffortValues,
          stream: true,
          supportsThinking,
        }),
    });
  }

  return bind(
    createOpenAICompatibleProvider({
      apiKey: options.apiKey,
      baseUrl: OPENCODE_GO_CHAT_BASE_URL,
      defaultReasoningEffort: metadata?.defaultReasoningEffort,
      displayName: "OpenCode Go",
      fetch: fetchImpl,
      model,
      providerInstanceId: options.providerInstanceId,
      providerName: "opencode_go",
      providerReplayRevision: options.providerReplayRevision,
      reasoningEffortValues: metadata?.reasoningEffortValues,
      supportsThinking,
    })
  );
}

function withoutNativeWebSearch(input: GenerateChatInput): GenerateChatInput {
  if (!input.providerOptions?.webSearch) {
    return input;
  }

  return {
    ...input,
    providerOptions: {
      ...input.providerOptions,
      webSearch: false,
    },
  };
}
