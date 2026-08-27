import { createHmac, randomBytes } from "node:crypto";
import {
  apiKeyEnvVarForProvider,
  getActiveProviderInstance,
  type ProviderClient,
  type ProviderInstance,
  type ProviderName,
  readEnvValue,
  type UserConfig,
} from "@atlas/core";
import { resolveDefaultModelForInstance } from "../services/provider-instance-helpers";
import { builtinProviderAdapterRegistry } from "./capabilities/builtin-adapters";
import type { ProviderAdapterRegistry } from "./capabilities/registry";

const PROCESS_PROVIDER_REPLAY_REVISION = crypto.randomUUID();
const PROCESS_PROVIDER_REPLAY_SECRET = randomBytes(32);

function replayRevisionForUntrackedCredential(apiKey: string): string {
  return createHmac("sha256", PROCESS_PROVIDER_REPLAY_SECRET)
    .update(apiKey)
    .digest("base64url");
}

export interface CreateProviderOptions {
  apiKey: string;
  cloudflareAccountId?: string;
  instance?: ProviderInstance | null;
  model?: string;
  provider: ProviderName;
  supportsThinking?: boolean;
}

export function createProvider(
  options: CreateProviderOptions,
  registry: ProviderAdapterRegistry = builtinProviderAdapterRegistry
): ProviderClient {
  const model = options.model
    ? options.model
    : resolveDefaultModelForInstance(options.instance);
  const cloudflareAccountId =
    options.cloudflareAccountId ??
    readEnvValue(process.env, "CLOUDFLARE_ACCOUNT_ID") ??
    "";
  const usesUntrackedCredential = Boolean(
    options.instance && !options.instance.apiKey.trim() && options.apiKey.trim()
  );
  const configuredReplayRevision =
    options.instance?.replayRevision ??
    (options.instance
      ? `legacy:${options.instance.id}:${options.instance.createdAt}`
      : PROCESS_PROVIDER_REPLAY_REVISION);
  const providerReplayRevision = usesUntrackedCredential
    ? `${configuredReplayRevision}:${PROCESS_PROVIDER_REPLAY_REVISION}:${replayRevisionForUntrackedCredential(options.apiKey)}`
    : configuredReplayRevision;

  const adapter = registry.require(options.provider);
  if (!adapter.createChatClient) {
    throw new Error(
      `Provider adapter "${options.provider}" does not implement chat completion.`
    );
  }
  return adapter.createChatClient({
    apiKey: options.apiKey,
    cloudflareAccountId,
    instance: options.instance ?? null,
    model,
    providerReplayRevision,
    supportsThinking: options.supportsThinking,
  });
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
  env: Record<string, string | undefined> = process.env,
  registry: ProviderAdapterRegistry = builtinProviderAdapterRegistry
): ProviderClient | null {
  const apiKey = readApiKeyForInstance(instance, env);
  if (!registry.credentialsAreAvailable(instance, apiKey)) {
    return null;
  }

  return createProvider(
    {
      apiKey: apiKey ?? "",
      cloudflareAccountId: readEnvValue(env, "CLOUDFLARE_ACCOUNT_ID"),
      instance,
      model,
      provider: instance.type,
    },
    registry
  );
}

export function createProviderFromActiveConfig(
  userConfig: UserConfig | null | undefined,
  env: Record<string, string | undefined> = process.env,
  registry: ProviderAdapterRegistry = builtinProviderAdapterRegistry
): ProviderClient | null {
  const instance = getActiveProviderInstance(userConfig);

  if (!instance) {
    return null;
  }

  const model = resolveDefaultModelForInstance(instance);

  if (!model) {
    return null;
  }

  return createProviderForInstance(instance, model, env, registry);
}

export function createProviderFromSources(
  env: Record<string, string | undefined> = process.env,
  userConfig?: UserConfig | null,
  registry: ProviderAdapterRegistry = builtinProviderAdapterRegistry
): ProviderClient | null {
  return createProviderFromActiveConfig(userConfig, env, registry);
}
