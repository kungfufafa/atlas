import {
  defaultDiscoveryBaseUrl,
  getBuiltinProviderDefinition,
  PROVIDER_CAPABILITY_CONTRACT_VERSION,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityClaim,
  type ProviderCapabilityClaims,
  type ProviderCapabilityConstraints,
  type ProviderCapabilityManifestV1,
  type ProviderInstance,
  type ProviderManifestModelV1,
  providerApiKeyIsRequired,
  readEnvValue,
  resolveOllamaHostMode,
  STANDARD_PROVIDER_CAPABILITIES,
} from "@atlas/core";
import { createAnthropicProvider } from "../anthropic";
import { createCerebrasProvider } from "../cerebras";
import { createCloudflareProvider } from "../cloudflare";
import {
  compatibleModelReasoningEffortValues,
  compatibleModelSupportsThinking,
} from "../compatible-models";
import { createFireworksProvider } from "../fireworks";
import { createGeminiProvider } from "../gemini";
import { createOllamaProvider } from "../ollama";
import {
  createOpenAIProvider,
  openAIEndpointSupportsNativeWebSearch,
} from "../openai";
import { createOpenAICompatibleProvider } from "../openai-compatible";
import { createOpenCodeGoProvider } from "../opencode-go";
import { getModelsForOpenCodeGoInstance } from "../opencode-go/catalog";
import { createOpenRouterProvider } from "../openrouter";
import {
  geminiAudioTranscriptionExecutor,
  openAIAudioTranscriptionExecutor,
} from "./executors/audio-transcription";
import {
  geminiImageGenerationExecutor,
  IMAGE_GENERATION_SIZES,
  openAIImageGenerationExecutor,
} from "./executors/image-generation";
import { createVisionUnderstandingExecutor } from "./executors/vision-understanding";
import {
  createOpenAICompatibleModelDiscovery,
  discoverFireworksModels,
  discoverOllamaModels,
  discoverOpenAIModels,
  discoverOpenCodeGoModels,
} from "./model-discovery";
import {
  type ProviderAdapterRegistration,
  ProviderAdapterRegistry,
  type ProviderCapabilityExecutor,
  type ProviderChatFactoryContext,
} from "./registry";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

const CHAT_COMPLETION = PROVIDER_CAPABILITY_IDS.chatCompletion;
const CHAT_INPUT_IMAGE = PROVIDER_CAPABILITY_IDS.chatInputImage;
const CHAT_NATIVE_WEB_SEARCH = PROVIDER_CAPABILITY_IDS.chatNativeWebSearch;
const CHAT_REASONING = PROVIDER_CAPABILITY_IDS.chatReasoning;
const CHAT_STREAMING = PROVIDER_CAPABILITY_IDS.chatStreaming;
const CHAT_STRUCTURED_OUTPUT = PROVIDER_CAPABILITY_IDS.chatStructuredOutput;
const CHAT_TOOL_USE = PROVIDER_CAPABILITY_IDS.chatToolUse;
const IMAGE_UNDERSTANDING = PROVIDER_CAPABILITY_IDS.imageUnderstanding;

interface BuiltinManifestOptions {
  chatCapabilities: readonly string[];
  displayName: string;
  implementedCapabilities?: readonly string[];
  modelConstraints?: Partial<Record<string, ProviderCapabilityConstraints>>;
  modelDefaults?: Partial<Record<string, CapabilitySupportPreset>>;
  models?: ProviderManifestModelV1[];
  native?: Partial<Record<string, CapabilitySupportPreset>>;
  providerId: string;
}

type CapabilitySupportPreset = "supported" | "unsupported" | "unknown";

const DEFAULT_CHAT_CAPABILITIES = [
  CHAT_COMPLETION,
  CHAT_INPUT_IMAGE,
  CHAT_REASONING,
  CHAT_STREAMING,
  CHAT_STRUCTURED_OUTPUT,
  CHAT_TOOL_USE,
] as const;

