import { describe, expect, test } from "bun:test";
import {
  migrateCapabilityTargetProviderIds,
  migrateLegacyCapabilityConfig,
  PROVIDER_CAPABILITY_IDS,
  resolveCapabilityClaim,
  resolveCapabilityClaimsBySource,
  setCapabilityPrimaryTarget,
  validateCapabilityConfig,
  validateProviderCapabilityManifest,
} from "./provider-capabilities";

const supportedClaim = {
  source: "static-manifest",
  status: "supported",
  verified: true,
} as const;

describe("provider capability manifest", () => {
  test("accepts an extensible capability id and model claims", () => {
    const manifest = validateProviderCapabilityManifest({
      adapterApiVersion: 1,
      capabilities: {
        "vendor.custom-operation": {
          contractVersion: 1,
          implementation: { status: "available" },
          metadata: {
            description: "Run a vendor-defined operation.",
            label: "Vendor operation",
            routable: true,
          },
          modelDefault: supportedClaim,
          native: supportedClaim,
        },
      },
      manifestRevision: "2026-08-27",
      models: [
        {
          capabilities: {
            "vendor.custom-operation": supportedClaim,
          },
          id: "custom-model",
        },
      ],
      provider: { displayName: "Example", id: "example" },
      schemaVersion: 1,
    });

    expect(
      manifest.capabilities["vendor.custom-operation"]?.contractVersion
    ).toBe(1);
    expect(manifest.capabilities["vendor.custom-operation"]?.metadata).toEqual({
      description: "Run a vendor-defined operation.",
      label: "Vendor operation",
      routable: true,
    });
    expect(
      manifest.models?.[0]?.capabilities["vendor.custom-operation"]?.status
    ).toBe("supported");
  });

  test("rejects future schema and adapter API versions", () => {
    expect(() =>
      validateProviderCapabilityManifest({
        adapterApiVersion: 1,
        capabilities: {},
        manifestRevision: "1",
        provider: { displayName: "Example", id: "example" },
        schemaVersion: 2,
      })
    ).toThrow(
      "provider capability manifest schema version 2 is not supported."
    );

    expect(() =>
      validateProviderCapabilityManifest({
        adapterApiVersion: 2,
        capabilities: {},
        manifestRevision: "1",
        provider: { displayName: "Example", id: "example" },
        schemaVersion: 1,
      })
    ).toThrow("provider adapter API version 2 is not supported.");
  });

  test("rejects an unsupported capability contract version", () => {
    expect(() =>
      validateProviderCapabilityManifest({
        adapterApiVersion: 1,
        capabilities: {
          "vendor.custom-operation": {
            contractVersion: 99,
            implementation: { status: "available" },
            modelDefault: supportedClaim,
            native: supportedClaim,
          },
        },
        manifestRevision: "1",
        provider: { displayName: "Example", id: "example" },
        schemaVersion: 1,
      })
    ).toThrow(
      "manifest.capabilities.vendor.custom-operation.contractVersion version 99 is not supported."
    );
  });
});

