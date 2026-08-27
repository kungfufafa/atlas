import type {
  GenerateChatInput,
  GenerateTextInput,
  GenerateTextResult,
  ProviderClient,
  StreamChatHandlers,
} from "@atlas/core";
import { deleteNativeSubscriptionSession, getClaudeRuntime } from "../runtimes";
import {
  withSubscriptionProviderLease,
  withSubscriptionSessionLease,
} from "../session-store";

export function createClaudeProvider(options: {
  model: string;
}): ProviderClient {
  const runtime = getClaudeRuntime();
  return {
    generateChat(input: GenerateChatInput) {
      return withSubscriptionSessionLease(
        "claude",
        input.conversationId,
        () => runtime.generateChat(input, options.model),
        deleteNativeSubscriptionSession
      );
    },
    async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
      return await withSubscriptionProviderLease("claude", async () => {
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
    name: "claude",
    streamChat(input: GenerateChatInput, handlers: StreamChatHandlers) {
      return withSubscriptionSessionLease(
        "claude",
        input.conversationId,
        () => runtime.streamChat(input, handlers, options.model),
        deleteNativeSubscriptionSession
      );
    },
  };
}
