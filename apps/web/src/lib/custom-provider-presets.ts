export interface CustomProviderPresetValues {
  baseUrl: string;
  name: string;
}

export interface CustomProviderPresetOption
  extends Partial<CustomProviderPresetValues> {
  id: string;
  label: string;
}

export const CUSTOM_PROVIDER_PRESETS: readonly CustomProviderPresetOption[] = [
  { id: "custom", label: "Custom" },
  {
    baseUrl: "http://localhost:1234/v1",
    id: "lmstudio",
    label: "LM Studio",
    name: "LM Studio",
  },
  {
    baseUrl: "http://localhost:8000/v1",
    id: "vllm",
    label: "vLLM",
    name: "vLLM",
  },
  {
    baseUrl: "http://localhost:4000/v1",
    id: "litellm",
    label: "LiteLLM",
    name: "LiteLLM",
  },
  {
    baseUrl: "http://localhost:8080/v1",
    id: "llamacpp",
    label: "llama.cpp",
    name: "llama.cpp",
  },
  {
    baseUrl: "https://api.groq.com/openai/v1",
    id: "groq",
    label: "Groq",
    name: "Groq",
  },
  {
    baseUrl: "https://api.together.xyz/v1",
    id: "together",
    label: "Together",
    name: "Together",
  },
  {
    baseUrl: "https://api.tokenrouter.com/v1",
    id: "tokenrouter",
    label: "TokenRouter",
    name: "TokenRouter",
  },
];

export function normalizeCustomProviderBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function matchCustomProviderPreset(
  baseUrl: string
): CustomProviderPresetOption["id"] {
  const normalized = normalizeCustomProviderBaseUrl(baseUrl);
  if (!normalized) {
    return "custom";
  }

  const matched = CUSTOM_PROVIDER_PRESETS.find(
    (preset) =>
      preset.baseUrl != null &&
      normalizeCustomProviderBaseUrl(preset.baseUrl) === normalized
  );

  return matched?.id ?? "custom";
}

export function applyCustomProviderPreset(
  presetId: string
): CustomProviderPresetValues | null {
  const preset = CUSTOM_PROVIDER_PRESETS.find(
    (option) => option.id === presetId
  );

  if (preset?.baseUrl == null || preset.name == null) {
    return null;
  }

  return { baseUrl: preset.baseUrl, name: preset.name };
}
