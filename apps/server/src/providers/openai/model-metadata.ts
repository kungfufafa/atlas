import {
  type CustomModelEntry,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityClaims,
} from "@atlas/core";

function documentedChatCapabilities(
  nativeWebSearch = false
): ProviderCapabilityClaims {
  const supported = [
    PROVIDER_CAPABILITY_IDS.chatCompletion,
    PROVIDER_CAPABILITY_IDS.chatStreaming,
    PROVIDER_CAPABILITY_IDS.chatToolUse,
    PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
    PROVIDER_CAPABILITY_IDS.chatInputImage,
    PROVIDER_CAPABILITY_IDS.imageUnderstanding,
    ...(nativeWebSearch ? [PROVIDER_CAPABILITY_IDS.chatNativeWebSearch] : []),
  ];
  const claims: ProviderCapabilityClaims = {};
  for (const capabilityId of supported) {
    claims[capabilityId] = {
      source: "static-manifest",
      status: "supported",
      verified: true,
    };
  }
  claims[PROVIDER_CAPABILITY_IDS.chatInputAudio] = {
    source: "static-manifest",
    status: "unsupported",
    verified: true,
  };
  return claims;
}

/**
 * The OpenAI Models API returns identifiers, not limits or reasoning settings.
 * Exact API model snapshots verified against the linked official model pages
 * on 2026-09-06. Never apply these to ChatGPT subscriptions or proxy endpoints.
 */
const DOCUMENTED_MODELS: Record<string, Omit<CustomModelEntry, "id">> = {
  // https://developers.openai.com/api/docs/models/gpt-4o-mini
  "gpt-4o-mini": {
    capabilities: documentedChatCapabilities(),
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    reasoningEffortValues: [],
    supportsThinking: false,
    supportsVision: true,
  },
  // https://developers.openai.com/api/docs/models/gpt-5.3-codex
  "gpt-5.3-codex": {
    capabilities: documentedChatCapabilities(),
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    reasoningEffortValues: ["low", "medium", "high", "xhigh"],
    supportsThinking: true,
    supportsVision: true,
  },
  // https://developers.openai.com/api/docs/models/gpt-5.4
  "gpt-5.4": {
    capabilities: documentedChatCapabilities(true),
    contextWindow: 1_050_000,
    defaultReasoningEffort: "none",
    maxOutputTokens: 128_000,
    reasoningEffortValues: ["none", "low", "medium", "high", "xhigh"],
    supportsThinking: true,
    supportsVision: true,
  },
  // https://developers.openai.com/api/docs/models/gpt-5.5
  "gpt-5.5": {
    capabilities: documentedChatCapabilities(true),
    contextWindow: 1_050_000,
    defaultReasoningEffort: "medium",
    maxOutputTokens: 128_000,
    reasoningEffortValues: ["none", "low", "medium", "high", "xhigh"],
    supportsThinking: true,
    supportsVision: true,
  },
};

export function documentedOpenAIModelMetadata(
  modelId: string
): Omit<CustomModelEntry, "id"> {
  const metadata = DOCUMENTED_MODELS[modelId];
  return metadata ? structuredClone(metadata) : {};
}