const NATIVE_WEB_SEARCH_CHAT_CAPABILITIES = [
  ...DEFAULT_CHAT_CAPABILITIES,
  CHAT_NATIVE_WEB_SEARCH,
] as const;

const NATIVE_WEB_SEARCH_CONSTRAINTS: ProviderCapabilityConstraints = {
  supportedValues: { "request.multimodal": [false] },
};

const NATIVE_WEB_SEARCH_WITHOUT_LOCAL_TOOLS_CONSTRAINTS: ProviderCapabilityConstraints =
  {
    supportedValues: {
      "request.local-tools": [false],
      "request.multimodal": [false],
    },
  };

const TEXT_ONLY_CHAT_CAPABILITIES = [
  CHAT_COMPLETION,
  CHAT_REASONING,
  CHAT_STREAMING,
  CHAT_STRUCTURED_OUTPUT,
  CHAT_TOOL_USE,
] as const;

const CHAT_NATIVE_DEFAULTS = {
  [CHAT_COMPLETION]: "supported",
  [CHAT_REASONING]: "unknown",
  [CHAT_STREAMING]: "supported",
  [CHAT_STRUCTURED_OUTPUT]: "unknown",
  [CHAT_TOOL_USE]: "unknown",
} as const satisfies Partial<Record<string, CapabilitySupportPreset>>;

function createManifest(
  options: BuiltinManifestOptions
): ProviderCapabilityManifestV1 {
  const implemented = new Set([
    ...options.chatCapabilities,
    ...(options.implementedCapabilities ?? []),
  ]);
  const capabilities: ProviderCapabilityManifestV1["capabilities"] = {};

  for (const definition of STANDARD_PROVIDER_CAPABILITIES) {
    const nativeStatus =
      options.native?.[definition.id] ??
      (definition.id === IMAGE_UNDERSTANDING
        ? options.native?.[CHAT_INPUT_IMAGE]
        : undefined) ??
      CHAT_NATIVE_DEFAULTS[
        definition.id as keyof typeof CHAT_NATIVE_DEFAULTS
      ] ??
      "unknown";
    const modelDefaultStatus =
      options.modelDefaults?.[definition.id] ??
      (definition.id === IMAGE_UNDERSTANDING
        ? options.modelDefaults?.[CHAT_INPUT_IMAGE]
        : undefined) ??
      (definition.id === CHAT_COMPLETION ? "supported" : "unknown");
    capabilities[definition.id] = {
      contractVersion: PROVIDER_CAPABILITY_CONTRACT_VERSION,
      implementation: {
        status: implemented.has(definition.id) ? "available" : "unavailable",
      },
      metadata: {
        description: definition.description,
        label: definition.label,
        routable: definition.routable,
      },
      modelDefault: claim(
        modelDefaultStatus,
        options.modelConstraints?.[definition.id]
      ),
      native: claim(nativeStatus),
    };
  }

  return {
    adapterApiVersion: 1,
    capabilities,
    manifestRevision: "2026-08-27",
    ...(options.models ? { models: options.models } : {}),
    provider: {
      displayName: options.displayName,
      id: options.providerId,
    },
    schemaVersion: 1,
  };
}

function claim(
  status: CapabilitySupportPreset,
  constraints?: ProviderCapabilityConstraints
): ProviderCapabilityClaim {
  return {
    ...(constraints ? { constraints } : {}),
    source: "static-manifest",
    status,
    verified: status !== "unknown",
  };
}

