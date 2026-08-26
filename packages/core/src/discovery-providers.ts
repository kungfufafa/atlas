import type { ProviderName } from "./contract";

export type DiscoveryModelProvider = Extract<
  ProviderName,
  "openai_compatible" | "minimax" | "minimax_cn" | "xai" | "zhipu" | "zhipu_cn"
>;

/** Providers whose model catalog is read from their OpenAI-compatible `/models`. */
export const DISCOVERY_MODEL_PROVIDERS: ReadonlySet<DiscoveryModelProvider> =
  new Set([
    "openai_compatible",
    "minimax",
    "minimax_cn",
    "xai",
    "zhipu",
    "zhipu_cn",
  ]);

/** Browser-safe defaults shared by setup UI, discovery, and provider creation. */
export const DISCOVERY_PROVIDER_BASE_URLS: Readonly<
  Partial<Record<ProviderName, string>>
> = {
  minimax: "https://api.minimax.io/v1",
  minimax_cn: "https://api.minimaxi.com/v1",
  xai: "https://api.x.ai/v1",
  zhipu: "https://api.z.ai/api/paas/v4",
  zhipu_cn: "https://open.bigmodel.cn/api/paas/v4",
};

export function isDiscoveryModelProvider(
  provider: ProviderName
): provider is DiscoveryModelProvider {
  return DISCOVERY_MODEL_PROVIDERS.has(provider as DiscoveryModelProvider);
}

export function defaultDiscoveryBaseUrl(provider: ProviderName): string | null {
  return DISCOVERY_PROVIDER_BASE_URLS[provider] ?? null;
}
