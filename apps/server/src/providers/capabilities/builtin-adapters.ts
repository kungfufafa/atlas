import {
  AtlasApiError,
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
  getModelsForProviderInstance,
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
  createChatgptProvider,
  createClaudeProvider,
  getChatgptRuntime,
  getSubscriptionRuntime,
  SubscriptionRuntimeError,
} from "../subscription";
import {
  cloudflareAudioTranscriptionExecutor,
  fireworksAudioTranscriptionExecutor,
  geminiAudioTranscriptionExecutor,
  ollamaAudioTranscriptionExecutor,
  openAIAudioTranscriptionExecutor,
  openRouterAudioTranscriptionExecutor,
  xAIAudioTranscriptionExecutor,
  zhipuAudioTranscriptionExecutor,
  zhipuCnAudioTranscriptionExecutor,
} from "./executors/audio-transcription";
import {
  cloudflareImageGenerationExecutor,
  fireworksImageGenerationExecutor,
  geminiImageGenerationExecutor,
  IMAGE_GENERATION_SIZES,
  minimaxImageGenerationExecutor,
  normalizeImageGenerationInput,
  normalizeImageGenerationOutput,
  ollamaImageGenerationExecutor,
  openAIImageGenerationExecutor,
  openRouterImageGenerationExecutor,
  xAIImageGenerationExecutor,
  zhipuCnImageGenerationExecutor,
  zhipuImageGenerationExecutor,
} from "./executors/image-generation";
import { createVisionUnderstandingExecutor } from "./executors/vision-understanding";
import {
  createOpenAICompatibleModelDiscovery,
  createSubscriptionModelDiscovery,
  discoverAnthropicModels,
  discoverCerebrasModels,
  discoverFireworksModels,
  discoverGeminiModels,
  discoverOllamaModels,
  discoverOpenAIModels,
  discoverOpenCodeGoModels,
  discoverOpenRouterModels,
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

const CHATGPT_CHAT_CAPABILITIES = [
  ...TEXT_ONLY_CHAT_CAPABILITIES,
  CHAT_INPUT_IMAGE,
] as const;

const CHAT_NATIVE_DEFAULTS = {
  [CHAT_COMPLETION]: "supported",
  [CHAT_REASONING]: "unknown",
  [CHAT_STREAMING]: "supported",
  [CHAT_STRUCTURED_OUTPUT]: "unknown",
  [CHAT_TOOL_USE]: "unknown",
} as const satisfies Partial<Record<string, CapabilitySupportPreset>>;

const CHAT_TRANSPORT_DEFAULTS = {
  [CHAT_REASONING]: "unknown",
  [CHAT_STREAMING]: "supported",
  [CHAT_TOOL_USE]: "supported",
} as const satisfies Partial<Record<string, CapabilitySupportPreset>>;

/** Per-model features require model evidence even when the adapter implements them. */
const CHAT_MODEL_DEFAULTS = {
  [CHAT_STREAMING]: "supported",
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
  executors?: Readonly<Record<string, ProviderCapabilityExecutor>>;
  models?: BuiltinManifestOptions["models"];
  native?: BuiltinManifestOptions["native"];
  providerId:
    | "deepseek"
    | "minimax"
    | "minimax_cn"
    | "xai"
    | "zhipu"
    | "zhipu_cn";
}): ProviderAdapterRegistration {
  const discoveryBaseUrl =
    defaultDiscoveryBaseUrl(options.providerId) ??
    (options.providerId === "deepseek" ? DEFAULT_DEEPSEEK_BASE_URL : undefined);

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
    executors: options.executors,
    modelDefaults: CHAT_MODEL_DEFAULTS,
    models: options.models,
    native: {
      ...CHAT_TRANSPORT_DEFAULTS,
      ...options.native,
    },
    providerId: options.providerId,
  });
}

const ALL_IMAGE_SIZES: ProviderCapabilityConstraints = {
  supportedValues: { size: [...IMAGE_GENERATION_SIZES] },
};

const SQUARE_OR_AUTO_IMAGE_SIZES: ProviderCapabilityConstraints = {
  supportedValues: { size: ["1024x1024", "auto"] },
};

const CHATGPT_NATIVE_IMAGE_SIZES: ProviderCapabilityConstraints = {
  supportedValues: { size: ["auto"] },
};

