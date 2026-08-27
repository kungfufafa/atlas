import { describe, expect, test } from "bun:test";
import {
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityManifestV1,
  type UserConfig,
} from "@atlas/core";
import { ProviderCapabilityError } from "./errors";
import { ProviderAdapterRegistry } from "./registry";
import {
  executeConfiguredCapability,
  resolveConfiguredCapability,
} from "./runtime";

const capabilityId = PROVIDER_CAPABILITY_IDS.audioTranscription;

function createRegistry(): ProviderAdapterRegistry {
  const manifest: ProviderCapabilityManifestV1 = {
    adapterApiVersion: 1,
    capabilities: {
      [capabilityId]: {
        contractVersion: 1,
        implementation: { status: "available" },
        modelDefault: {
          source: "static-manifest",
          status: "unknown",
          verified: false,
        },
        native: {
          source: "static-manifest",
          status: "supported",
          verified: true,
        },
      },
    },
    manifestRevision: "test",
    models: [
      {
        capabilities: {
          [capabilityId]: {
            source: "static-manifest",
            status: "supported",
            verified: true,
          },
        },
        id: "asr",
      },
    ],
    provider: { displayName: "Synthetic", id: "openai" },
    schemaVersion: 1,
  };
  const registry = new ProviderAdapterRegistry();
  registry.register({
    executors: {
      [capabilityId]: async (_context, input) => ({ input, text: "hello" }),
    },
    manifest,
  });
  return registry;
}

function createCredentialOptionalRegistry(): ProviderAdapterRegistry {
  const registry = createRegistry();
  const adapter = registry.get("openai");
  if (!adapter) {
    throw new Error("synthetic adapter is missing");
  }
  const optionalRegistry = new ProviderAdapterRegistry();
  optionalRegistry.register({
    ...adapter,
    credentialsRequired: () => false,
  });
  return optionalRegistry;
}

function createConfig(): UserConfig {
  return {
    capabilityConfig: {
      bindings: {
        [capabilityId]: {
          contractVersion: 1,
          enabled: true,
          fallbacks: [],
          mode: "manual",
          primary: { modelId: "asr", providerId: "provider-1" },
        },
      },
      schemaVersion: 1,
    },
    defaultProviderId: "provider-1",
    providers: [
      {
        apiKey: "key",
        createdAt: "2026-08-27T00:00:00.000Z",
        id: "provider-1",
        label: "Synthetic",
        type: "openai",
      },
    ],
  };
}

describe("configured capability runtime", () => {
  test("resolves by provider instance id and executes through the registry", async () => {
    const config = createConfig();
    const registry = createRegistry();
    const result = await executeConfiguredCapability<{
      input: string;
      text: string;
    }>({
      capabilityId,
      config,
      input: "audio-bytes",
      readApiKey: (instance) => instance.apiKey,
      registry,
    });

    expect(result.selection.instance.id).toBe("provider-1");
    expect(result.output).toEqual({ input: "audio-bytes", text: "hello" });
  });

  test("does not reroute a missing instance by provider type or array order", () => {
    const config = createConfig();
    config.capabilityConfig!.bindings[capabilityId]!.primary = {
      modelId: "asr",
      providerId: "deleted-provider",
    };

    try {
      resolveConfiguredCapability({
        capabilityId,
        config,
        readApiKey: (instance) => instance.apiKey,
        registry: createRegistry(),
      });
      throw new Error("expected capability resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCapabilityError);
      expect((error as ProviderCapabilityError).attempts[0]?.reasons).toEqual([
        "provider-instance-missing",
      ]);
    }
  });

  test("requires explicit admin evidence for a custom unknown model", () => {
    const config = createConfig();
    config.capabilityConfig!.bindings[capabilityId]!.primary!.modelId =
      "custom-asr";

    expect(() =>
      resolveConfiguredCapability({
        capabilityId,
        config,
        readApiKey: (instance) => instance.apiKey,
        registry: createRegistry(),
      })
    ).toThrow('No configured model can run capability "audio.transcription".');

    config.providers[0]!.customModels = [
      {
        capabilities: {
          [capabilityId]: {
            source: "admin-override",
            status: "supported",
            verified: false,
          },
        },
        id: "custom-asr",
      },
    ];

    expect(
      resolveConfiguredCapability({
        capabilityId,
        config,
        readApiKey: (instance) => instance.apiKey,
        registry: createRegistry(),
      }).model
    ).toBe("custom-asr");
  });

  test("allows credential-free execution only when the adapter declares it", () => {
    const config = createConfig();
    config.providers[0]!.apiKey = "";

    expect(
      resolveConfiguredCapability({
        capabilityId,
        config,
        readApiKey: () => undefined,
        registry: createCredentialOptionalRegistry(),
      }).apiKey
    ).toBe("");
  });

  test("rejects an unsupported binding contract before runtime resolution", () => {
    const config = createConfig();
    const binding = config.capabilityConfig?.bindings[capabilityId];
    if (!binding) {
      throw new Error("test capability binding is missing");
    }
    config.capabilityConfig = {
      bindings: {
        [capabilityId]: {
          ...binding,
          contractVersion: 42,
        },
      },
      schemaVersion: 1,
    } as unknown as UserConfig["capabilityConfig"];

    expect(() =>
      resolveConfiguredCapability({
        capabilityId,
        config,
        readApiKey: (instance) => instance.apiKey,
        registry: createRegistry(),
      })
    ).toThrow(
      "capability config.bindings.audio.transcription.contractVersion version 42 is not supported."
    );
  });
});
