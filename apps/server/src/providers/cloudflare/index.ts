import {
  cloudflareBaseUrlFromAccountId,
  normalizeBaseUrl,
  type ProviderClient,
  type ProviderInstance,
} from "@atlas/core";
import { createOpenAICompatibleProvider } from "../openai-compatible";

export { CLOUDFLARE_API_ROOT } from "@atlas/core";

export function resolveCloudflareBaseUrl(
  accountId: string,
  instance?: ProviderInstance | null
): string {
  const configured = instance?.baseUrl?.trim();
  if (configured) {
    return normalizeBaseUrl(configured);
  }

  const trimmedAccountId = accountId.trim();
  if (!trimmedAccountId) {
    throw new Error(
      "Cloudflare provider requires an account ID saved on the provider or CLOUDFLARE_ACCOUNT_ID."
    );
  }

  return cloudflareBaseUrlFromAccountId(trimmedAccountId);
}

export function createCloudflareProvider(options: {
  accountId: string;
  apiKey: string;
  instance?: ProviderInstance | null;
  model: string;
  providerReplayRevision?: string;
}): ProviderClient {
  if (!options.apiKey.trim()) {
    throw new Error("Cloudflare provider requires an API key.");
  }

  return createOpenAICompatibleProvider({
    apiKey: options.apiKey,
    baseUrl: resolveCloudflareBaseUrl(options.accountId, options.instance),
    displayName: "Cloudflare Workers AI",
    model: options.model,
    providerInstanceId: options.instance?.id,
    providerName: "cloudflare",
    providerReplayRevision: options.providerReplayRevision,
    supportsThinking: false,
  });
}
