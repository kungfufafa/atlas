export type ProviderApiKeyPolicy =
  | {
      placeholder: string;
      requirement: "required" | "optional";
    }
  | {
      placeholder: string;
      requiredWhen: {
        equals: string;
        field: string;
      };
      requirement: "conditional";
    };

export interface ProviderSetupMetadata {
  allowLocalDiscovery?: true;
  baseUrlInput?: "cloudflare-account" | "url";
  baseUrlRequired?: true;
  catalogSelectionAsCustomModel?: true;
  configureBaseUrl?: "include" | "omit";
  customModelIdPolicy?: {
    errorMessage: string;
    pattern: string;
  };
  customModels?: true;
  customModelsRequired?: true;
  displayName?: true;
  hostMode?: "ollama";
  modelSelection?: "catalog" | "specialized";
  /** Provider authenticates through an official subscription runtime, not an API key. */
  subscriptionAuth?: true;
  wireApi?: true;
}

export interface BuiltinProviderDefinition {
  allowMultipleInstances?: true;
  apiKey: ProviderApiKeyPolicy;
  apiKeyEnvVar: string | null;
  deprecatedModelAliases?: Readonly<Record<string, string>>;
  discoveryBaseUrl?: string;
  discoveryModels?: true;
  displayName: string;
  fallbackModelId: string;
  id: string;
  modelIdPolicy?: "catalog" | "passthrough" | "provider-qualified";
  setup?: ProviderSetupMetadata;
}

export function providerApiKeyIsRequired(
  policy: ProviderApiKeyPolicy,
  setupValues: Readonly<Record<string, string | undefined>> = {}
): boolean {
  if (policy.requirement === "required") {
    return true;
  }
  if (policy.requirement === "optional") {
    return false;
  }

  if ("requiredWhen" in policy) {
    return (
      setupValues[policy.requiredWhen.field] === policy.requiredWhen.equals
    );
  }

  return false;
}

