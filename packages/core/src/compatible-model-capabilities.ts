import type { CustomModelEntry, ProviderName } from "./contract";

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
  const capabilities = asRecord(record.capabilities);
  const details = asRecord(record.supported_params_details);

  let supportsThinking: boolean | undefined;
  if (
    record.supports_reasoning === true ||
    record.supports_thinking === true ||
    record.supportsReasoning === true ||
    record.supportsThinking === true ||
    record.reasoning === true ||
    capabilities?.reasoning === true ||
    capabilities?.thinking === true
  ) {
    supportsThinking = true;
  } else if (
    record.supports_reasoning === false ||
    record.supports_thinking === false ||
    record.supportsReasoning === false ||
    record.supportsThinking === false ||
    record.reasoning === false ||
    capabilities?.reasoning === false
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

  const supportsVision = detectRemoteVision(record, capabilities);

  return {
    id,
    ...(name ? { name } : {}),
    ...(supportsThinking === undefined ? {} : { supportsThinking }),
    ...(reasoningEffortValues ? { reasoningEffortValues } : {}),
    ...(supportsVision === undefined ? {} : { supportsVision }),
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
