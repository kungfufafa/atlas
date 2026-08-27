import { readEnvValue } from "./config";

import type { ProviderName } from "./contract";
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  getBuiltinProviderDefinition,
} from "./provider-catalog";

export type UserProviderName = ProviderName;

export const USER_PROVIDER_NAMES: readonly UserProviderName[] =
  BUILTIN_PROVIDER_DEFINITIONS.map((definition) => definition.id);

const USER_PROVIDER_NAME_SET = new Set<string>(USER_PROVIDER_NAMES);

export {
  DISCOVERY_MODEL_PROVIDERS,
  defaultDiscoveryBaseUrl,
  isDiscoveryModelProvider,
} from "./discovery-providers";

export function parseProviderName(
  value: string | undefined
): UserProviderName | null {
  const normalized = value?.trim().toLowerCase();

  return normalized && USER_PROVIDER_NAME_SET.has(normalized)
    ? (normalized as UserProviderName)
    : null;
}

export function apiKeyEnvVarForProvider(
  provider: UserProviderName
): string | null {
  return getBuiltinProviderDefinition(provider)?.apiKeyEnvVar ?? null;
}

export interface ResolveProviderOptions {
  configuredProvider?: string | undefined;
  env?: Record<string, string | undefined>;
}

export function resolveProvider(
  options: ResolveProviderOptions = {}
): UserProviderName | null {
  const env = options.env ?? process.env;

  const explicitEnvProvider = parseProviderName(
    readEnvValue(env, "ATLAS_PROVIDER")
  );

  if (explicitEnvProvider) {
    return explicitEnvProvider;
  }

  const explicitConfiguredProvider = parseProviderName(
    options.configuredProvider
  );

  if (explicitConfiguredProvider) {
    return explicitConfiguredProvider;
  }

  const providersWithEnvKeys = USER_PROVIDER_NAMES.filter((provider) => {
    const envVar = apiKeyEnvVarForProvider(provider);
    return envVar && readEnvValue(env, envVar);
  });

  if (providersWithEnvKeys.length === 1) {
    return providersWithEnvKeys[0]!;
  }

  return null;
}