const chatgptImageGenerationExecutor: ProviderCapabilityExecutor = async (
  context,
  input
) => {
  const normalized = normalizeImageGenerationInput(input);
  if (normalized.size !== "auto") {
    throw new AtlasApiError(
      'ChatGPT subscription image generation supports native size "auto" only.',
      400
    );
  }
  const image = await getChatgptRuntime().generateImage(
    normalized,
    context.model
  );
  if (!(image.data && image.mediaType && image.width && image.height)) {
    throw new AtlasApiError(
      "ChatGPT returned an incomplete image-generation result.",
      502
    );
  }
  return normalizeImageGenerationOutput({
    data: image.data,
    mediaType: image.mediaType,
    model: image.model ?? "gpt-image-2",
    revisedPrompt: image.revisedPrompt,
    size: `${image.width}x${image.height}`,
  });
};

function listSubscriptionModels(
  kind: "chatgpt" | "claude"
): NonNullable<ProviderAdapterRegistration["listConfiguredModels"]> {
  return async (instance) => {
    try {
      const models = await getSubscriptionRuntime(kind).listModels();
      if (models.length === 0) {
        throw new AtlasApiError(
          `No models are available for the ${kind === "chatgpt" ? "ChatGPT" : "Claude"} subscription on this Atlas host.`,
          503
        );
      }
      const storedDefault = instance.customModels?.find(
        (model) => model.default
      )?.id;
      const liveHasStoredDefault = models.some(
        (model) => model.id === storedDefault
      );
      return models.map((model) => ({
        ...model,
        ...(liveHasStoredDefault
          ? { default: model.id === storedDefault }
          : {}),
        providerId: instance.id,
        providerLabel: instance.label,
      }));
    } catch (error) {
      if (
        error instanceof AtlasApiError &&
        (error.status === 409 || error.status === 503)
      ) {
        throw error;
      }
      if (
        error instanceof SubscriptionRuntimeError &&
        (error.code === "authentication_expired" ||
          error.code === "provider_unavailable")
      ) {
        const label = kind === "chatgpt" ? "ChatGPT" : "Claude";
        throw new AtlasApiError(
          error.code === "authentication_expired"
            ? `${label} is not connected on this Atlas host. Ask a Superadmin to reconnect it.`
            : `${label} runtime is not available on this Atlas host. Ask a Superadmin to check it.`,
          error.code === "authentication_expired" ? 409 : 503
        );
      }
      throw error;
    }
  };
}

