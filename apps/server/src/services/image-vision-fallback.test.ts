import { describe, expect, test } from "bun:test";
import {
  type GenerateChatInput,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityClaim,
  type ProviderCapabilityManifestV1,
  type ProviderClient,
  type UserConfig,
} from "@atlas/core";
import { ProviderCapabilityError } from "../providers/capabilities";
import { createVisionUnderstandingExecutor } from "../providers/capabilities/executors/vision-understanding";
import { ProviderAdapterRegistry } from "../providers/capabilities/registry";
import {
  describeImagesWithConfiguredVisionModel,
  resolvePrimaryModelVisionSupport,
  resolveVisionProviderSelection,
} from "./image-vision-fallback";

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const supportedClaim = claim("supported");
const unsupportedClaim = claim("unsupported");
const unknownClaim = claim("unknown");

function claim(
  status: ProviderCapabilityClaim["status"]
): ProviderCapabilityClaim {
  return {
    source: "static-manifest",
    status,
    verified: status !== "unknown",
  };
}

function createRegistry(
  descriptions: string[] = ["A single red pixel."]
): ProviderAdapterRegistry {
  const manifest: ProviderCapabilityManifestV1 = {
    adapterApiVersion: 1,
    capabilities: {
      [PROVIDER_CAPABILITY_IDS.chatInputImage]: {
        contractVersion: 1,
        implementation: { status: "available" },
        modelDefault: unknownClaim,
        native: supportedClaim,
      },
      [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: {
        contractVersion: 1,
        implementation: { status: "available" },
        modelDefault: unknownClaim,
        native: supportedClaim,
      },
    },
    manifestRevision: "vision-test",
    models: [
      modelManifest("vision-model", supportedClaim),
      modelManifest("text-only", unsupportedClaim),
      modelManifest("unknown-model", unknownClaim),
    ],
    provider: { displayName: "Synthetic vision", id: "openai" },
    schemaVersion: 1,
  };
  const provider = providerWithResponses(descriptions);
  const registry = new ProviderAdapterRegistry();
  registry.register({
    executors: {
      [PROVIDER_CAPABILITY_IDS.chatInputImage]: async () => undefined,
      [PROVIDER_CAPABILITY_IDS.imageUnderstanding]:
        createVisionUnderstandingExecutor(() => provider),
    },
    manifest,
  });
  return registry;
}

function modelManifest(id: string, capability: ProviderCapabilityClaim) {
  return {
    capabilities: {
      [PROVIDER_CAPABILITY_IDS.chatInputImage]: capability,
      [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: capability,
    },
    id,
  };
}

function providerWithResponses(responses: string[]): ProviderClient {
  let index = 0;
  return {
    async generateChat(_input: GenerateChatInput) {
      const content = responses[index] ?? "";
      index += 1;
      return {
        assistantMessage: { content, role: "assistant" },
        content,
        toolCalls: [],
      };
    },
    async generateText() {
      return { content: "unused" };
    },
    name: "openai",
    async streamChat(input, handlers) {
      const result = await this.generateChat(input);
      handlers.onChunk(result.content);
      return result;
    },
  };
}

function provider(id: string, apiKey = "key") {
  return {
    apiKey,
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    label: id,
    type: "openai" as const,
  };
}

describe("resolveVisionProviderSelection", () => {
  test("returns null when image understanding is not configured", () => {
    expect(
      resolveVisionProviderSelection(
        { defaultProviderId: null, providers: [] },
        { registry: createRegistry() }
      )
    ).toBeNull();
  });

  test("resolves a configured capable model through the registry", () => {
    const config: UserConfig = {
      defaultProviderId: "provider-vision",
      providers: [provider("provider-vision")],
      visionModel: "provider-vision::vision-model",
    };

    const resolved = resolveVisionProviderSelection(config, {
      registry: createRegistry(),
    });
    expect(resolved?.model).toBe("vision-model");
    expect(resolved?.instance.id).toBe("provider-vision");
  });

  test("rejects an invalid legacy selection explicitly", () => {
    expect(() =>
      resolveVisionProviderSelection(
        {
          defaultProviderId: "provider-vision",
          providers: [provider("provider-vision")],
          visionModel: "invalid-selection",
        },
        { registry: createRegistry() }
      )
    ).toThrow(
      "Configured image parsing model is invalid. Update it in Settings → Capability mappings."
    );
  });

  test("uses only the explicitly configured fallback when primary is unsupported", () => {
    const config: UserConfig = {
      capabilityConfig: {
        bindings: {
          [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: {
            contractVersion: 1,
            enabled: true,
            fallbacks: [
              { modelId: "vision-model", providerId: "provider-fallback" },
            ],
            mode: "manual",
            primary: {
              modelId: "text-only",
              providerId: "provider-primary",
            },
          },
        },
        schemaVersion: 1,
      },
      defaultProviderId: "provider-primary",
      providers: [provider("provider-primary"), provider("provider-fallback")],
    };

    const resolved = resolveVisionProviderSelection(config, {
      registry: createRegistry(),
    });
    expect(resolved).toEqual({
      instance: provider("provider-fallback"),
      model: "vision-model",
    });
  });

  test("reports unknown support instead of silently selecting the model", () => {
    const config: UserConfig = {
      defaultProviderId: "provider-vision",
      providers: [provider("provider-vision")],
      visionModel: "provider-vision::unknown-model",
    };

    try {
      resolveVisionProviderSelection(config, { registry: createRegistry() });
      throw new Error("expected image parsing resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCapabilityError);
      expect((error as ProviderCapabilityError).code).toBe(
        "CAPABILITY_UNKNOWN"
      );
      expect((error as ProviderCapabilityError).attempts).toEqual([
        {
          modelId: "unknown-model",
          providerId: "provider-vision",
          reasons: ["model-unknown"],
        },
      ]);
    }
  });

  test("reports every unavailable route when no fallback can run", () => {
    const config: UserConfig = {
      capabilityConfig: {
        bindings: {
          [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: {
            contractVersion: 1,
            enabled: true,
            fallbacks: [
              { modelId: "text-only", providerId: "provider-fallback" },
            ],
            mode: "manual",
            primary: {
              modelId: "text-only",
              providerId: "provider-primary",
            },
          },
        },
        schemaVersion: 1,
      },
      defaultProviderId: "provider-primary",
      providers: [provider("provider-primary"), provider("provider-fallback")],
    };

    try {
      resolveVisionProviderSelection(config, { registry: createRegistry() });
      throw new Error("expected every image parsing route to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCapabilityError);
      expect((error as ProviderCapabilityError).code).toBe(
        "CAPABILITY_UNSUPPORTED"
      );
      expect((error as ProviderCapabilityError).attempts).toEqual([
        {
          modelId: "text-only",
          providerId: "provider-primary",
          reasons: ["model-unsupported"],
        },
        {
          modelId: "text-only",
          providerId: "provider-fallback",
          reasons: ["model-unsupported"],
        },
      ]);
    }
  });
});

describe("resolvePrimaryModelVisionSupport", () => {
  test("uses model capability claims rather than provider-name branches", () => {
    const config: UserConfig = {
      defaultProviderId: "provider-vision",
      providers: [provider("provider-vision")],
    };
    const registry = createRegistry();

    expect(
      resolvePrimaryModelVisionSupport(
        config,
        "provider-vision::vision-model",
        registry
      )
    ).toBe(true);
    expect(
      resolvePrimaryModelVisionSupport(
        config,
        "provider-vision::text-only",
        registry
      )
    ).toBe(false);
    expect(
      resolvePrimaryModelVisionSupport(
        config,
        "provider-vision::unknown-model",
        registry
      )
    ).toBe(false);
  });

  test("requires instance evidence rather than inheriting static gateway vision metadata", () => {
    const config: UserConfig = {
      defaultProviderId: "fireworks-static",
      providers: [
        {
          apiKey: "fireworks-key",
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "fireworks-static",
          label: "Fireworks",
          type: "fireworks",
        },
      ],
    };

    expect(
      resolvePrimaryModelVisionSupport(
        config,
        "fireworks-static::accounts/fireworks/models/kimi-k2p5"
      )
    ).toBe(false);
    config.providers[0]!.customModels = [
      { id: "accounts/fireworks/models/kimi-k2p5", supportsVision: true },
      { id: "accounts/fireworks/models/kimi-k2p6" },
    ];
    expect(
      resolvePrimaryModelVisionSupport(
        config,
        "fireworks-static::accounts/fireworks/models/kimi-k2p5"
      )
    ).toBe(true);
    expect(
      resolvePrimaryModelVisionSupport(
        config,
        "fireworks-static::accounts/fireworks/models/kimi-k2p6"
      )
    ).toBe(false);

    config.providers[0]!.customModels = [
      { id: "accounts/fireworks/models/kimi-k2p5", supportsVision: false },
    ];
    expect(
      resolvePrimaryModelVisionSupport(
        config,
        "fireworks-static::accounts/fireworks/models/kimi-k2p5"
      )
    ).toBe(false);
  });
});

describe("describeImagesWithConfiguredVisionModel", () => {
  test("traverses capability routing and the registered vision executor", async () => {
    const config: UserConfig = {
      defaultProviderId: "provider-vision",
      providers: [provider("provider-vision")],
      visionModel: "provider-vision::vision-model",
    };

    await expect(
      describeImagesWithConfiguredVisionModel(
        config,
        [{ data: tinyPngBase64, mediaType: "image/png", type: "image" }],
        { registry: createRegistry(["A tiny red square."]) }
      )
    ).resolves.toEqual(["A tiny red square."]);
  });
});
