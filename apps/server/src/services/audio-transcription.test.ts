import { describe, expect, test } from "bun:test";
import {
  type CapabilitySupportStatus,
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityManifestV1,
  type ProviderInstance,
  type UserConfig,
} from "@atlas/core";
import { ProviderCapabilityError } from "../providers/capabilities/errors";
import { ProviderAdapterRegistry } from "../providers/capabilities/registry";
import {
  resolveTranscriptionProviderSelection,
  transcribeAudio,
} from "./audio-transcription";

const capabilityId = PROVIDER_CAPABILITY_IDS.audioTranscription;
const createdAt = "2026-01-01T00:00:00.000Z";

function createManifest(options: {
  implementation?: "available" | "unavailable";
  modelStatus?: CapabilitySupportStatus;
  providerId: string;
}): ProviderCapabilityManifestV1 {
  const implementation = options.implementation ?? "available";
  const modelStatus = options.modelStatus ?? "supported";
  return {
    adapterApiVersion: 1,
    capabilities: {
      [capabilityId]: {
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
          [capabilityId]: {
            source: "static-manifest",
            status: modelStatus,
            verified: true,
          },
        },
        id: options.providerId === "openai" ? "whisper-1" : "gemini-test",
      },
    ],
    provider: {
      displayName: options.providerId,
      id: options.providerId,
    },
    schemaVersion: 1,
  };
}

function createRegistry(): ProviderAdapterRegistry {
  const registry = new ProviderAdapterRegistry();
  registry.register({
    executors: {
      [capabilityId]: async () => ({ text: "OpenAI transcript" }),
    },
    manifest: createManifest({ providerId: "openai" }),
  });
  registry.register({
    executors: {
      [capabilityId]: async () => ({ text: "Gemini transcript" }),
    },
    manifest: createManifest({ providerId: "gemini" }),
  });
  registry.register({
    manifest: createManifest({
      implementation: "unavailable",
      providerId: "fireworks",
    }),
  });
  return registry;
}

function provider(
  type: ProviderInstance["type"],
  apiKey = "key"
): ProviderInstance {
  return {
    apiKey,
    createdAt,
    id: `p-${type}`,
    label: type,
    type,
  };
}

describe("resolveTranscriptionProviderSelection", () => {
  test("returns null when transcription is not configured", () => {
    expect(
      resolveTranscriptionProviderSelection(
        { defaultProviderId: null, providers: [] },
        {},
        createRegistry()
      )
    ).toBeNull();
  });

  test("resolves a legacy OpenAI selection through model capability claims", () => {
    const config: UserConfig = {
      defaultProviderId: "p-openai",
      providers: [provider("openai")],
      transcriptionModel: "p-openai::whisper-1",
    };

    const resolved = resolveTranscriptionProviderSelection(
      config,
      {},
      createRegistry()
    );
    expect(resolved?.model).toBe("whisper-1");
    expect(resolved?.instance.id).toBe("p-openai");
  });

  test("uses the configured fallback when the primary has no credentials", () => {
    const config: UserConfig = {
      capabilityConfig: {
        bindings: {
          [capabilityId]: {
            contractVersion: 1,
            enabled: true,
            fallbacks: [{ modelId: "gemini-test", providerId: "p-gemini" }],
            mode: "manual",
            primary: { modelId: "whisper-1", providerId: "p-openai" },
          },
        },
        schemaVersion: 1,
      },
      defaultProviderId: "p-openai",
      providers: [provider("openai", ""), provider("gemini")],
    };

    const resolved = resolveTranscriptionProviderSelection(
      config,
      {},
      createRegistry()
    );
    expect(resolved?.instance.id).toBe("p-gemini");
    expect(resolved?.model).toBe("gemini-test");
  });

  test("reports unknown models instead of optimistically executing them", () => {
    const config: UserConfig = {
      defaultProviderId: "p-openai",
      providers: [provider("openai")],
      transcriptionModel: "p-openai::unknown-model",
    };

    try {
      resolveTranscriptionProviderSelection(config, {}, createRegistry());
      throw new Error("expected capability resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCapabilityError);
      expect((error as ProviderCapabilityError).code).toBe(
        "CAPABILITY_UNKNOWN"
      );
      expect((error as ProviderCapabilityError).attempts[0]?.reasons).toEqual([
        "model-unknown",
      ]);
    }
  });

  test("reports a provider with native support but no Atlas handler", () => {
    const fireworks = provider("fireworks");
    fireworks.customModels = [
      {
        capabilities: {
          [capabilityId]: {
            source: "admin-override",
            status: "supported",
            verified: false,
          },
        },
        id: "fireworks-asr",
      },
    ];
    const config: UserConfig = {
      defaultProviderId: fireworks.id,
      providers: [fireworks],
      transcriptionModel: `${fireworks.id}::fireworks-asr`,
    };

    try {
      resolveTranscriptionProviderSelection(config, {}, createRegistry());
      throw new Error("expected capability resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCapabilityError);
      expect((error as ProviderCapabilityError).code).toBe(
        "CAPABILITY_UNSUPPORTED"
      );
      expect((error as ProviderCapabilityError).attempts[0]?.reasons).toEqual([
        "handler-missing",
      ]);
    }
  });

  test("rejects malformed legacy selections", () => {
    expect(() =>
      resolveTranscriptionProviderSelection(
        {
          defaultProviderId: "p-openai",
          providers: [provider("openai")],
          transcriptionModel: "whisper-1",
        },
        {},
        createRegistry()
      )
    ).toThrow("Configured audio transcription model is invalid");
  });
});

describe("transcribeAudio", () => {
  test("executes the selected adapter without provider selection branches", async () => {
    await expect(
      transcribeAudio(
        provider("gemini"),
        "gemini-test",
        {
          bytes: new Uint8Array([1, 2, 3]),
          filename: "voice.ogg",
          mediaType: "audio/ogg",
        },
        {},
        createRegistry()
      )
    ).resolves.toBe("Gemini transcript");
  });
});
