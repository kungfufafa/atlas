import { describe, expect, test } from "bun:test";
import {
  type CapabilityConfigV1,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityManifestV1,
  type ProviderInstance,
} from "@atlas/core";
import { ProviderCapabilityError } from "./errors";
import { ProviderAdapterRegistry } from "./registry";
import { resolveCapabilityRoute } from "./resolver";

const manifest = (
  id: string,
  implementation: "available" | "unavailable" = "available"
): ProviderCapabilityManifestV1 => ({
  adapterApiVersion: 1,
  capabilities: {
    [PROVIDER_CAPABILITY_IDS.audioTranscription]: {
      contractVersion: 1,
      implementation: { status: implementation },
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
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: {
          source: "static-manifest",
          status: "supported",
          verified: true,
        },
      },
      id: "asr-model",
    },
  ],
  provider: { displayName: id, id },
  schemaVersion: 1,
});

const context = {
  apiKey: "secret",
  instance: {
    apiKey: "secret",
    createdAt: "2026-08-27T00:00:00.000Z",
    id: "provider-a",
    label: "Example",
    type: "openai" as const,
  },
  model: "asr-model",
};

describe("ProviderAdapterRegistry", () => {
  test("discovers an adapter-defined capability and its control-plane metadata", () => {
    const customCapabilityId = "vendor.custom-operation";
    const registry = new ProviderAdapterRegistry();
    registry.register({
      executors: {
        [customCapabilityId]: async () => "ok",
      },
      manifest: {
        adapterApiVersion: 1,
        capabilities: {
          [customCapabilityId]: {
            contractVersion: 1,
            implementation: { status: "available" },
            metadata: {
              description: "Run a vendor-defined operation.",
              label: "Vendor operation",
              routable: true,
            },
            modelDefault: {
              source: "static-manifest",
              status: "supported",
              verified: true,
            },
            native: {
              source: "static-manifest",
              status: "supported",
              verified: true,
            },
          },
        },
        manifestRevision: "test",
        provider: { displayName: "Synthetic", id: "synthetic" },
        schemaVersion: 1,
      },
    });

    expect(registry.listCapabilityDefinitions()).toEqual([
      {
        description: "Run a vendor-defined operation.",
        id: customCapabilityId,
        label: "Vendor operation",
        routable: true,
      },
    ]);
  });

  test("registers and executes a synthetic adapter without core changes", async () => {
    const registry = new ProviderAdapterRegistry();
    registry.register({
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: async (_context, input) =>
          `transcribed:${String(input)}`,
      },
      manifest: manifest("openai"),
    });

    const effective = registry.resolveModelCapability({
      capabilityId: PROVIDER_CAPABILITY_IDS.audioTranscription,
      credentialsAvailable: true,
      modelId: "asr-model",
      providerType: "openai",
    });

    expect(effective.selectable).toBe(true);
    await expect(
      registry.execute(
        PROVIDER_CAPABILITY_IDS.audioTranscription,
        context,
        "audio"
      )
    ).resolves.toBe("transcribed:audio");
  });

  test("lets a synthetic adapter own optional credentials and its error message", () => {
    const registry = new ProviderAdapterRegistry();
    registry.register({
      credentialsRequired: () => false,
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: async () => "ok",
      },
      manifest: manifest("synthetic-optional"),
      missingCredentialMessage: () => "Synthetic credential is required.",
    });
    const instance = {
      ...context.instance,
      apiKey: "",
      type: "synthetic-optional",
    } as unknown as ProviderInstance;

    expect(registry.credentialsAreAvailable(instance, "")).toBe(true);
    expect(registry.missingCredentialMessage(instance)).toBe(
      "Synthetic credential is required."
    );
  });

  test("lets an adapter own dynamic configured-model loading", async () => {
    const registry = new ProviderAdapterRegistry();
    registry.register({
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: async () => "ok",
      },
      listConfiguredModels: async () => [
        {
          id: "dynamic-model",
          name: "Dynamic model",
          provider: "openai",
        },
      ],
      manifest: manifest("openai"),
    });
    let usedFallback = false;

    await expect(
      registry.listModelsForInstance(context.instance, () => {
        usedFallback = true;
        return [];
      })
    ).resolves.toEqual([
      {
        id: "dynamic-model",
        name: "Dynamic model",
        provider: "openai",
      },
    ]);
    expect(usedFallback).toBe(false);
  });

  test("rejects duplicate adapters and manifest-handler mismatches", () => {
    const registry = new ProviderAdapterRegistry();
    registry.register({
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: async () => "ok",
      },
      manifest: manifest("openai"),
    });
    expect(() =>
      registry.register({
        executors: {
          [PROVIDER_CAPABILITY_IDS.audioTranscription]: async () => "ok",
        },
        manifest: manifest("openai"),
      })
    ).toThrow('Provider adapter "openai" is already registered.');

    expect(() =>
      new ProviderAdapterRegistry().register({
        manifest: manifest("missing-handler"),
      })
    ).toThrow(
      'Provider adapter "missing-handler" marks "audio.transcription" available without a handler.'
    );
  });

  test("rejects future manifest and adapter API versions", () => {
    const futureSchemaManifest = {
      ...manifest("future-schema"),
      schemaVersion: 99,
    } as unknown as ProviderCapabilityManifestV1;
    expect(() =>
      new ProviderAdapterRegistry().register({
        executors: {
          [PROVIDER_CAPABILITY_IDS.audioTranscription]: async () => "ok",
        },
        manifest: futureSchemaManifest,
      })
    ).toThrow(
      "provider capability manifest schema version 99 is not supported."
    );

    const futureAdapterManifest = {
      ...manifest("future-adapter"),
      adapterApiVersion: 99,
    } as unknown as ProviderCapabilityManifestV1;
    expect(() =>
      new ProviderAdapterRegistry().register({
        executors: {
          [PROVIDER_CAPABILITY_IDS.audioTranscription]: async () => "ok",
        },
        manifest: futureAdapterManifest,
      })
    ).toThrow("provider adapter API version 99 is not supported.");
  });

  test("keeps unknown claims unselectable even with an executor", () => {
    const registry = new ProviderAdapterRegistry();
    registry.register({
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: async () => "ok",
      },
      manifest: {
        ...manifest("openai"),
        capabilities: {
          [PROVIDER_CAPABILITY_IDS.audioTranscription]: {
            contractVersion: 1,
            implementation: { status: "available" },
            modelDefault: {
              source: "static-manifest",
              status: "unknown",
              verified: false,
            },
            native: {
              source: "static-manifest",
              status: "unknown",
              verified: false,
            },
          },
        },
        models: [],
      },
    });

    const effective = registry.resolveModelCapability({
      capabilityId: PROVIDER_CAPABILITY_IDS.audioTranscription,
      credentialsAvailable: true,
      modelId: "undiscovered",
      providerType: "openai",
    });

    expect(effective.selectable).toBe(false);
    expect(effective.reasons).toEqual(["model-unknown"]);
  });
});

