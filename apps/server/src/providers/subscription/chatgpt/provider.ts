import type {
  GenerateChatInput,
  GenerateTextInput,
  GenerateTextResult,
  ProviderClient,
  StreamChatHandlers,
} from "@atlas/core";
import {
  deleteNativeSubscriptionSession,
  getChatgptRuntime,
} from "../runtimes";
import {
  withSubscriptionProviderLease,
  withSubscriptionSessionLease,
} from "../session-store";

export function createChatgptProvider(options: {
  model: string;
}): ProviderClient {
  const runtime = getChatgptRuntime();
  return {
    generateChat(input: GenerateChatInput) {
      return withSubscriptionSessionLease(
        "chatgpt",
        input.conversationId,
        () => runtime.generateChat(input, options.model),
        deleteNativeSubscriptionSession
      );
    },
    async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
      return await withSubscriptionProviderLease("chatgpt", async () => {
        const result = await runtime.generateChat(
          {
            messages: [{ content: input.prompt, role: "user" }],
            signal: input.signal,
            system: input.system,
          },
          options.model
        );
        return {
          content: result.content,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      });
    },
    managesContext: true,
    name: "chatgpt",
    streamChat(input: GenerateChatInput, handlers: StreamChatHandlers) {
      return withSubscriptionSessionLease(
        "chatgpt",
        input.conversationId,
        () => runtime.streamChat(input, handlers, options.model),
        deleteNativeSubscriptionSession
      );
    },
  };
}