/** Declarative identity/config metadata; executable behavior lives in adapters. */
export const BUILTIN_PROVIDER_DEFINITIONS = [
  {
    apiKey: { placeholder: "sk-…", requirement: "required" },
    apiKeyEnvVar: "OPENAI_API_KEY",
    displayName: "OpenAI",
    fallbackModelId: "gpt-5.4",
    id: "openai",
    modelIdPolicy: "passthrough",
    setup: { customModels: true, modelSelection: "catalog" },
  },
  {
    apiKey: { placeholder: "ChatGPT login", requirement: "optional" },
    apiKeyEnvVar: null,
    displayName: "ChatGPT",
    fallbackModelId: "gpt-5.4",
    id: "chatgpt",
    modelIdPolicy: "passthrough",
    setup: {
      customModels: true,
      modelSelection: "catalog",
      subscriptionAuth: true,
    },
  },
  {
    apiKey: { placeholder: "sk-ant-…", requirement: "required" },
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    discoveryBaseUrl: "https://api.anthropic.com",
    discoveryModels: true,
    displayName: "Anthropic",
    fallbackModelId: "claude-sonnet-4-6",
    id: "anthropic",
    modelIdPolicy: "passthrough",
    setup: { customModels: true, modelSelection: "catalog" },
  },
  {
    apiKey: { placeholder: "Claude login", requirement: "optional" },
    apiKeyEnvVar: null,
    displayName: "Claude",
    fallbackModelId: "claude-sonnet-4-6",
    id: "claude",
    modelIdPolicy: "passthrough",
    setup: {
      customModels: true,
      modelSelection: "catalog",
      subscriptionAuth: true,
    },
  },
  {
    apiKey: { placeholder: "sk-or-v1-…", requirement: "required" },
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    displayName: "OpenRouter",
    fallbackModelId: "anthropic/claude-sonnet-4-6",
    id: "openrouter",
    modelIdPolicy: "provider-qualified",
    setup: {
      customModelIdPolicy: {
        errorMessage:
          'Invalid OpenRouter model id "{modelId}". Use vendor/model format.',
        pattern: "^[\\w.-]+/[\\w.:-]+$",
      },
      customModels: true,
      modelSelection: "specialized",
    },
  },
  {
    apiKey: { placeholder: "AIza…", requirement: "required" },
    apiKeyEnvVar: "GEMINI_API_KEY",
    deprecatedModelAliases: {
      "gemini-1.5-flash": "gemini-3-flash-preview",
      "gemini-1.5-pro": "gemini-3-flash-preview",
      "gemini-2.0-flash": "gemini-3-flash-preview",
      "gemini-2.0-flash-lite": "gemini-3-flash-preview",
      "gemini-2.0-pro-exp-02-05": "gemini-3-flash-preview",
      "gemini-2.5-flash": "gemini-3-flash-preview",
      "gemini-2.5-flash-lite": "gemini-3-flash-preview",
      "gemini-2.5-pro": "gemini-3-flash-preview",
    },
    discoveryBaseUrl: "https://generativelanguage.googleapis.com",
    discoveryModels: true,
    displayName: "Gemini",
    fallbackModelId: "gemini-3-flash-preview",
    id: "gemini",
    modelIdPolicy: "passthrough",
    setup: { customModels: true, modelSelection: "catalog" },
  },
  {
    apiKey: { placeholder: "sk-…", requirement: "required" },
    apiKeyEnvVar: null,
    discoveryBaseUrl: "https://api.deepseek.com",
    discoveryModels: true,
    displayName: "DeepSeek",
    fallbackModelId: "deepseek-v4-flash",
    id: "deepseek",
    setup: { customModels: true, modelSelection: "catalog" },
  },
  {
    apiKey: { placeholder: "csk-…", requirement: "required" },
    apiKeyEnvVar: "CEREBRAS_API_KEY",
    displayName: "Cerebras",
    fallbackModelId: "gpt-oss-120b",
    id: "cerebras",
    setup: {
      catalogSelectionAsCustomModel: true,
      customModels: true,
      modelSelection: "specialized",
    },
  },
  {
    apiKey: { placeholder: "fw_…", requirement: "required" },
    apiKeyEnvVar: "FIREWORKS_API_KEY",
    displayName: "Fireworks",
    fallbackModelId: "accounts/fireworks/models/kimi-k2p6",
    id: "fireworks",
    setup: {
      catalogSelectionAsCustomModel: true,
      customModels: true,
      customModelsRequired: true,
      modelSelection: "specialized",
    },
  },
  {
    allowMultipleInstances: true,
    apiKey: {
      placeholder: "Optional for local Ollama",
      requiredWhen: { equals: "cloud", field: "hostMode" },
      requirement: "conditional",
    },
    apiKeyEnvVar: "OLLAMA_API_KEY",
    displayName: "Ollama",
    fallbackModelId: "gpt-5.4",
    id: "ollama",
    setup: {
      baseUrlRequired: true,
      customModels: true,
      customModelsRequired: true,
      hostMode: "ollama",
    },
  },
  {
    allowMultipleInstances: true,
    apiKey: {
      placeholder: "Optional for local endpoints",
      requirement: "optional",
    },
    apiKeyEnvVar: "OPENAI_COMPATIBLE_API_KEY",
    discoveryModels: true,
    displayName: "Custom (OpenAI-compatible)",
    fallbackModelId: "custom-model",
    id: "openai_compatible",
    setup: {
      allowLocalDiscovery: true,
      baseUrlRequired: true,
      customModels: true,
      customModelsRequired: true,
      displayName: true,
      wireApi: true,
    },
  },
  {
    apiKey: { placeholder: "oc-…", requirement: "required" },
    apiKeyEnvVar: "OPENCODE_GO_API_KEY",
    displayName: "OpenCode Go",
    fallbackModelId: "opencode-go/kimi-k2.7-code",
    id: "opencode_go",
    modelIdPolicy: "passthrough",
    setup: {
      configureBaseUrl: "omit",
      customModelIdPolicy: {
        errorMessage:
          'Invalid OpenCode Go model id "{modelId}". Use opencode-go/model format.',
        pattern: "^opencode-go/",
      },
      customModels: true,
      modelSelection: "catalog",
    },
  },
  {
    apiKey: { placeholder: "sk-…", requirement: "required" },
    apiKeyEnvVar: "CLOUDFLARE_API_KEY",
    displayName: "Cloudflare Workers AI",
    fallbackModelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    id: "cloudflare",
    setup: {
      baseUrlInput: "cloudflare-account",
      baseUrlRequired: true,
      customModelIdPolicy: {
        errorMessage:
          'Invalid Cloudflare model id "{modelId}". Use @cf/ or @hf/ format.',
        pattern: "^@(cf|hf)/",
      },
      customModels: true,
      modelSelection: "catalog",
    },
  },
  {
    apiKey: { placeholder: "sk-…", requirement: "required" },
    apiKeyEnvVar: "MINIMAX_API_KEY",
    discoveryBaseUrl: "https://api.minimax.io/v1",
    discoveryModels: true,
    displayName: "MiniMax",
    fallbackModelId: "custom-model",
    id: "minimax",
    setup: {
      baseUrlRequired: true,
      customModels: true,
      customModelsRequired: true,
    },
  },
  {
    apiKey: { placeholder: "sk-…", requirement: "required" },
    apiKeyEnvVar: "MINIMAX_CN_API_KEY",
    discoveryBaseUrl: "https://api.minimaxi.com/v1",
    discoveryModels: true,
    displayName: "MiniMax (CN)",
    fallbackModelId: "custom-model",
    id: "minimax_cn",
    setup: {
      baseUrlRequired: true,
      customModels: true,
      customModelsRequired: true,
    },
  },
  {
    apiKey: { placeholder: "sk-…", requirement: "required" },
    apiKeyEnvVar: "XAI_API_KEY",
    discoveryBaseUrl: "https://api.x.ai/v1",
    discoveryModels: true,
    displayName: "xAI Grok",
    fallbackModelId: "custom-model",
    id: "xai",
    setup: {
      baseUrlRequired: true,
      customModels: true,
      customModelsRequired: true,
    },
  },
  {
    apiKey: { placeholder: "sk-…", requirement: "required" },
    apiKeyEnvVar: "ZHIPU_API_KEY",
    discoveryBaseUrl: "https://api.z.ai/api/paas/v4",
    discoveryModels: true,
    displayName: "GLM (Z.ai)",
    fallbackModelId: "custom-model",
    id: "zhipu",
    setup: {
      baseUrlRequired: true,
      customModels: true,
      customModelsRequired: true,
    },
  },
  {
    apiKey: { placeholder: "sk-…", requirement: "required" },
    apiKeyEnvVar: "ZHIPU_CN_API_KEY",
    discoveryBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    discoveryModels: true,
    displayName: "GLM (CN)",
    fallbackModelId: "custom-model",
    id: "zhipu_cn",
    setup: {
      baseUrlRequired: true,
      customModels: true,
      customModelsRequired: true,
    },
  },
] as const satisfies readonly BuiltinProviderDefinition[];

