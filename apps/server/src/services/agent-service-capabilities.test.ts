import { describe, expect, test } from "bun:test";
import {
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityManifestV1,
  type UserConfig,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { ProviderAdapterRegistry } from "../providers";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";

setupTestConfigDir("atlas-agent-capabilities-");

const createdAt = "2026-08-27T00:00:00.000Z";

function orgConfig(providerId: string): UserConfig {
  return {
    defaultProviderId: providerId,
    providers: [
      {
        apiKey: "test-key",
        createdAt,
        id: providerId,
        label: "OpenAI",
        type: "openai",
      },
    ],
  };
}

describe("AgentService capability configuration", () => {
  test("persists synthetic non-routable admin evidence without a core capability id", async () => {
    const capabilityId = "vendor.synthetic-chat";
    const routedCapabilityId = "vendor.synthetic-route";
    const registry = new ProviderAdapterRegistry();
    registry.register({
      executors: {
        [capabilityId]: async () => "ok",
        [routedCapabilityId]: async () => "ok",
      },
      manifest: {
        adapterApiVersion: 1,
        capabilities: {
          [capabilityId]: {
            contractVersion: 1,
            implementation: { status: "available" },
            metadata: {
              description: "Synthetic chat evidence.",
              label: "Synthetic chat",
              routable: false,
            },
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
          [routedCapabilityId]: {
            contractVersion: 1,
            implementation: { status: "available" },
            metadata: {
              description: "Synthetic routed operation.",
              label: "Synthetic route",
              routable: true,
            },
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
        manifestRevision: "test",
        provider: { displayName: "Synthetic OpenAI", id: "openai" },
        schemaVersion: 1,
      },
    });
    const db = createInMemoryDatabaseAdapter();
    await db.upsertOrgAiConfig({
      config: orgConfig("openai-evidence"),
      orgId: "org-evidence",
      updatedAt: createdAt,
    });
    const service = new AgentService(null, null, db, undefined, registry);

    const response = await service.updateProvider(
      "org-evidence",
      "openai-evidence",
      {
        capabilityOverrides: { [capabilityId]: "supported" },
      }
    );

    expect(response.provider.capabilityOverrides?.[capabilityId]).toEqual({
      source: "admin-override",
      status: "supported",
      verified: true,
      verifiedAt: expect.any(String),
    });
    expect(
      (await db.getOrgAiConfig("org-evidence"))?.config.providers[0]
        ?.capabilityOverrides?.[capabilityId]
    ).toEqual(response.provider.capabilityOverrides?.[capabilityId]);

    await expect(
      service.updateProvider("org-evidence", "openai-evidence", {
        capabilityOverrides: { [routedCapabilityId]: "supported" },
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  test("discovers and configures a synthetic routable capability from an adapter manifest", async () => {
    const capabilityId = "vendor.custom-operation";
    const registry = new ProviderAdapterRegistry();
    const manifest: ProviderCapabilityManifestV1 = {
      adapterApiVersion: 1,
      capabilities: {
        [capabilityId]: {
          contractVersion: 1,
          implementation: { status: "available" },
          metadata: {
            description: "Run a vendor-defined operation.",
            label: "Vendor operation",
            routable: true,
          },
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
          id: "vendor-model",
          name: "Vendor Model",
        },
      ],
      provider: { displayName: "Synthetic", id: "synthetic" },
      schemaVersion: 1,
    };
    registry.register({
      executors: { [capabilityId]: async () => "ok" },
      manifest,
    });

    const db = createInMemoryDatabaseAdapter();
    await db.upsertOrgAiConfig({
      config: {
        defaultProviderId: "synthetic-instance",
        providers: [
          {
            apiKey: "test-key",
            createdAt,
            id: "synthetic-instance",
            label: "Synthetic",
            type: "synthetic",
          },
        ],
      } as unknown as UserConfig,
      orgId: "org-synthetic",
      updatedAt: createdAt,
    });
    const service = new AgentService(null, null, db, undefined, registry);

    expect(service.getCapabilityCatalog().capabilities).toContainEqual({
      description: "Run a vendor-defined operation.",
      id: capabilityId,
      label: "Vendor operation",
      routable: true,
    });
    expect(await service.getOrgCapabilityOptions("org-synthetic")).toEqual(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({
            capabilityId,
            effective: expect.objectContaining({ selectable: true }),
            modelId: "vendor-model",
            providerId: "synthetic-instance",
          }),
        ]),
      })
    );

    await service.setOrgCapabilityMapping("org-synthetic", capabilityId, {
      binding: {
        contractVersion: 1,
        enabled: true,
        fallbacks: [],
        mode: "manual",
        primary: {
          modelId: "vendor-model",
          providerId: "synthetic-instance",
        },
      },
    });

    expect(
      (await service.getOrgCapabilityMappings("org-synthetic")).config.bindings[
        capabilityId
      ]?.primary
    ).toEqual({
      modelId: "vendor-model",
      providerId: "synthetic-instance",
    });
  });

  test("executes standard routed capabilities through an injected adapter", async () => {
    const providerType = "synthetic-runtime";
    const providerId = "synthetic-runtime-instance";
    const modelId = "synthetic-multimodal-model";
    const supported = {
      source: "static-manifest" as const,
      status: "supported" as const,
      verified: true,
    };
    const registry = new ProviderAdapterRegistry();
    registry.register({
      credentialsRequired: () => false,
      executors: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: async () => ({
          text: "Synthetic transcript",
        }),
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: async () => ({
          data: Uint8Array.from([137, 80, 78, 71]),
          mediaType: "image/png",
          model: modelId,
          size: "1024x1024",
        }),
      },
      manifest: {
        adapterApiVersion: 1,
        capabilities: {
          [PROVIDER_CAPABILITY_IDS.audioTranscription]: {
            contractVersion: 1,
            implementation: { status: "available" },
            modelDefault: supported,
            native: supported,
          },
          [PROVIDER_CAPABILITY_IDS.imageGeneration]: {
            contractVersion: 1,
            implementation: { status: "available" },
            modelDefault: supported,
            native: supported,
          },
        },
        manifestRevision: "synthetic-runtime-test",
        provider: { displayName: "Synthetic runtime", id: providerType },
        schemaVersion: 1,
      },
    });
    const binding = () => ({
      contractVersion: 1 as const,
      enabled: true,
      fallbacks: [],
      mode: "manual" as const,
      primary: { modelId, providerId },
    });
    const config = {
      capabilityConfig: {
        bindings: {
          [PROVIDER_CAPABILITY_IDS.audioTranscription]: binding(),
          [PROVIDER_CAPABILITY_IDS.imageGeneration]: binding(),
        },
        schemaVersion: 1 as const,
      },
      defaultProviderId: providerId,
      providers: [
        {
          apiKey: "",
          createdAt,
          id: providerId,
          label: "Synthetic runtime",
          type: providerType,
        },
      ],
    } as unknown as UserConfig;
    const db = createInMemoryDatabaseAdapter();
    await db.upsertOrgAiConfig({
      config,
      orgId: "org-synthetic-runtime",
      updatedAt: createdAt,
    });
    const service = new AgentService(null, null, db, undefined, registry);

    await expect(
      service.transcribeAudioForOrg("org-synthetic-runtime", {
        data: "AQ==",
        filename: "sample.wav",
        mediaType: "audio/wav",
      })
    ).resolves.toEqual({ text: "Synthetic transcript" });
    await expect(
      service.generateImageForOrg("org-synthetic-runtime", {
        prompt: "A synthetic image",
      })
    ).resolves.toEqual(
      expect.objectContaining({
        mediaType: "image/png",
        model: modelId,
        sizeBytes: 4,
      })
    );
  });

  test("publishes the adapter catalog instead of a provider-specific selector", () => {
    const service = new AgentService(
      null,
      null,
      createInMemoryDatabaseAdapter()
    );

    const catalog = service.getCapabilityCatalog();

    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.providers).toHaveLength(16);
    expect(catalog.capabilities.map((capability) => capability.id)).toContain(
      PROVIDER_CAPABILITY_IDS.audioTranscription
    );
    expect(
      catalog.providers.find((provider) => provider.id === "openai")
        ?.capabilities
    ).toContainEqual({
      capabilityId: PROVIDER_CAPABILITY_IDS.audioTranscription,
      implementationAvailable: true,
      nativeStatus: "supported",
    });
    expect(
      catalog.providers
        .find((provider) => provider.id === "openai")
        ?.models.some((model) => model.id === "whisper-1")
    ).toBe(true);
  });

  test("persists a mapping only in the selected workspace", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertOrgAiConfig({
      config: orgConfig("openai-a"),
      orgId: "org-a",
      updatedAt: createdAt,
    });
    await db.upsertOrgAiConfig({
      config: orgConfig("openai-b"),
      orgId: "org-b",
      updatedAt: createdAt,
    });
    const service = new AgentService(null, null, db);

    await service.setOrgCapabilityMapping(
      "org-a",
      PROVIDER_CAPABILITY_IDS.audioTranscription,
      {
        binding: {
          contractVersion: 1,
          enabled: true,
          fallbacks: [],
          mode: "manual",
          primary: { modelId: "whisper-1", providerId: "openai-a" },
        },
      }
    );

    const orgA = await service.getOrgCapabilityMappings("org-a");
    const orgB = await service.getOrgCapabilityMappings("org-b");
    expect(
      orgA.config.bindings[PROVIDER_CAPABILITY_IDS.audioTranscription]?.primary
    ).toEqual({ modelId: "whisper-1", providerId: "openai-a" });
    expect(
      orgB.config.bindings[PROVIDER_CAPABILITY_IDS.audioTranscription]
    ).toBeUndefined();
    expect((await db.getOrgAiConfig("org-a"))?.config.transcriptionModel).toBe(
      "openai-a::whisper-1"
    );
  });

  test("builds UI target options from the same effective capability resolver", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertOrgAiConfig({
      config: orgConfig("openai-options"),
      orgId: "org-options",
      updatedAt: createdAt,
    });
    const service = new AgentService(null, null, db);

    const response = await service.getOrgCapabilityOptions("org-options");

    expect(response.schemaVersion).toBe(1);
    expect(response.options).toContainEqual(
      expect.objectContaining({
        capabilityId: PROVIDER_CAPABILITY_IDS.audioTranscription,
        effective: expect.objectContaining({
          availability: "ready",
          selectable: true,
          status: "supported",
        }),
        modelId: "whisper-1",
        providerId: "openai-options",
        providerLabel: "OpenAI",
        providerType: "openai",
      })
    );
    expect(response.options).toContainEqual(
      expect.objectContaining({
        capabilityId: PROVIDER_CAPABILITY_IDS.imageGeneration,
        effective: expect.objectContaining({ selectable: true }),
        modelId: "gpt-image-2",
      })
    );
    expect(response.options).toContainEqual(
      expect.objectContaining({
        capabilityId: PROVIDER_CAPABILITY_IDS.imageUnderstanding,
        effective: expect.objectContaining({ selectable: true }),
        modelId: "gpt-5.4",
      })
    );
    expect(
      response.options.some(
        (option) =>
          option.capabilityId === PROVIDER_CAPABILITY_IDS.imageUnderstanding &&
          option.modelId === "whisper-1"
      )
    ).toBe(false);
  });

  test("uses provider-agnostic legacy vision evidence for routing options", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertOrgAiConfig({
      config: {
        defaultProviderId: "fireworks-vision",
        providers: [
          {
            apiKey: "fireworks-key",
            createdAt,
            id: "fireworks-vision",
            label: "Fireworks",
            type: "fireworks",
          },
          {
            apiKey: "cerebras-key",
            createdAt,
            id: "cerebras-vision",
            label: "Cerebras",
            type: "cerebras",
          },
        ],
      },
      orgId: "org-legacy-vision-options",
      updatedAt: createdAt,
    });
    const service = new AgentService(null, null, db);

    const response = await service.getOrgCapabilityOptions(
      "org-legacy-vision-options"
    );
    const imageOptions = response.options.filter(
      (option) =>
        option.capabilityId === PROVIDER_CAPABILITY_IDS.imageUnderstanding
    );

    expect(imageOptions).toContainEqual(
      expect.objectContaining({
        effective: expect.objectContaining({ selectable: true }),
        modelId: "accounts/fireworks/models/kimi-k2p5",
        providerId: "fireworks-vision",
      })
    );
    expect(imageOptions).toContainEqual(
      expect.objectContaining({
        effective: expect.objectContaining({ selectable: true }),
        modelId: "gemma-4-31b",
        providerId: "cerebras-vision",
      })
    );
  });

  test("adds registry-resolved capability claims to configured chat models", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertOrgAiConfig({
      config: orgConfig("openai-models"),
      orgId: "org-models",
      updatedAt: createdAt,
    });
    const service = new AgentService(null, null, db);

    const response = await service.getModels("org-models");
    const model = response.models.find(
      (candidate) => candidate.id === "gpt-5.4"
    );

    expect(
      model?.capabilities?.[PROVIDER_CAPABILITY_IDS.chatInputImage]
    ).toEqual(expect.objectContaining({ status: "supported", verified: true }));
  });

  test("keeps credential-missing models visible but not selectable", async () => {
    const db = createInMemoryDatabaseAdapter();
    const config = orgConfig("openai-no-key");
    config.providers[0]!.apiKey = "";
    await db.upsertOrgAiConfig({
      config,
      orgId: "org-no-key",
      updatedAt: createdAt,
    });
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "";

    try {
      const service = new AgentService(null, null, db);
      const response = await service.getOrgCapabilityOptions("org-no-key");
      const whisper = response.options.find(
        (option) =>
          option.capabilityId === PROVIDER_CAPABILITY_IDS.audioTranscription &&
          option.modelId === "whisper-1"
      );

      expect(whisper?.effective).toEqual(
        expect.objectContaining({
          availability: "credentials-missing",
          reasons: ["credentials-missing"],
          selectable: false,
          status: "supported",
        })
      );
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
    }
  });

  test("retains a stale target only for the capability that owns it", async () => {
    const db = createInMemoryDatabaseAdapter();
    const config = orgConfig("openai-stale");
    config.capabilityConfig = {
      bindings: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: {
          contractVersion: 1,
          enabled: true,
          fallbacks: [],
          mode: "manual",
          primary: {
            modelId: "retired-transcription-model",
            providerId: "openai-stale",
          },
        },
      },
      schemaVersion: 1,
    };
    await db.upsertOrgAiConfig({
      config,
      orgId: "org-stale",
      updatedAt: createdAt,
    });
    const service = new AgentService(null, null, db);

    const response = await service.getOrgCapabilityOptions("org-stale");

    expect(response.options).toContainEqual(
      expect.objectContaining({
        capabilityId: PROVIDER_CAPABILITY_IDS.audioTranscription,
        modelId: "retired-transcription-model",
      })
    );
    expect(
      response.options.some(
        (option) =>
          option.capabilityId === PROVIDER_CAPABILITY_IDS.imageUnderstanding &&
          option.modelId === "retired-transcription-model"
      )
    ).toBe(false);
  });

  test("routes the legacy transcription setting through the generic mapping", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertOrgAiConfig({
      config: orgConfig("openai-legacy"),
      orgId: "org-legacy",
      updatedAt: createdAt,
    });
    const service = new AgentService(null, null, db);

    await service.setOrgTranscriptionSettings("org-legacy", {
      model: "openai-legacy::gpt-4o-mini-transcribe",
    });

    expect(await service.getOrgTranscriptionSettings("org-legacy")).toEqual({
      transcription: {
        model: "openai-legacy::gpt-4o-mini-transcribe",
      },
    });
    const stored = await service.getOrgCapabilityMappings("org-legacy");
    expect(
      stored.config.bindings[PROVIDER_CAPABILITY_IDS.audioTranscription]
        ?.primary
    ).toEqual({
      modelId: "gpt-4o-mini-transcribe",
      providerId: "openai-legacy",
    });
  });
});
