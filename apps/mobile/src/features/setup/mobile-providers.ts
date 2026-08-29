import type { BuiltinProviderDefinition } from "@atlas/core/provider-catalog";
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  isSubscriptionProvider,
} from "@atlas/core/provider-catalog";

export function isSimpleApiKeyProvider(
  definition: BuiltinProviderDefinition
): boolean {
  if (isSubscriptionProvider(definition.id)) {
    return false;
  }
  if (definition.apiKey.requirement !== "required") {
    return false;
  }
  if (definition.setup?.hostMode) {
    return false;
  }
  if (definition.setup?.baseUrlRequired) {
    return false;
  }
  if (definition.setup?.baseUrlInput) {
    return false;
  }
  if (definition.setup?.customModelsRequired) {
    return false;
  }

  return true;
}

export function mobileSetupProviders(): BuiltinProviderDefinition[] {
  return BUILTIN_PROVIDER_DEFINITIONS.filter(isSimpleApiKeyProvider);
}
