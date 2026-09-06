import {
  messagesIncludeUserImages,
  PROVIDER_CAPABILITY_IDS,
  type ProviderClient,
  resolveMessagesForNonVisionProvider,
} from "@atlas/core";
import {
  type ChatCapabilityPolicy,
  requireChatCapability,
  resolveChatCapabilityRequest,
} from "./chat";

/**
 * Guard every provider entry point used by an Atlas harness. The conversation
 * loop still decides when to degrade streaming or native search; this wrapper
 * prevents secondary calls such as compaction, related questions, and
 * automation drafting from bypassing the same policy.
 */
export function enforceChatCapabilityPolicy(
  provider: ProviderClient,
  policy: ChatCapabilityPolicy
): ProviderClient {
  return {
    async generateChat(input) {
      const preparedInput = prepareChatInputForPolicy(input, policy);
      resolveChatCapabilityRequest(policy, requestFromInput(preparedInput));
      return await provider.generateChat(preparedInput);
    },
    async generateText(input) {
      requireChatCapability(policy, PROVIDER_CAPABILITY_IDS.chatCompletion);
      if ((input.format ?? "json") === "json") {
        requireChatCapability(
          policy,
          PROVIDER_CAPABILITY_IDS.chatStructuredOutput
        );
      }
      return await provider.generateText(input);
    },
    managesContext: provider.managesContext,
    name: provider.name,
    async streamChat(input, handlers) {
      const preparedInput = prepareChatInputForPolicy(input, policy);
      const request = resolveChatCapabilityRequest(
        policy,
        requestFromInput(preparedInput)
      );
      if (!request.streamingAvailable) {
        requireChatCapability(policy, PROVIDER_CAPABILITY_IDS.chatStreaming);
      }
      return await provider.streamChat(preparedInput, handlers);
    },
  };
}

function prepareChatInputForPolicy(
  input: Parameters<ProviderClient["generateChat"]>[0],
  policy: ChatCapabilityPolicy
): Parameters<ProviderClient["generateChat"]>[0] {
  if (!messagesIncludeUserImages(input.messages)) {
    return input;
  }

  const imageCapability =
    policy.capabilities[PROVIDER_CAPABILITY_IDS.chatInputImage];
  if (imageCapability?.status === "supported" && imageCapability.selectable) {
    return input;
  }

  // A completed vision fallback annotates image parts with descriptions. Strip
  // those parts to text before applying the primary model's image-input gate;
  // unresolved images remain and are rejected by resolveChatCapabilityRequest.
  return {
    ...input,
    messages: resolveMessagesForNonVisionProvider(input.messages),
  };
}

function requestFromInput(
  input: Parameters<ProviderClient["generateChat"]>[0]
): {
  requestsReasoning: boolean;
  sendsTools: boolean;
  usesImageInput: boolean;
  usesNativeWebSearch: boolean;
} {
  return {
    requestsReasoning: input.providerOptions?.thinking?.enabled === true,
    sendsTools: Boolean(input.tools?.length),
    usesImageInput: messagesIncludeUserImages(input.messages),
    usesNativeWebSearch: input.providerOptions?.webSearch === true,
  };
}