describe("resolveCapabilityRoute", () => {
  const config: CapabilityConfigV1 = {
    bindings: {
      [PROVIDER_CAPABILITY_IDS.audioTranscription]: {
        contractVersion: 1,
        enabled: true,
        fallbacks: [{ modelId: "asr-model", providerId: "provider-b" }],
        mode: "manual",
        primary: { modelId: "asr-model", providerId: "provider-a" },
      },
    },
    schemaVersion: 1,
  };

  test("uses only the explicit ordered fallback list", () => {
    const route = resolveCapabilityRoute({
      capabilityId: PROVIDER_CAPABILITY_IDS.audioTranscription,
      config,
      evaluate: (target) => ({
        availability:
          target.providerId === "provider-b" ? "ready" : "credentials-missing",
        capabilityId: PROVIDER_CAPABILITY_IDS.audioTranscription,
        claim: {
          source: "static-manifest",
          status: "supported",
          verified: true,
        },
        reasons:
          target.providerId === "provider-b" ? [] : ["credentials-missing"],
        selectable: target.providerId === "provider-b",
      }),
    });

    expect(route.target.providerId).toBe("provider-b");
    expect(route.fallbackIndex).toBe(1);
    expect(route.trace).toHaveLength(2);
  });

  test("returns structured failure when every configured target is unavailable", () => {
    try {
      resolveCapabilityRoute({
        capabilityId: PROVIDER_CAPABILITY_IDS.audioTranscription,
        config,
        evaluate: () => ({
          availability: "ready",
          capabilityId: PROVIDER_CAPABILITY_IDS.audioTranscription,
          claim: {
            source: "static-manifest",
            status: "unknown",
            verified: false,
          },
          reasons: ["model-unknown"],
          selectable: false,
        }),
      });
      throw new Error("expected capability resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCapabilityError);
      expect((error as ProviderCapabilityError).code).toBe(
        "CAPABILITY_UNKNOWN"
      );
      expect((error as ProviderCapabilityError).attempts).toHaveLength(2);
    }
  });

  test("rejects an unsupported binding contract before routing", () => {
    const futureBindingConfig = {
      ...config,
      bindings: {
        ...config.bindings,
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: {
          ...config.bindings[PROVIDER_CAPABILITY_IDS.audioTranscription],
          contractVersion: 42,
        },
      },
    } as unknown as CapabilityConfigV1;

    expect(() =>
      resolveCapabilityRoute({
        capabilityId: PROVIDER_CAPABILITY_IDS.audioTranscription,
        config: futureBindingConfig,
        evaluate: () => {
          throw new Error("routing should not evaluate an unsupported binding");
        },
      })
    ).toThrow(
      "capability config.bindings.audio.transcription.contractVersion version 42 is not supported."
    );
  });
});