function registration(options: {
  chatCapabilities?: readonly string[];
  credentialSetupValues?: (
    instance: ProviderInstance
  ) => Readonly<Record<string, string | undefined>>;
  createChatClient: NonNullable<
    ProviderAdapterRegistration["createChatClient"]
  >;
  discoverModels?: ProviderAdapterRegistration["discoverModels"];
  displayName: string;
  executors?: Readonly<Record<string, ProviderCapabilityExecutor>>;
  listConfiguredModels?: ProviderAdapterRegistration["listConfiguredModels"];
  modelConstraints?: BuiltinManifestOptions["modelConstraints"];
  modelDefaults?: BuiltinManifestOptions["modelDefaults"];
  modelDiscoveryOnCatalogRefresh?: boolean;
  missingCredentialMessage?: ProviderAdapterRegistration["missingCredentialMessage"];
  models?: BuiltinManifestOptions["models"];
  native?: BuiltinManifestOptions["native"];
  providerId: string;
  resolveInstanceCapabilityClaims?: ProviderAdapterRegistration["resolveInstanceCapabilityClaims"];
}): ProviderAdapterRegistration {
  const chatCapabilities =
    options.chatCapabilities ?? DEFAULT_CHAT_CAPABILITIES;
  const visionExecutor = chatCapabilities.includes(CHAT_INPUT_IMAGE)
    ? createVisionUnderstandingExecutor((context) =>
        options.createChatClient({
          apiKey: context.apiKey,
          cloudflareAccountId: readEnvValue(
            process.env,
            "CLOUDFLARE_ACCOUNT_ID"
          ),
          instance: context.instance,
          model: context.model,
          providerReplayRevision:
            context.instance.replayRevision ??
            `capability:${context.instance.id}:${context.instance.createdAt}`,
        })
      )
    : undefined;
  const executors: Record<string, ProviderCapabilityExecutor> = {
    ...(visionExecutor ? { [IMAGE_UNDERSTANDING]: visionExecutor } : {}),
    ...options.executors,
  };
  const apiKeyPolicy = getBuiltinProviderDefinition(options.providerId)?.apiKey;
  return {
    chatCapabilities,
    createChatClient: options.createChatClient,
    credentialsRequired: (instance) =>
      apiKeyPolicy
        ? providerApiKeyIsRequired(
            apiKeyPolicy,
            options.credentialSetupValues?.(instance) ??
              stringSetupValues(instance)
          )
        : true,
    discoverModels: options.discoverModels,
    executors,
    listConfiguredModels: options.listConfiguredModels,
    manifest: createManifest({
      chatCapabilities,
      displayName: options.displayName,
      implementedCapabilities: Object.keys(executors),
      modelConstraints: options.modelConstraints,
      modelDefaults: options.modelDefaults,
      models: options.models,
      native: options.native,
      providerId: options.providerId,
    }),
    missingCredentialMessage:
      options.missingCredentialMessage ?? (() => "API key is required."),
    modelDiscoveryOnCatalogRefresh: options.modelDiscoveryOnCatalogRefresh,
    resolveInstanceCapabilityClaims: options.resolveInstanceCapabilityClaims,
  };
}

function stringSetupValues(instance: ProviderInstance): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [field, value] of Object.entries(instance)) {
    if (typeof value === "string") {
      values[field] = value;
    }
  }
  return values;
}

function modelsSupporting(
  capabilityId: string,
  modelIds: readonly string[],
  constraints?: ProviderCapabilityConstraints
): ProviderManifestModelV1[] {
  return modelIds.map((id) => ({
    capabilities: {
      [capabilityId]: {
        ...claim("supported"),
        ...(constraints ? { constraints } : {}),
      },
    },
    id,
  }));
}

function openAIStyleRegistration(options: {
  displayName: string;
  native?: BuiltinManifestOptions["native"];
  providerId:
    | "deepseek"
    | "minimax"
    | "minimax_cn"
    | "xai"
    | "zhipu"
    | "zhipu_cn";
}): ProviderAdapterRegistration {
  const discoveryBaseUrl = defaultDiscoveryBaseUrl(options.providerId);

  return registration({
    chatCapabilities:
      options.providerId === "deepseek"
        ? TEXT_ONLY_CHAT_CAPABILITIES
        : DEFAULT_CHAT_CAPABILITIES,
    createChatClient: (context) =>
      createOpenAIProvider({
        apiKey: context.apiKey,
        baseUrl:
          context.instance?.baseUrl?.trim() ||
          (options.providerId === "deepseek"
            ? DEFAULT_DEEPSEEK_BASE_URL
            : defaultDiscoveryBaseUrl(options.providerId)) ||
          undefined,
        customModels: context.instance?.customModels,
        model: context.model,
        providerInstanceId: context.instance?.id,
        providerName: options.providerId,
        providerReplayRevision: context.providerReplayRevision,
      }),
    discoverModels: discoveryBaseUrl
      ? createOpenAICompatibleModelDiscovery({
          defaultBaseUrl: () => discoveryBaseUrl,
        })
      : undefined,
    displayName: options.displayName,
    modelDefaults: {
      [CHAT_INPUT_IMAGE]:
        options.providerId === "deepseek" ? "unsupported" : "unknown",
    },
    native: options.native,
    providerId: options.providerId,
  });
}