export type BuiltinProviderName =
  (typeof BUILTIN_PROVIDER_DEFINITIONS)[number]["id"];

const DEFINITIONS_BY_ID = new Map<string, BuiltinProviderDefinition>(
  BUILTIN_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition])
);

const CUSTOM_MODEL_ID_PATTERNS = new Map<string, RegExp>(
  BUILTIN_PROVIDER_DEFINITIONS.flatMap((definition) => {
    const setup: ProviderSetupMetadata | undefined = definition.setup;
    const pattern = setup?.customModelIdPolicy?.pattern;
    return pattern ? [[definition.id, new RegExp(pattern)]] : [];
  })
);

export function getBuiltinProviderDefinition(
  providerId: string
): BuiltinProviderDefinition | undefined {
  return DEFINITIONS_BY_ID.get(providerId);
}

export function providerSetupHasFeature(
  definition: Pick<BuiltinProviderDefinition, "setup"> | undefined,
  feature: keyof ProviderSetupMetadata
): boolean {
  return Boolean(definition?.setup?.[feature]);
}

export function isSubscriptionProvider(
  providerId: string
): providerId is "chatgpt" | "claude" {
  return (
    getBuiltinProviderDefinition(providerId)?.setup?.subscriptionAuth === true
  );
}

export function providerUsesGenericCustomModelSetup(
  definition:
    | Pick<BuiltinProviderDefinition, "discoveryModels" | "setup">
    | undefined
): boolean {
  const setup = definition?.setup;
  return Boolean(
    setup?.customModels &&
      !definition?.discoveryModels &&
      !setup.displayName &&
      !setup.hostMode &&
      !setup.modelSelection
  );
}

export function validateProviderCustomModelId(
  providerId: string,
  modelId: string
): string | null {
  const definition = getBuiltinProviderDefinition(providerId);
  const policy = definition?.setup?.customModelIdPolicy;
  const pattern = CUSTOM_MODEL_ID_PATTERNS.get(providerId);
  if (!(policy && pattern) || pattern.test(modelId)) {
    return null;
  }

  return policy.errorMessage.replaceAll("{modelId}", modelId);
}
