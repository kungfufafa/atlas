import { describe, expect, test } from "bun:test";
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  type BuiltinProviderDefinition,
  type ProviderApiKeyPolicy,
  type ProviderSetupMetadata,
  providerApiKeyIsRequired,
  providerSetupHasFeature,
  providerUsesGenericCustomModelSetup,
  validateProviderCustomModelId,
} from "./provider-catalog";

describe("provider API-key policy", () => {
  test("declares a placeholder and requirement policy for every provider", () => {
    for (const definition of BUILTIN_PROVIDER_DEFINITIONS) {
      const setup: ProviderSetupMetadata | undefined = definition.setup;
      expect(definition.apiKey.placeholder.length).toBeGreaterThan(0);
      expect(["conditional", "optional", "required"]).toContain(
        definition.apiKey.requirement
      );
      if (setup?.customModelsRequired || setup?.customModelIdPolicy) {
        expect(setup.customModels).toBe(true);
      }
    }
  });

  test("evaluates a synthetic optional policy without provider-specific logic", () => {
    const policy = {
      placeholder: "Optional synthetic token",
      requirement: "optional",
    } satisfies ProviderApiKeyPolicy;

    expect(providerApiKeyIsRequired(policy)).toBe(false);
  });

  test("evaluates conditional policies from declarative setup values", () => {
    const policy = {
      placeholder: "Token",
      requiredWhen: { equals: "remote", field: "connectionMode" },
      requirement: "conditional",
    } satisfies ProviderApiKeyPolicy;

    expect(providerApiKeyIsRequired(policy, { connectionMode: "local" })).toBe(
      false
    );
    expect(providerApiKeyIsRequired(policy, { connectionMode: "remote" })).toBe(
      true
    );
  });

  test("recognizes setup fields on a synthetic provider without an id branch", () => {
    const synthetic = {
      apiKey: { placeholder: "Token", requirement: "required" },
      apiKeyEnvVar: "SYNTHETIC_API_KEY",
      displayName: "Synthetic",
      fallbackModelId: "synthetic-1",
      id: "synthetic",
      setup: { customModels: true },
    } satisfies BuiltinProviderDefinition;

    expect(providerSetupHasFeature(synthetic, "customModels")).toBe(true);
    expect(providerSetupHasFeature(synthetic, "wireApi")).toBe(false);
    expect(providerUsesGenericCustomModelSetup(synthetic)).toBe(true);
  });

  test("validates custom model ids through declarative patterns", () => {
    expect(validateProviderCustomModelId("openrouter", "vendor/model")).toBe(
      null
    );
    expect(validateProviderCustomModelId("openrouter", "model-only")).toBe(
      'Invalid OpenRouter model id "model-only". Use vendor/model format.'
    );
  });
});
