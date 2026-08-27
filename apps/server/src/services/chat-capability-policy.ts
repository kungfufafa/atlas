import {
  type ChatCapabilityPolicy,
  type ChatCapabilityPolicyEntry,
  enforceChatCapabilityPolicy,
} from "@atlas/agent";
import {
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityClaim,
  type ProviderCapabilityClaims,
  type ProviderClient,
  type ProviderInstance,
  type UserConfig,
} from "@atlas/core";
import { builtinProviderAdapterRegistry } from "../providers/capabilities/builtin-adapters";
import type { ProviderAdapterRegistry } from "../providers/capabilities/registry";
import { evaluateCapabilityTarget } from "../providers/capabilities/runtime";
import { getModelsForProviderInstance } from "../providers/compatible-models";
import {
  createProviderForInstance,
  readApiKeyForInstance,
} from "../providers/create";

const CHAT_CAPABILITY_IDS = [
  PROVIDER_CAPABILITY_IDS.chatCompletion,
  PROVIDER_CAPABILITY_IDS.chatInputAudio,
  PROVIDER_CAPABILITY_IDS.chatInputImage,
  PROVIDER_CAPABILITY_IDS.chatNativeWebSearch,
  PROVIDER_CAPABILITY_IDS.chatReasoning,
  PROVIDER_CAPABILITY_IDS.chatStreaming,
  PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
  PROVIDER_CAPABILITY_IDS.chatToolUse,
] as const;

export interface ChatCapabilityModelEvidence {
  capabilities?: ProviderCapabilityClaims;
  reasoningEffortValues?: readonly string[];
  supportsThinking?: boolean;
}

export function createChatCapabilityAwareProvider(options: {
  config: UserConfig | null;
  env?: Record<string, string | undefined>;
  instance: ProviderInstance;
  modelId: string;
  registry?: ProviderAdapterRegistry;
}): ProviderClient | null {
  const env = options.env ?? process.env;
  const registry = options.registry ?? builtinProviderAdapterRegistry;
  const provider = createProviderForInstance(
    options.instance,
    options.modelId,
    env,
    registry
  );
  if (!provider) {
    return null;
  }
  const modelEvidence = getModelsForProviderInstance(options.instance).find(
    (model) => model.id === options.modelId
  );
  const policy = resolveChatCapabilityPolicy({
    config: options.config,
    instance: options.instance,
    model: modelEvidence,
    modelId: options.modelId,
    readApiKey: (instance) => readApiKeyForInstance(instance, env),
    registry,
  });
  return enforceChatCapabilityPolicy(provider, policy);
}

export function resolveChatCapabilityPolicy(options: {
  config: UserConfig | null | undefined;
  instance: ProviderInstance;
  model: ChatCapabilityModelEvidence | undefined;
  modelId: string;
  readApiKey: (instance: ProviderInstance) => string | undefined;
  registry: ProviderAdapterRegistry;
}): ChatCapabilityPolicy {
  const capabilities: ChatCapabilityPolicy["capabilities"] = {};

  for (const capabilityId of CHAT_CAPABILITY_IDS) {
    const additionalClaims = modelClaimsForCapability(
      capabilityId,
      options.model
    );
    const effective = evaluateCapabilityTarget(
      {
        capabilityId,
        config: options.config,
        readApiKey: options.readApiKey,
        registry: options.registry,
      },
      { modelId: options.modelId, providerId: options.instance.id },
      additionalClaims
    );
    capabilities[capabilityId] = toPolicyEntry(effective);
  }

  return { capabilities };
}

function modelClaimsForCapability(
  capabilityId: string,
  model: ChatCapabilityModelEvidence | undefined
): ProviderCapabilityClaim[] {
  const claims: ProviderCapabilityClaim[] = [];
  const legacyReasoningClaim =
    capabilityId === PROVIDER_CAPABILITY_IDS.chatReasoning
      ? reasoningClaimFromModelMetadata(model)
      : undefined;
  if (legacyReasoningClaim) {
    claims.push(legacyReasoningClaim);
  }
  const explicitClaim = model?.capabilities?.[capabilityId];
  if (explicitClaim) {
    claims.push(explicitClaim);
  }
  return claims;
}

function reasoningClaimFromModelMetadata(
  model: ChatCapabilityModelEvidence | undefined
): ProviderCapabilityClaim | undefined {
  const hasReasoningEffort = Boolean(model?.reasoningEffortValues?.length);
  if (model?.supportsThinking === undefined && !hasReasoningEffort) {
    return;
  }

  return {
    source: "static-manifest",
    status: model?.supportsThinking === false ? "unsupported" : "supported",
    verified: true,
  };
}

function toPolicyEntry(effective: {
  claim: ProviderCapabilityClaim;
  reasons: readonly string[];
  selectable: boolean;
}): ChatCapabilityPolicyEntry {
  return {
    ...(effective.claim.constraints
      ? { constraints: effective.claim.constraints }
      : {}),
    reasons: [...effective.reasons],
    selectable: effective.selectable,
    status: effective.claim.status,
  };
}
