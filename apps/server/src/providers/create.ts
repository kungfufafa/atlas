import {
  apiKeyEnvVarForProvider,
  getActiveProviderInstance,
  isOllamaCloudInstance,
  type ProviderClient,
  type ProviderInstance,
  type ProviderName,
  readEnvValue,
  type UserConfig,
} from "@atlas/core";
import { resolveDefaultModelForInstance } from "../services/provider-instance-helpers";
import { createAnthropicProvider } from "./anthropic";
import { createCerebrasProvider } from "./cerebras";
import {
  compatibleModelReasoningEffortValues,
  compatibleModelSupportsThinking,
} from "./compatible-models";
import { createFireworksProvider } from "./fireworks";
import { createGeminiProvider } from "./gemini";
import { createOllamaProvider } from "./ollama";
import { createOpenAIProvider } from "./openai";
import { createOpenAICompatibleProvider } from "./openai-compatible";
import { createOpenCodeGoProvider } from "./opencode-go";
import { createOpenRouterProvider } from "./openrouter";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export interface CreateProviderOptions {
  apiKey: string;
  instance?: ProviderInstance | null;
  model?: string;
  provider: ProviderName;
  supportsThinking?: boolean;
}

export function createProvider(options: CreateProviderOptions): ProviderClient {
  const model = options.model
    ? options.model
    : resolveDefaultModelForInstance(options.instance);
  const baseUrlOverride = options.instance?.baseUrl?.trim() || undefined;

  switch (options.provider) {
    case "anthropic":
      return createAnthropicProvider({
        apiKey: options.apiKey,
        baseUrl: baseUrlOverride,
        model,
      });
    case "cerebras":
      return createCerebrasProvider({
        apiKey: options.apiKey,
        baseUrl: baseUrlOverride,
        customModels: options.instance?.customModels,
        model,
      });
    case "deepseek":
      return createOpenAIProvider({
        apiKey: options.apiKey,
        baseUrl: baseUrlOverride ?? DEFAULT_DEEPSEEK_BASE_URL,
        model,
        providerLabel: "DeepSeek",
        providerName: "deepseek",
      });
    case "fireworks":
      return createFireworksProvider({
        apiKey: options.apiKey,
        baseUrl: baseUrlOverride,
        customModels: options.instance?.customModels,
        model,
      });
    case "gemini":
      return createGeminiProvider({
        apiKey: options.apiKey,
        baseUrl: baseUrlOverride,
        model,
      });
    case "openai":
      return createOpenAIProvider({
        apiKey: options.apiKey,
        baseUrl: baseUrlOverride,
        customModels: options.instance?.customModels,
        model,
      });
    case "openrouter":
      return createOpenRouterProvider({
        apiKey: options.apiKey,
        customModels: options.instance?.customModels,
        model,
      });
    case "opencode_go":
      return createOpenCodeGoProvider({
        apiKey: options.apiKey,
        baseUrl: baseUrlOverride,
        customModels: options.instance?.customModels,
        model,
      });
    case "ollama":
      return createOllamaProvider({
        apiKey: options.apiKey,
        instance: options.instance,
        model,
      });
    case "openai_compatible": {
      const displayName = options.instance?.label?.trim();

      if (!(baseUrlOverride && displayName)) {
        throw new Error(
          "OpenAI-compatible provider requires baseUrl and label."
        );
      }

      return createOpenAICompatibleProvider({
        apiKey: options.apiKey,
        baseUrl: baseUrlOverride,
        displayName,
        model,
        reasoningEffortValues: compatibleModelReasoningEffortValues(
          model,
          options.instance?.customModels,
          {
            baseUrl: baseUrlOverride,
            providerLabel: displayName,
          }
        ),
        supportsThinking: compatibleModelSupportsThinking(
          model,
          options.instance?.customModels
        ),
      });
    }
  }
}

export function readApiKeyForInstance(
  instance: ProviderInstance,
  env: Record<string, string | undefined>
): string | undefined {
  if (instance.apiKey.trim()) {
    return instance.apiKey;
  }

  const envVar = apiKeyEnvVarForProvider(instance.type);
  if (!envVar) {
    return;
  }

  return readEnvValue(env, envVar);
}

export function createProviderForInstance(
  instance: ProviderInstance,
  model: string,
  env: Record<string, string | undefined> = process.env
): ProviderClient | null {
  const apiKey = readApiKeyForInstance(instance, env);

  if (
    !apiKey?.trim() &&
    instance.type !== "openai_compatible" &&
    instance.type !== "ollama"
  ) {
    return null;
  }

  if (
    instance.type === "ollama" &&
    isOllamaCloudInstance(instance) &&
    !apiKey?.trim()
  ) {
    return null;
  }

  return createProvider({
    apiKey: apiKey ?? "",
    instance,
    model,
    provider: instance.type,
  });
}

export function createProviderFromActiveConfig(
  userConfig: UserConfig | null | undefined,
  env: Record<string, string | undefined> = process.env
): ProviderClient | null {
  const instance = getActiveProviderInstance(userConfig);

  if (!instance) {
    return null;
  }

  const model = resolveDefaultModelForInstance(instance);

  if (!model) {
    return null;
  }

  return createProviderForInstance(instance, model, env);
}

export function createProviderFromSources(
  env: Record<string, string | undefined> = process.env,
  userConfig?: UserConfig | null
): ProviderClient | null {
  return createProviderFromActiveConfig(userConfig, env);
}
