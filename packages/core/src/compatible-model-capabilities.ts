import type { CustomModelEntry, ProviderName } from "./contract";
import {
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityClaims,
} from "./provider-capabilities";

const REASONING_PARAM_NAMES = new Set([
  "include_reasoning",
  "reasoning",
  "reasoning_effort",
  "thinking",
  "thinking_budget",
]);

const THINKING_DENY_FRAGMENTS = [
  "cohere/",
  "gemma-",
  "google/gemma",
  "llama-3",
  "llama3",
  "meta-llama/",
  "meta/llama",
  "microsoft/phi",
  "mistralai/",
  "phi-3",
  "phi-4",
] as const;

const THINKING_ALLOW_FRAGMENTS = [
  "claude",
  "deepseek-r1",
  "deepseek-reasoner",
  "deepseek-v3",
  "deepseek-v4",
  "gemini-2.5",
  "gemini-3",
  "glm",
  "gpt-5",
  "gpt-oss",
  "grok-3",
  "grok-4",
  "kimi",
  "o1",
  "o3",
  "o4",
  "qwen",
  "qwq",
] as const;

export interface CompatibleModelCapabilityContext {
  baseUrl?: string;
  provider?: ProviderName;
  providerLabel?: string;
}

export interface ParsedRemoteOpenAIModel {
  capabilities?: ProviderCapabilityClaims;
  id: string;
  name?: string;
  reasoningEffortValues?: string[];
  supportsThinking?: boolean;
  supportsVision?: boolean;
}

export function inferCompatibleModelThinking(modelId: string): boolean {
  const slug = modelId.trim().toLowerCase();

  if (
    slug.includes("reasoning") ||
    slug.includes("thinking") ||
    slug.includes(":thinking")
  ) {
    return true;
  }

  for (const fragment of THINKING_DENY_FRAGMENTS) {
    if (slug.includes(fragment)) {
      return false;
    }
  }

  for (const fragment of THINKING_ALLOW_FRAGMENTS) {
    if (slug.includes(fragment)) {
      return true;
    }
  }

  return false;
}

export function inferCompatibleReasoningEffortValues(
  modelId: string,
  context: CompatibleModelCapabilityContext = {}
): string[] {
  const mid = modelId.toLowerCase();
  const plabel = (context.providerLabel ?? "").toLowerCase();
  const url = (context.baseUrl ?? "").toLowerCase();

  if (mid.includes("claude") || context.provider === "anthropic") {
    return ["low", "medium", "high", "xhigh"];
  }

  if (mid.includes("deepseek") || context.provider === "deepseek") {
    return ["low", "high", "max"];
  }

  if (
    plabel === "tr" ||
    plabel.startsWith("tr ") ||
    plabel.endsWith(" tr") ||
    plabel.includes("tokenrouter") ||
    plabel.includes("token router") ||
    plabel.includes("token-router") ||
    url.includes("tokenrouter") ||
    url.includes("token-router") ||
    mid.includes("tokenrouter") ||
    mid.includes("qwen") ||
    mid.includes("kimi") ||
    mid.includes("glm")
  ) {
    return ["low", "medium", "xhigh"];
  }

  return ["low", "medium", "high"];
}

export function parseRemoteOpenAIModelEntry(
  entry: unknown
): ParsedRemoteOpenAIModel | null {
  const record = asRecord(entry);
  if (!record) {
    return null;
  }

  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) {
    return null;
  }

  const name = firstNonEmptyString(record.name, record.display_name);
  const supportedParams = [
    ...(readStringArray(record.supported_parameters) ?? []),
    ...(readStringArray(record.supported_params) ?? []),
  ];
  const reasoning = asRecord(record.reasoning);
  const advertisedCapabilities = asRecord(record.capabilities);
  const details = asRecord(record.supported_params_details);

  let supportsThinking: boolean | undefined;
  if (
    record.supports_reasoning === true ||
    record.supports_thinking === true ||
    record.supportsReasoning === true ||
    record.supportsThinking === true ||
    record.reasoning === true ||
    advertisedCapabilities?.reasoning === true ||
    advertisedCapabilities?.thinking === true
  ) {
    supportsThinking = true;
  } else if (
    record.supports_reasoning === false ||
    record.supports_thinking === false ||
    record.supportsReasoning === false ||
    record.supportsThinking === false ||
    record.reasoning === false ||
    advertisedCapabilities?.reasoning === false
  ) {
    supportsThinking = false;
  } else if (
    supportedParams.some((param) =>
      REASONING_PARAM_NAMES.has(param.toLowerCase())
    )
  ) {
    supportsThinking = true;
  }

  const reasoningEffortValues =
    readStringArray(reasoning?.supported_efforts) ??
    readStringArray(reasoning?.effort) ??
    readStringArray(reasoning?.efforts) ??
    readStringArray(asRecord(details?.reasoning_effort)?.accepted_values) ??
    readStringArray(asRecord(details?.reasoning_effort)?.enum) ??
    readStringArray(asRecord(details?.reasoning)?.effort);

  if (reasoningEffortValues && supportsThinking === undefined) {
    supportsThinking = true;
  }

  const supportsVision = detectRemoteVision(record, advertisedCapabilities);
  const normalizedCapabilities = detectNormalizedCapabilities({
    advertisedCapabilities,
    record,
    supportedParams,
    supportsThinking,
    supportsVision,
  });

  return {
    ...(Object.keys(normalizedCapabilities).length
      ? { capabilities: normalizedCapabilities }
      : {}),
    id,
    ...(name ? { name } : {}),
    ...(supportsThinking === undefined ? {} : { supportsThinking }),
    ...(reasoningEffortValues ? { reasoningEffortValues } : {}),
    ...(supportsVision === undefined ? {} : { supportsVision }),
  };
}