export const BUILTIN_PROVIDER_ADAPTERS: readonly ProviderAdapterRegistration[] =
  [
    registration({
      chatCapabilities: CHATGPT_CHAT_CAPABILITIES,
      createChatClient: (context) =>
        createChatgptProvider({
          model: context.model,
        }),
      discoverModels: createSubscriptionModelDiscovery("chatgpt"),
      displayName: "ChatGPT",
      executors: {
        [PROVIDER_CAPABILITY_IDS.imageGeneration]:
          chatgptImageGenerationExecutor,
      },
      listConfiguredModels: listSubscriptionModels("chatgpt"),
      missingCredentialMessage: () =>
        "ChatGPT is not authenticated. Connect ChatGPT through Codex and try again.",
      modelConstraints: {
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: CHATGPT_NATIVE_IMAGE_SIZES,
      },
      modelDefaults: {
        [CHAT_STREAMING]: "supported",
        [CHAT_TOOL_USE]: "supported",
      },
      native: {
        [CHAT_REASONING]: "supported",
        [CHAT_STREAMING]: "supported",
        [CHAT_TOOL_USE]: "supported",
      },
      providerId: "chatgpt",
    }),
    registration({
      chatCapabilities: NATIVE_WEB_SEARCH_CHAT_CAPABILITIES,
      createChatClient: (context) =>
        createAnthropicProvider({
          apiKey: context.apiKey,
          baseUrl: context.instance?.baseUrl?.trim() || undefined,
          customModels: context.instance?.customModels,
          model: context.model,
          providerInstanceId: context.instance?.id,
          providerReplayRevision: context.providerReplayRevision,
        }),
      discoverModels: discoverAnthropicModels,
      displayName: "Anthropic",
      modelConstraints: {
        [CHAT_NATIVE_WEB_SEARCH]: NATIVE_WEB_SEARCH_CONSTRAINTS,
      },
      modelDefaults: CHAT_MODEL_DEFAULTS,
      native: {
        ...CHAT_TRANSPORT_DEFAULTS,
        [CHAT_INPUT_IMAGE]: "supported",
        [CHAT_NATIVE_WEB_SEARCH]: "supported",
      },
      providerId: "anthropic",
    }),
    registration({
      chatCapabilities: TEXT_ONLY_CHAT_CAPABILITIES,
      createChatClient: (context) =>
        createClaudeProvider({
          model: context.model,
        }),
      discoverModels: createSubscriptionModelDiscovery("claude"),
      displayName: "Claude",
      listConfiguredModels: listSubscriptionModels("claude"),
      missingCredentialMessage: () =>
        "Claude is not authenticated. Run `claude auth login` and try again.",
      modelDefaults: {
        [CHAT_REASONING]: "unknown",
        [CHAT_STREAMING]: "supported",
        [CHAT_TOOL_USE]: "supported",
      },
      native: {
        [CHAT_REASONING]: "supported",
        [CHAT_STREAMING]: "supported",
        [CHAT_TOOL_USE]: "supported",
      },
      providerId: "claude",
    }),
    registration({
      createChatClient: (context) =>
        createCerebrasProvider({
          apiKey: context.apiKey,
          customModels: context.instance?.customModels,
          model: context.model,
        }),
      discoverModels: discoverCerebrasModels,
      displayName: "Cerebras",
      modelDefaults: CHAT_MODEL_DEFAULTS,
      native: {
        ...CHAT_TRANSPORT_DEFAULTS,
        [CHAT_INPUT_IMAGE]: "supported",
        [CHAT_STRUCTURED_OUTPUT]: "supported",
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
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]:
          fireworksAudioTranscriptionExecutor,
        [PROVIDER_CAPABILITY_IDS.imageGeneration]:
          fireworksImageGenerationExecutor,
      },
      modelDefaults: CHAT_MODEL_DEFAULTS,
      models: [
        ...modelsSupporting(PROVIDER_CAPABILITY_IDS.audioTranscription, [
          "whisper-v3",
          "whisper-v3-turbo",
        ]),
        ...modelsSupporting(
          PROVIDER_CAPABILITY_IDS.imageGeneration,
          [
            "accounts/fireworks/models/flux-1-schnell-fp8",
            "accounts/fireworks/models/flux-1-dev-fp8",
            "accounts/fireworks/models/flux-kontext-pro",
            "accounts/fireworks/models/playground-v2-5-1024px-aesthetic",
          ],
          ALL_IMAGE_SIZES
        ),
      ],
      native: {
        ...CHAT_TRANSPORT_DEFAULTS,
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
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]:
          cloudflareAudioTranscriptionExecutor,
        [PROVIDER_CAPABILITY_IDS.imageGeneration]:
          cloudflareImageGenerationExecutor,
      },
      modelDefaults: CHAT_MODEL_DEFAULTS,
      models: [
        ...modelsSupporting(PROVIDER_CAPABILITY_IDS.audioTranscription, [
          "@cf/openai/whisper",
          "@cf/openai/whisper-large-v3-turbo",
          "@cf/openai/whisper-tiny-en",
        ]),
        ...modelsSupporting(
          PROVIDER_CAPABILITY_IDS.imageGeneration,
          ["@cf/black-forest-labs/flux-1-schnell"],
          SQUARE_OR_AUTO_IMAGE_SIZES
        ),
      ],
      native: {
        ...CHAT_TRANSPORT_DEFAULTS,
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
          customModels: context.instance?.customModels,
          model: context.model,
          providerInstanceId: context.instance?.id,
          providerReplayRevision: context.providerReplayRevision,
        }),
      discoverModels: discoverGeminiModels,
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
      modelDefaults: CHAT_MODEL_DEFAULTS,
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
        ...CHAT_TRANSPORT_DEFAULTS,
        [CHAT_INPUT_IMAGE]: "supported",
        [CHAT_NATIVE_WEB_SEARCH]: "supported",
        [CHAT_STRUCTURED_OUTPUT]: "supported",
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
          customModels: context.instance
            ? getModelsForProviderInstance(context.instance)
            : undefined,
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
      modelDefaults: CHAT_MODEL_DEFAULTS,
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
        ...CHAT_TRANSPORT_DEFAULTS,
        [CHAT_INPUT_IMAGE]: "supported",
        [CHAT_NATIVE_WEB_SEARCH]: "supported",
        [CHAT_STRUCTURED_OUTPUT]: "supported",
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
          [CHAT_INPUT_IMAGE]: claim("unknown"),
          [CHAT_TOOL_USE]: claim("unknown"),
          [CHAT_STRUCTURED_OUTPUT]: claim("unknown"),
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
      discoverModels: discoverOpenRouterModels,
      displayName: "OpenRouter",
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]:
          openRouterAudioTranscriptionExecutor,
        [PROVIDER_CAPABILITY_IDS.imageGeneration]:
          openRouterImageGenerationExecutor,
      },
      modelDefaults: CHAT_MODEL_DEFAULTS,
      models: [
        ...modelsSupporting(PROVIDER_CAPABILITY_IDS.audioTranscription, [
          "openai/whisper-large-v3",
          "openai/whisper-1",
        ]),
        ...modelsSupporting(
          PROVIDER_CAPABILITY_IDS.imageGeneration,
          ["black-forest-labs/flux-1-schnell", "bytedance-seed/seedream-4.5"],
          ALL_IMAGE_SIZES
        ),
      ],
      native: {
        ...CHAT_TRANSPORT_DEFAULTS,
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
          customModels: context.instance?.customModels,
          model: context.model,
          providerInstanceId: context.instance?.id,
          providerReplayRevision: context.providerReplayRevision,
        }),
      discoverModels: discoverOpenCodeGoModels,
      displayName: "OpenCode Go",
      listConfiguredModels: getModelsForOpenCodeGoInstance,
      modelDefaults: CHAT_MODEL_DEFAULTS,
      native: {
        [CHAT_REASONING]: "supported",
        [CHAT_STREAMING]: "supported",
        [CHAT_STRUCTURED_OUTPUT]: "supported",
        [CHAT_TOOL_USE]: "supported",
      },
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
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]:
          ollamaAudioTranscriptionExecutor,
        [PROVIDER_CAPABILITY_IDS.imageGeneration]:
          ollamaImageGenerationExecutor,
      },
      missingCredentialMessage: (_instance, operation) =>
        operation === "connection-validation"
          ? "API key is required for Ollama Cloud mode."
          : "API key is required for Ollama Cloud.",
      modelDefaults: CHAT_MODEL_DEFAULTS,
      models: [
        ...modelsSupporting(
          PROVIDER_CAPABILITY_IDS.imageGeneration,
          ["x/z-image-turbo", "x/flux2-klein:4b"],
          ALL_IMAGE_SIZES
        ),
      ],
      native: {
        ...CHAT_TRANSPORT_DEFAULTS,
        [CHAT_INPUT_IMAGE]: "supported",
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported",
      },
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
      executors: {
        [PROVIDER_CAPABILITY_IDS.imageGeneration]:
          minimaxImageGenerationExecutor,
      },
      models: modelsSupporting(
        PROVIDER_CAPABILITY_IDS.imageGeneration,
        ["image-01", "image-01-live"],
        ALL_IMAGE_SIZES
      ),
      native: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: "unsupported",
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported",
      },
      providerId: "minimax",
    }),
    openAIStyleRegistration({
      displayName: "MiniMax (CN)",
      executors: {
        [PROVIDER_CAPABILITY_IDS.imageGeneration]:
          minimaxImageGenerationExecutor,
      },
      models: modelsSupporting(
        PROVIDER_CAPABILITY_IDS.imageGeneration,
        ["image-01", "image-01-live"],
        ALL_IMAGE_SIZES
      ),
      native: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: "unsupported",
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported",
      },
      providerId: "minimax_cn",
    }),
    openAIStyleRegistration({
      displayName: "xAI",
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]:
          xAIAudioTranscriptionExecutor,
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: xAIImageGenerationExecutor,
      },
      models: [
        ...modelsSupporting(PROVIDER_CAPABILITY_IDS.audioTranscription, [
          "grok-stt",
        ]),
        ...modelsSupporting(
          PROVIDER_CAPABILITY_IDS.imageGeneration,
          ["grok-imagine-image-2.0", "grok-2-image"],
          ALL_IMAGE_SIZES
        ),
      ],
      native: {
        [CHAT_INPUT_IMAGE]: "supported",
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: "supported",
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported",
      },
      providerId: "xai",
    }),
    openAIStyleRegistration({
      displayName: "Z.ai",
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]:
          zhipuAudioTranscriptionExecutor,
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: zhipuImageGenerationExecutor,
      },
      models: [
        ...modelsSupporting(PROVIDER_CAPABILITY_IDS.audioTranscription, [
          "glm-asr-2512",
        ]),
        ...modelsSupporting(
          PROVIDER_CAPABILITY_IDS.imageGeneration,
          ["glm-image", "cogview-4-250304"],
          ALL_IMAGE_SIZES
        ),
      ],
      native: {
        [CHAT_INPUT_IMAGE]: "supported",
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: "supported",
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: "supported",
      },
      providerId: "zhipu",
    }),
    openAIStyleRegistration({
      displayName: "GLM (CN)",
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]:
          zhipuCnAudioTranscriptionExecutor,
        [PROVIDER_CAPABILITY_IDS.imageGeneration]:
          zhipuCnImageGenerationExecutor,
      },
      models: [
        ...modelsSupporting(PROVIDER_CAPABILITY_IDS.audioTranscription, [
          "glm-asr-2512",
        ]),
        ...modelsSupporting(
          PROVIDER_CAPABILITY_IDS.imageGeneration,
          ["glm-image", "cogview-4-250304"],
          ALL_IMAGE_SIZES
        ),
      ],
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
    defaultReasoningEffort: context.instance?.customModels?.find(
      (model) => model.id === context.model
    )?.defaultReasoningEffort,
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
