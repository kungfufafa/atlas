import type { DiscoverModelsRequest } from "@atlas/core/contract";

export type RemoteModelBrowseProvider = Exclude<
  DiscoverModelsRequest["provider"],
  "fireworks" | "opencode_go" | undefined
>;

export function advanceCredentialRevision(options: {
  currentCredential: string;
  nextCredential: string;
  revision: number;
}): number {
  return options.currentCredential === options.nextCredential
    ? options.revision
    : options.revision + 1;
}

export function resolveRemoteModelBrowseReadiness(options: {
  apiKey?: string;
  baseUrl?: string;
  provider?: RemoteModelBrowseProvider;
  providerId?: string;
}): { canFetch: boolean; idleMessage: string } {
  const hasStoredProvider = Boolean(options.providerId?.trim());
  const directProviderRequiresApiKey =
    !hasStoredProvider &&
    options.provider !== undefined &&
    options.provider !== "ollama" &&
    options.provider !== "openai_compatible";
  const canFetch = Boolean(
    hasStoredProvider ||
      (options.baseUrl?.trim() &&
        (!directProviderRequiresApiKey || Boolean(options.apiKey?.trim())))
  );
  const idleMessage =
    directProviderRequiresApiKey && !options.apiKey?.trim()
      ? "Enter an API key before browsing models."
      : "Enter a base URL before browsing models.";

  return { canFetch, idleMessage };
}