function detectNormalizedCapabilities(input: {
  advertisedCapabilities: Record<string, unknown> | null;
  record: Record<string, unknown>;
  supportedParams: string[];
  supportsThinking: boolean | undefined;
  supportsVision: boolean | undefined;
}): ProviderCapabilityClaims {
  const result: ProviderCapabilityClaims = {};
  const architecture = asRecord(input.record.architecture);
  const inputModalities =
    readStringArray(architecture?.input_modalities) ??
    readStringArray(input.record.input_modalities) ??
    [];
  const outputModalities =
    readStringArray(architecture?.output_modalities) ??
    readStringArray(input.record.output_modalities) ??
    [];
  const normalizedParams = new Set(
    input.supportedParams.map((parameter) => parameter.toLowerCase())
  );

  if (input.supportsVision !== undefined) {
    addDiscoveredClaim(
      result,
      PROVIDER_CAPABILITY_IDS.chatInputImage,
      input.supportsVision
    );
    addDiscoveredClaim(
      result,
      PROVIDER_CAPABILITY_IDS.imageUnderstanding,
      input.supportsVision
    );
  }
  if (inputModalities.includes("audio")) {
    addDiscoveredClaim(result, PROVIDER_CAPABILITY_IDS.chatInputAudio, true);
    if (outputModalities.includes("text")) {
      addDiscoveredClaim(
        result,
        PROVIDER_CAPABILITY_IDS.audioTranscription,
        true
      );
    }
  }
  if (outputModalities.includes("image")) {
    addDiscoveredClaim(result, PROVIDER_CAPABILITY_IDS.imageGeneration, true);
  }

  addExplicitCapabilityClaim(
    result,
    PROVIDER_CAPABILITY_IDS.audioTranscription,
    [
      input.record.supports_audio_transcription,
      input.advertisedCapabilities?.audio_transcription,
      input.advertisedCapabilities?.speech_to_text,
    ]
  );
  addExplicitCapabilityClaim(result, PROVIDER_CAPABILITY_IDS.imageGeneration, [
    input.record.supports_image_generation,
    input.advertisedCapabilities?.image_generation,
    input.advertisedCapabilities?.text_to_image,
  ]);

  const supportsTools =
    normalizedParams.has("tools") ||
    normalizedParams.has("tool_choice") ||
    normalizedParams.has("functions") ||
    input.advertisedCapabilities?.tools === true ||
    input.advertisedCapabilities?.function_calling === true;
  if (supportsTools) {
    addDiscoveredClaim(result, PROVIDER_CAPABILITY_IDS.chatToolUse, true);
  }
  const supportsStructured =
    normalizedParams.has("response_format") ||
    normalizedParams.has("json_schema") ||
    input.advertisedCapabilities?.structured_outputs === true;
  if (supportsStructured) {
    addDiscoveredClaim(
      result,
      PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
      true
    );
  }
  if (input.supportsThinking !== undefined) {
    addDiscoveredClaim(
      result,
      PROVIDER_CAPABILITY_IDS.chatReasoning,
      input.supportsThinking
    );
  }

  return result;
}

function addExplicitCapabilityClaim(
  claims: ProviderCapabilityClaims,
  capabilityId: string,
  values: unknown[]
): void {
  const explicit = values.find(
    (value): value is boolean => typeof value === "boolean"
  );
  if (explicit !== undefined) {
    addDiscoveredClaim(claims, capabilityId, explicit);
  }
}

function addDiscoveredClaim(
  claims: ProviderCapabilityClaims,
  capabilityId: string,
  supported: boolean
): void {
  claims[capabilityId] = {
    source: "provider-discovery",
    status: supported ? "supported" : "unsupported",
    verified: true,
  };
}

export function resolveCompatibleModelCapabilities(
  modelId: string,
  advertised: {
    reasoningEffortValues?: string[];
    supportsThinking?: boolean;
  } = {},
  context: CompatibleModelCapabilityContext = {}
): Pick<CustomModelEntry, "reasoningEffortValues" | "supportsThinking"> {
  const supportsThinking =
    advertised.supportsThinking ?? inferCompatibleModelThinking(modelId);

  if (!supportsThinking) {
    return advertised.supportsThinking === false
      ? { supportsThinking: false }
      : {};
  }

  return {
    reasoningEffortValues:
      advertised.reasoningEffortValues ??
      inferCompatibleReasoningEffortValues(modelId, context),
    supportsThinking: true,
  };
}

function detectRemoteVision(
  record: Record<string, unknown>,
  capabilities: Record<string, unknown> | null
): boolean | undefined {
  if (
    record.supports_vision === true ||
    record.supportsVision === true ||
    record.supports_image_input === true ||
    capabilities?.vision === true
  ) {
    return true;
  }

  const modalities = readStringArray(
    asRecord(record.architecture)?.input_modalities
  );
  if (modalities?.includes("image")) {
    return true;
  }

  if (record.supports_vision === false || record.supportsVision === false) {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return;
  }

  const parts = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  return parts.length > 0 ? parts : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
}