export const BUILTIN_PROVIDER_ADAPTERS: readonly ProviderAdapterRegistration[] =
  [
    registration({
      chatCapabilities: NATIVE_WEB_SEARCH_CHAT_CAPABILITIES,
      createChatClient: (context) =>
        createAnthropicProvider({
          apiKey: context.apiKey,
          baseUrl: context.instance?.baseUrl?.trim() || undefined,
          model: context.model,
          providerInstanceId: context.instance?.id,
          providerReplayRevision: context.providerReplayRevision,
        }),
      displayName: "Anthropic",
      modelConstraints: {
        [CHAT_NATIVE_WEB_SEARCH]: NATIVE_WEB_SEARCH_CONSTRAINTS,
      },
      modelDefaults: {
        [CHAT_INPUT_IMAGE]: "supported",
        [CHAT_NATIVE_WEB_SEARCH]: "supported",
        [CHAT_STREAMING]: "supported",
        [CHAT_TOOL_USE]: "supported",
      },
      native: {
        [CHAT_INPUT_IMAGE]: "supported",
        [CHAT_NATIVE_WEB_SEARCH]: "supported",
        [CHAT_STREAMING]: "supported",
        [CHAT_TOOL_USE]: "supported",
      },
      providerId: "anthropic",
    }),
    registration({
      createChatClient: (context) =>
        createCerebrasProvider({
          apiKey: context.apiKey,
          customModels: context.instance?.customModels,
          model: context.model,
        }),
      displayName: "Cerebras",
      modelDefaults: {
        [CHAT_STRUCTURED_OUTPUT]: "supported",
      },
      native: {
        [CHAT_INPUT_IMAGE]: "supported",
        [CHAT_STRUCTURED_OUTPUT]: "supported",
        [CHAT_TOOL_USE]: "supported",
      },
      providerId: "cerebras",
    }),
    openAIStyleRegistration({
      displayName: "DeepSeek",
      native: { [CHAT_INPUT_IMAGE]: "unsupported" },
      providerId: "deepseek",
    }),
    registration({
      createChatClient: (context) =>
        createFireworksProvider({
          apiKey: context.apiKey,
          customModels: context.instance?.customModels,
          model: context.model,
        }),
      discoverModels: discoverFireworksModels,
      displayName: "Fireworks",
      native: {
        [CHAT_INPUT_IMAGE]: "supported",
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: "supported",
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported",
      },
      providerId: "fireworks",
    }),
    registration({
      createChatClient: (context) =>
        createCloudflareProvider({
          accountId: context.cloudflareAccountId ?? "",
          apiKey: context.apiKey,
          instance: context.instance,
          model: context.model,
          providerReplayRevision: context.providerReplayRevision,
        }),
      displayName: "Cloudflare Workers AI",
      native: {
        [CHAT_INPUT_IMAGE]: "supported",
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: "supported",
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported",
      },
      providerId: "cloudflare",
    }),
    registration({
      chatCapabilities: NATIVE_WEB_SEARCH_CHAT_CAPABILITIES,
      createChatClient: (context) =>
        createGeminiProvider({
          apiKey: context.apiKey,
          baseUrl: context.instance?.baseUrl?.trim() || undefined,
          model: context.model,
          providerInstanceId: context.instance?.id,
          providerReplayRevision: context.providerReplayRevision,
        }),
      displayName: "Gemini",
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]:
          geminiAudioTranscriptionExecutor,
        [PROVIDER_CAPABILITY_IDS.imageGeneration]:
          geminiImageGenerationExecutor,
      },
      modelConstraints: {
        [CHAT_NATIVE_WEB_SEARCH]:
          NATIVE_WEB_SEARCH_WITHOUT_LOCAL_TOOLS_CONSTRAINTS,
      },
      modelDefaults: {
        [CHAT_INPUT_IMAGE]: "supported",
        [CHAT_NATIVE_WEB_SEARCH]: "supported",
        [CHAT_STREAMING]: "supported",
        [CHAT_STRUCTURED_OUTPUT]: "supported",
        [CHAT_TOOL_USE]: "supported",
      },
      models: [
        ...modelsSupporting(PROVIDER_CAPABILITY_IDS.audioTranscription, [
          "gemini-3-flash-preview",
          "gemini-2.0-flash",
          "gemini-1.5-flash",
          "gemini-1.5-pro",
        ]),
        ...modelsSupporting(
          PROVIDER_CAPABILITY_IDS.imageGeneration,
          ["gemini-2.5-flash-image"],
          {
            supportedValues: { size: ["1024x1024", "auto"] },
          }
        ),
      ],
      native: {
        [CHAT_INPUT_IMAGE]: "supported",
        [CHAT_NATIVE_WEB_SEARCH]: "supported",
        [CHAT_STREAMING]: "supported",
        [CHAT_STRUCTURED_OUTPUT]: "supported",
        [CHAT_TOOL_USE]: "supported",
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: "supported",
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported",
      },
      providerId: "gemini",
    }),
    registration({
      chatCapabilities: NATIVE_WEB_SEARCH_CHAT_CAPABILITIES,
      createChatClient: (context) =>
        createOpenAIProvider({
          apiKey: context.apiKey,
          baseUrl: context.instance?.baseUrl?.trim() || undefined,
          customModels: context.instance?.customModels,
          model: context.model,
          providerInstanceId: context.instance?.id,
          providerReplayRevision: context.providerReplayRevision,
        }),
      discoverModels: discoverOpenAIModels,
      displayName: "OpenAI",
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]:
          openAIAudioTranscriptionExecutor,
        [PROVIDER_CAPABILITY_IDS.imageGeneration]:
          openAIImageGenerationExecutor,
      },
      modelConstraints: {
        [CHAT_NATIVE_WEB_SEARCH]: NATIVE_WEB_SEARCH_CONSTRAINTS,
      },
      modelDefaults: {
        [CHAT_INPUT_IMAGE]: "supported",
        [CHAT_NATIVE_WEB_SEARCH]: "supported",
        [CHAT_STREAMING]: "supported",
        [CHAT_STRUCTURED_OUTPUT]: "supported",
        [CHAT_TOOL_USE]: "supported",
      },
      models: [
        ...modelsSupporting(PROVIDER_CAPABILITY_IDS.audioTranscription, [
          "whisper-1",
          "gpt-4o-transcribe",
          "gpt-4o-mini-transcribe",
        ]),
        ...modelsSupporting(
          PROVIDER_CAPABILITY_IDS.imageGeneration,
          ["gpt-image-2"],
          {
            supportedValues: { size: [...IMAGE_GENERATION_SIZES] },
          }
        ),
      ],
      native: {
        [CHAT_INPUT_IMAGE]: "supported",
        [CHAT_NATIVE_WEB_SEARCH]: "supported",
        [CHAT_STREAMING]: "supported",
        [CHAT_STRUCTURED_OUTPUT]: "supported",
        [CHAT_TOOL_USE]: "supported",
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: "supported",
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported",
      },
      providerId: "openai",
      resolveInstanceCapabilityClaims: ({
        instance,
      }): ProviderCapabilityClaims => {
        if (openAIEndpointSupportsNativeWebSearch(instance.baseUrl)) {
          return {};
        }
        return {
          [CHAT_NATIVE_WEB_SEARCH]: {
            source: "provider-discovery",
            status: "unsupported",
            verified: true,
          },
        };
      },
    }),
    registration({
      createChatClient: (context) =>
        createOpenRouterProvider({
          apiKey: context.apiKey,
          customModels: context.instance?.customModels,
          model: context.model,
        }),
      displayName: "OpenRouter",
      native: {
        [CHAT_INPUT_IMAGE]: "supported",
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: "supported",
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported",
      },
      providerId: "openrouter",
    }),
    registration({
      createChatClient: (context) =>
        createOpenCodeGoProvider({
          apiKey: context.apiKey,
          model: context.model,
          providerInstanceId: context.instance?.id,
          providerReplayRevision: context.providerReplayRevision,
        }),
      discoverModels: discoverOpenCodeGoModels,
      displayName: "OpenCode Go",
      listConfiguredModels: getModelsForOpenCodeGoInstance,
      providerId: "opencode_go",
    }),
    registration({
      createChatClient: (context) =>
        createOllamaProvider({
          apiKey: context.apiKey,
          instance: context.instance,
          model: context.model,
          providerReplayRevision: context.providerReplayRevision,
        }),
      credentialSetupValues: (instance) => ({
        hostMode: resolveOllamaHostMode(instance),
      }),
      discoverModels: discoverOllamaModels,
      displayName: "Ollama",
      missingCredentialMessage: (_instance, operation) =>
        operation === "connection-validation"
          ? "API key is required for Ollama Cloud mode."
          : "API key is required for Ollama Cloud.",
      native: { [CHAT_INPUT_IMAGE]: "supported" },
      providerId: "ollama",
    }),
    registration({
      createChatClient: createCompatibleChatClient,
      discoverModels: createOpenAICompatibleModelDiscovery({
        allowLocalEndpoint: true,
      }),
      displayName: "Custom OpenAI-compatible",
      modelDiscoveryOnCatalogRefresh: true,
      providerId: "openai_compatible",
    }),
    openAIStyleRegistration({
      displayName: "MiniMax",
      native: { [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported" },
      providerId: "minimax",
    }),
    openAIStyleRegistration({
      displayName: "MiniMax (CN)",
      native: { [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported" },
      providerId: "minimax_cn",
    }),
    openAIStyleRegistration({
      displayName: "xAI",
      native: {
        [CHAT_INPUT_IMAGE]: "supported",
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: "supported",
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported",
      },
      providerId: "xai",
    }),
    openAIStyleRegistration({
      displayName: "Z.ai",
      native: {
        [CHAT_INPUT_IMAGE]: "supported",
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: "supported",
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported",
      },
      providerId: "zhipu",
    }),
    openAIStyleRegistration({
      displayName: "GLM (CN)",
      native: {
        [CHAT_INPUT_IMAGE]: "supported",
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: "supported",
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported",
      },
      providerId: "zhipu_cn",
    }),
  ] as const;

function createCompatibleChatClient(context: ProviderChatFactoryContext) {
  const baseUrl = context.instance?.baseUrl?.trim();
  const displayName = context.instance?.label?.trim();
  if (!(baseUrl && displayName)) {
    throw new Error("OpenAI-compatible provider requires baseUrl and label.");
  }

  return createOpenAICompatibleProvider({
    apiKey: context.apiKey,
    baseUrl,
    displayName,
    model: context.model,
    providerInstanceId: context.instance?.id,
    providerReplayRevision: context.providerReplayRevision,
    reasoningEffortValues: compatibleModelReasoningEffortValues(
      context.model,
      context.instance?.customModels,
      { baseUrl, providerLabel: displayName }
    ),
    supportsThinking: compatibleModelSupportsThinking(
      context.model,
      context.instance?.customModels
    ),
    wireApi: context.instance?.wireApi,
  });
}

export function createBuiltinProviderAdapterRegistry(): ProviderAdapterRegistry {
  const registry = new ProviderAdapterRegistry();
  for (const adapter of BUILTIN_PROVIDER_ADAPTERS) {
    registry.register(adapter);
  }
  return registry;
}

export const builtinProviderAdapterRegistry =
  createBuiltinProviderAdapterRegistry();
