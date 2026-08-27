import type { ProviderName } from "./contract";
import { BUILTIN_PROVIDER_DEFINITIONS } from "./provider-catalog";

type DiscoveryDefinition = Extract<
  (typeof BUILTIN_PROVIDER_DEFINITIONS)[number],
  { discoveryModels: true }
>;
export type DiscoveryModelProvider = DiscoveryDefinition["id"];

/** Providers whose model catalog is read from their OpenAI-compatible `/models`. */
export const DISCOVERY_MODEL_PROVIDERS: ReadonlySet<DiscoveryModelProvider> =
  new Set(
    BUILTIN_PROVIDER_DEFINITIONS.filter(
      (definition): definition is DiscoveryDefinition =>
        "discoveryModels" in definition && definition.discoveryModels
    ).map((definition) => definition.id)
  );

/** Browser-safe defaults shared by setup UI, discovery, and provider creation. */
export const DISCOVERY_PROVIDER_BASE_URLS: Readonly<
  Partial<Record<ProviderName, string>>
> = Object.fromEntries(
  BUILTIN_PROVIDER_DEFINITIONS.flatMap((definition) =>
    "discoveryBaseUrl" in definition
      ? [[definition.id, definition.discoveryBaseUrl]]
      : []
  )
);

export function isDiscoveryModelProvider(
  provider: ProviderName
): provider is DiscoveryModelProvider {
  return DISCOVERY_MODEL_PROVIDERS.has(provider as DiscoveryModelProvider);
}

export function defaultDiscoveryBaseUrl(provider: ProviderName): string | null {
  return DISCOVERY_PROVIDER_BASE_URLS[provider] ?? null;
}
