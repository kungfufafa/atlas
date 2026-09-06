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

export interface CompatibleModelCapabilityContext {
  baseUrl?: string;
  provider?: ProviderName;
  providerLabel?: string;
}

export interface ParsedRemoteOpenAIModel {
  capabilities?: ProviderCapabilityClaims;
  contextWindow?: number;
  defaultReasoningEffort?: string;
  id: string;
  maxOutputTokens?: number;
  name?: string;
  reasoningEffortValues?: string[];
  supportsThinking?: boolean;
  supportsVision?: boolean;
}

/** @deprecated Model names do not establish reasoning support. */
export function inferCompatibleModelThinking(_modelId: string): undefined {}

/** @deprecated Reasoning values must come from provider metadata or configuration. */
export function inferCompatibleReasoningEffortValues(
  _modelId: string,
  _context: CompatibleModelCapabilityContext = {}
): string[] {
  return [];
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
    ...readSupportedParameters(record.supported_parameters),
    ...readSupportedParameters(record.supported_params),
  ];
  const reasoning = asRecord(record.reasoning);
  const advertisedCapabilities = asRecord(record.capabilities);
  const details = asRecord(record.supported_params_details);

  const reasoningEffortValues =
    readStringArray(record.reasoningEffortValues) ??
    readStringArray(record.reasoning_effort_values) ??
    readStringArray(reasoning?.supported_efforts) ??
    readStringArray(reasoning?.effort) ??
    readStringArray(reasoning?.efforts) ??
    readStringArray(asRecord(details?.reasoning_effort)?.accepted_values) ??
    readStringArray(asRecord(details?.reasoning_effort)?.enum) ??
    readStringArray(asRecord(details?.reasoning)?.effort);
  const supportsThinking =
    firstBoolean(
      record.supportsThinking,
      record.supportsReasoning,
      record.supports_thinking,
      record.supports_reasoning,
      record.reasoning,
      advertisedCapabilities?.reasoning,
      advertisedCapabilities?.thinking
    ) ??
    (supportedParams.some((param) =>
      REASONING_PARAM_NAMES.has(param.toLowerCase())
    ) || (reasoningEffortValues?.length ?? 0) > 0
      ? true
      : undefined);
  const advertisedDefault = firstNonEmptyString(
    record.defaultReasoningEffort,
    record.default_reasoning_effort,
    reasoning?.default_effort,
    reasoning?.default,
    asRecord(details?.reasoning_effort)?.default
  );
  const defaultReasoningEffort =
    reasoningEffortValues !== undefined &&
    advertisedDefault &&
    !reasoningEffortValues.includes(advertisedDefault)
      ? undefined
      : advertisedDefault;
  const topProvider = asRecord(record.top_provider);
  const limits = asRecord(record.limits);
  const contextWindow = firstTokenLimit(
    record.contextWindow,
    record.context_window,
    record.context_length,
    record.contextLength,
    record.max_model_len,
    topProvider?.context_length,
    limits?.max_context_length
  );
  const maxOutputTokens = firstTokenLimit(
    record.maxOutputTokens,
    record.max_output_tokens,
    record.max_completion_tokens,
    topProvider?.max_completion_tokens,
    limits?.max_completion_tokens
  );

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
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
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
  }
  if (outputModalities.includes("image")) {
    addDiscoveredClaim(result, PROVIDER_CAPABILITY_IDS.imageGeneration, true);
  }

  addExplicitCapabilityClaim(result, PROVIDER_CAPABILITY_IDS.chatInputAudio, [
    input.record.supports_audio_input,
    input.record.supportsAudioInput,
    input.advertisedCapabilities?.audio_input,
  ]);
  addExplicitCapabilityClaim(result, PROVIDER_CAPABILITY_IDS.chatCompletion, [
    input.record.supports_chat_completion,
    input.advertisedCapabilities?.completion,
  ]);
  addExplicitCapabilityClaim(result, PROVIDER_CAPABILITY_IDS.chatStreaming, [
    input.record.supports_streaming,
    input.advertisedCapabilities?.streaming,
  ]);
  addExplicitCapabilityClaim(
    result,
    PROVIDER_CAPABILITY_IDS.chatNativeWebSearch,
    [input.record.supports_web_search, input.advertisedCapabilities?.web_search]
  );
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
    firstBoolean(
      input.record.supportsTools,
      input.record.supports_tools,
      input.advertisedCapabilities?.tools,
      input.advertisedCapabilities?.function_calling
    ) ??
    (normalizedParams.has("tools") ||
    normalizedParams.has("tool_choice") ||
    normalizedParams.has("functions")
      ? true
      : undefined);
  if (supportsTools !== undefined) {
    addDiscoveredClaim(
      result,
      PROVIDER_CAPABILITY_IDS.chatToolUse,
      supportsTools
    );
  }
  const supportsStructured =
    firstBoolean(
      input.record.supportsStructuredOutput,
      input.record.supports_structured_output,
      input.advertisedCapabilities?.structured_outputs
    ) ??
    (normalizedParams.has("response_format") ||
    normalizedParams.has("json_schema")
      ? true
      : undefined);
  if (supportsStructured !== undefined) {
    addDiscoveredClaim(
      result,
      PROVIDER_CAPABILITY_IDS.chatStructuredOutput,
      supportsStructured
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
  _modelId: string,
  advertised: {
    defaultReasoningEffort?: string;
    reasoningEffortValues?: string[];
    supportsThinking?: boolean;
  } = {},
  _context: CompatibleModelCapabilityContext = {}
): Pick<
  CustomModelEntry,
  "defaultReasoningEffort" | "reasoningEffortValues" | "supportsThinking"
> {
  const supportsThinking =
    advertised.supportsThinking ??
    ((advertised.reasoningEffortValues?.length ?? 0) > 0 ? true : undefined);
  return {
    ...(supportsThinking === undefined ? {} : { supportsThinking }),
    ...(advertised.reasoningEffortValues === undefined
      ? {}
      : { reasoningEffortValues: advertised.reasoningEffortValues }),
    ...(advertised.defaultReasoningEffort === undefined
      ? {}
      : { defaultReasoningEffort: advertised.defaultReasoningEffort }),
  };
}

function detectRemoteVision(
  record: Record<string, unknown>,
  capabilities: Record<string, unknown> | null
): boolean | undefined {
  const explicit = firstBoolean(
    record.supportsVision,
    record.supports_vision,
    record.supportsImageInput,
    record.supports_image_input,
    capabilities?.vision
  );
  if (explicit !== undefined) {
    return explicit;
  }
  const modalities =
    readStringArray(asRecord(record.architecture)?.input_modalities) ??
    readStringArray(record.input_modalities);
  return modalities?.includes("image");
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function firstTokenLimit(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readSupportedParameters(value: unknown): string[] {
  return (
    readStringArray(value) ??
    Object.entries(asRecord(value) ?? {})
      .filter(([, supported]) => supported === true)
      .map(([parameter]) => parameter)
  );
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return;
  }

  const parts = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  return value.length === 0 || parts.length > 0
    ? [...new Set(parts)]
    : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
}
