import {
  type CustomModelEntry,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityClaims,
  type ProviderInstance,
} from "@atlas/core";

function supportedClaims(ids: readonly string[]): ProviderCapabilityClaims {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      {
        source: "static-manifest" as const,
        status: "supported" as const,
        verified: true,
      },
    ])
  );
}

const ANTHROPIC_STRUCTURED_TOOL_CLAIMS = supportedClaims([
  PROVIDER_CAPABILITY_IDS.chatToolUse,
  PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
]);

const GEMINI_MULTIMODAL_TOOL_CLAIMS = supportedClaims([
  PROVIDER_CAPABILITY_IDS.chatCompletion,
  PROVIDER_CAPABILITY_IDS.chatInputImage,
  PROVIDER_CAPABILITY_IDS.imageUnderstanding,
  PROVIDER_CAPABILITY_IDS.chatInputAudio,
  PROVIDER_CAPABILITY_IDS.chatToolUse,
  PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
  PROVIDER_CAPABILITY_IDS.chatNativeWebSearch,
]);
GEMINI_MULTIMODAL_TOOL_CLAIMS[PROVIDER_CAPABILITY_IDS.imageGeneration] = {
  source: "static-manifest",
  status: "unsupported",
  verified: true,
};

/**
 * Exact API model capabilities verified on 2026-09-06. Limits and reasoning
 * stay with native discovery; these docs cover fields absent from list APIs.
 */
const ANTHROPIC_MODELS: Record<string, Omit<CustomModelEntry, "id">> = {
  // Both models are explicitly listed in the compatibility section:
  // https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  "claude-opus-4-6": { capabilities: ANTHROPIC_STRUCTURED_TOOL_CLAIMS },
  "claude-sonnet-4-6": { capabilities: ANTHROPIC_STRUCTURED_TOOL_CLAIMS },
};

const GEMINI_MODELS: Record<string, Omit<CustomModelEntry, "id">> = {
  // https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview
  "gemini-3-flash-preview": {
    capabilities: GEMINI_MULTIMODAL_TOOL_CLAIMS,
    supportsVision: true,
  },
  // https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite
  "gemini-3.1-flash-lite": {
    capabilities: GEMINI_MULTIMODAL_TOOL_CLAIMS,
    supportsVision: true,
  },
  // https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash
  "gemini-3.5-flash": {
    capabilities: GEMINI_MULTIMODAL_TOOL_CLAIMS,
    supportsVision: true,
  },
};

function isOfficialEndpoint(instance: ProviderInstance): boolean {
  if (instance.type !== "anthropic" && instance.type !== "gemini") {
    return false;
  }
  if (!instance.baseUrl?.trim()) {
    return true;
  }
  try {
    const url = new URL(instance.baseUrl.trim());
    const expectedHost =
      instance.type === "anthropic"
        ? "api.anthropic.com"
        : "generativelanguage.googleapis.com";
    const allowedPaths =
      instance.type === "anthropic" ? ["", "/v1"] : ["", "/v1", "/v1beta"];
    return (
      url.protocol === "https:" &&
      url.hostname === expectedHost &&
      !url.port &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      allowedPaths.includes(url.pathname.replace(/\/+$/, ""))
    );
  } catch {
    return false;
  }
}

export function documentedNativeModelMetadata(
  instance: ProviderInstance,
  modelId: string
): Omit<CustomModelEntry, "id"> {
  if (!isOfficialEndpoint(instance)) {
    return {};
  }
  const metadata =
    instance.type === "anthropic"
      ? ANTHROPIC_MODELS[modelId]
      : GEMINI_MODELS[modelId];
  return metadata ? structuredClone(metadata) : {};
}