describe("capability config", () => {
  test("migrates legacy qualified selections exactly once", () => {
    const migrated = migrateLegacyCapabilityConfig({
      imageModel: "openai-instance::gpt-image-2",
      transcriptionModel: "gemini-instance::gemini-3-flash-preview",
      visionModel: "openrouter-instance::vision/model",
    });

    expect(
      migrated.bindings[PROVIDER_CAPABILITY_IDS.imageGeneration]?.primary
    ).toEqual({
      modelId: "gpt-image-2",
      providerId: "openai-instance",
    });
    expect(
      migrated.bindings[PROVIDER_CAPABILITY_IDS.audioTranscription]?.primary
    ).toEqual({
      modelId: "gemini-3-flash-preview",
      providerId: "gemini-instance",
    });
    expect(migrateLegacyCapabilityConfig({}, migrated)).toEqual(migrated);
  });

  test("does not invent a target for unqualified legacy values", () => {
    expect(
      migrateLegacyCapabilityConfig({ transcriptionModel: "whisper-1" })
        .bindings
    ).toEqual({});
  });

  test("merges missing legacy bindings into a partially migrated config", () => {
    const existing = validateCapabilityConfig({
      bindings: {
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: {
          contractVersion: 1,
          enabled: true,
          fallbacks: [],
          mode: "manual",
          primary: { modelId: "kept", providerId: "image-provider" },
        },
      },
      schemaVersion: 1,
    });

    const migrated = migrateLegacyCapabilityConfig(
      {
        imageModel: "ignored::replacement",
        transcriptionModel: "audio-provider::whisper-1",
      },
      existing
    );

    expect(
      migrated.bindings[PROVIDER_CAPABILITY_IDS.imageGeneration]?.primary
    ).toEqual({ modelId: "kept", providerId: "image-provider" });
    expect(
      migrated.bindings[PROVIDER_CAPABILITY_IDS.audioTranscription]?.primary
    ).toEqual({ modelId: "whisper-1", providerId: "audio-provider" });
  });

  test("preserves fallbacks when a primary target changes", () => {
    const config = validateCapabilityConfig({
      bindings: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: {
          contractVersion: 1,
          enabled: true,
          fallbacks: [{ modelId: "fallback", providerId: "provider-b" }],
          mode: "manual",
          primary: { modelId: "old", providerId: "provider-a" },
        },
      },
      schemaVersion: 1,
    });

    const updated = setCapabilityPrimaryTarget(
      config,
      PROVIDER_CAPABILITY_IDS.audioTranscription,
      { modelId: "new", providerId: "provider-a" }
    );

    expect(
      updated.bindings[PROVIDER_CAPABILITY_IDS.audioTranscription]?.fallbacks
    ).toEqual([{ modelId: "fallback", providerId: "provider-b" }]);
    expect(
      updated.bindings[PROVIDER_CAPABILITY_IDS.audioTranscription]?.primary
        ?.modelId
    ).toBe("new");
  });

  test("migrates legacy provider-type targets to stable instance ids", () => {
    const legacy = migrateLegacyCapabilityConfig({
      imageModel: "openai::gpt-image-2",
    });

    const migrated = migrateCapabilityTargetProviderIds(
      legacy,
      [
        { id: "openai-secondary", type: "openai" },
        { id: "openai-primary", type: "openai" },
      ],
      "openai-primary"
    );

    expect(
      migrated.bindings[PROVIDER_CAPABILITY_IDS.imageGeneration]?.primary
    ).toEqual({ modelId: "gpt-image-2", providerId: "openai-primary" });
  });

  test("rejects a future config version instead of dropping it", () => {
    expect(() =>
      validateCapabilityConfig({ bindings: {}, schemaVersion: 2 })
    ).toThrow("capability config schema version 2 is not supported.");
  });

  test("rejects an unsupported binding contract version", () => {
    expect(() =>
      validateCapabilityConfig({
        bindings: {
          "vendor.custom-operation": {
            contractVersion: 42,
            enabled: true,
            fallbacks: [],
            mode: "manual",
          },
        },
        schemaVersion: 1,
      })
    ).toThrow(
      "capability config.bindings.vendor.custom-operation.contractVersion version 42 is not supported."
    );
  });

  test("rejects routing modes that do not have runtime semantics", () => {
    expect(() =>
      validateCapabilityConfig({
        bindings: {
          "vendor.custom-operation": {
            contractVersion: 1,
            enabled: true,
            fallbacks: [],
            mode: "automatic",
          },
        },
        schemaVersion: 1,
      })
    ).toThrow(
      "capability config.bindings.vendor.custom-operation.mode is invalid."
    );
  });
});

describe("capability claim precedence", () => {
  test("uses the highest-precedence supplied claim", () => {
    const resolved = resolveCapabilityClaim(
      supportedClaim,
      {
        source: "provider-discovery",
        status: "unsupported",
        verified: true,
      },
      {
        source: "admin-override",
        status: "supported",
        verified: false,
      }
    );

    expect(resolved).toEqual({
      source: "admin-override",
      status: "supported",
      verified: false,
    });
  });

  test("defaults missing evidence to unknown", () => {
    expect(resolveCapabilityClaim()).toEqual({
      source: "static-manifest",
      status: "unknown",
      verified: false,
    });
  });

  test("orders persisted claims by source instead of array position", () => {
    expect(
      resolveCapabilityClaimsBySource(
        {
          source: "admin-override",
          status: "supported",
          verified: false,
        },
        {
          source: "legacy-migration",
          status: "unsupported",
          verified: false,
        },
        {
          source: "provider-discovery",
          status: "unsupported",
          verified: true,
        }
      ).source
    ).toBe("admin-override");
  });

  test("preserves and intersects request constraints under an admin status override", () => {
    expect(
      resolveCapabilityClaimsBySource(
        {
          constraints: {
            acceptedMimeTypes: ["image/jpeg", "image/png"],
            maximum: { bytes: 10, images: 4 },
            minimum: { images: 1 },
            supportedValues: {
              quality: ["low", "medium"],
              "request.local-tools": [false],
            },
          },
          source: "static-manifest",
          status: "supported",
          verified: true,
        },
        {
          constraints: {
            acceptedMimeTypes: ["image/png", "image/webp"],
            maximum: { bytes: 8 },
            minimum: { images: 2 },
            supportedValues: { quality: ["medium", "high"] },
          },
          source: "provider-discovery",
          status: "unknown",
          verified: false,
        },
        {
          source: "admin-override",
          status: "supported",
          verified: true,
        }
      )
    ).toEqual({
      constraints: {
        acceptedMimeTypes: ["image/png"],
        maximum: { bytes: 8, images: 4 },
        minimum: { images: 2 },
        supportedValues: {
          quality: ["medium"],
          "request.local-tools": [false],
        },
      },
      source: "admin-override",
      status: "supported",
      verified: true,
    });
  });
});
